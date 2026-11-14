// Project storage: UUID directories under the store root.
//
// v0.3.0 layout:
//   {store}/{uuid}/meta.json                  project metadata (atomic writes)
//   {store}/{uuid}/versions/{n}/...           version contents
//
// v0.2.0 compatibility: legacy projects keep their only version directly in
// the project directory ({store}/{uuid}/index.html + meta.json, meta without
// a "versions" array). Those are served in place (storage: "legacy-root"),
// never moved or deleted; the first update on such a project records the
// legacy files as version 1 and publishes new versions under versions/.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ApiError } from "./httputil.mjs";

const UUID_RE = /^[0-9a-f-]{36}$/;

function now() {
  return new Date().toISOString();
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export function createStore(config) {
  const root = path.resolve(config.store);
  const tmpDir = path.join(root, ".tmp");

  const metaFile = (id) => path.join(root, id, "meta.json");
  const projectDir = (id) => path.join(root, id);
  const versionsDir = (id) => path.join(root, id, "versions");
  const versionDir = (id, n) => path.join(versionsDir(id), String(n));

  // In-process write lock; one Node process per deployment, so a promise
  // chain per project serializes all meta/version mutations.
  const locks = new Map();

  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const task = prev.catch(() => {}).then(fn);
    locks.set(key, task.catch(() => {}));
    return task;
  }

  async function init() {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });

    // Sweep staging leftovers from crashed uploads.
    for (const entry of await fs.readdir(tmpDir, { withFileTypes: true })) {
      await fs.rm(path.join(tmpDir, entry.name), {
        recursive: true,
        force: true
      });
    }
  }

  function stagingDir(prefix) {
    return path.join(
      tmpDir,
      `${prefix}-${crypto.randomBytes(8).toString("hex")}`
    );
  }

  async function readRawMeta(id) {
    try {
      return JSON.parse(await fs.readFile(metaFile(id), "utf8"));
    } catch {
      return null;
    }
  }

  async function writeMetaAtomic(id, meta) {
    const file = metaFile(id);
    const tmp = path.join(
      root,
      id,
      `.meta-${crypto.randomBytes(6).toString("hex")}.tmp`
    );

    await fs.writeFile(tmp, JSON.stringify(meta), {
      flag: "wx",
      mode: 0o600
    });

    await fs.rename(tmp, file);
  }

  function isLegacy(meta) {
    return !Array.isArray(meta.versions);
  }

  // Resolves the entry (version record) of the currently served version.
  // Legacy projects get a synthesized v1 entry backed by the project root.
  async function currentVersionEntry(id, meta) {
    if (isLegacy(meta)) {
      let totalSize = 0;

      try {
        totalSize = (
          await fs.stat(path.join(projectDir(id), "index.html"))
        ).size;
      } catch {}

      return {
        version: 1,
        createdAt: meta.createdAt,
        fileCount: 1,
        totalSize,
        entryPoint: "index.html",
        storage: "legacy-root"
      };
    }

    const current =
      meta.versions.find((v) => v.version === meta.currentVersion) ||
      meta.versions[meta.versions.length - 1];

    if (!current) {
      throw new ApiError(500, "Internal error", "BROKEN_META");
    }

    return current;
  }

  // Directory that backs a given version entry.
  function versionSourceDir(id, entry) {
    return entry.storage === "legacy-root"
      ? projectDir(id)
      : versionDir(id, entry.version);
  }

  function listView(id, meta, entry) {
    const view = {
      id,
      name: meta.name,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt ?? meta.createdAt,
      currentVersion: entry.version,
      fileCount: entry.fileCount,
      totalSize: entry.totalSize
    };

    if (meta.description !== undefined) {
      view.description = meta.description;
    }

    return view;
  }

  async function listProjects() {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) {
        continue;
      }

      const meta = await readRawMeta(entry.name);

      if (!meta) {
        continue;
      }

      const current = await currentVersionEntry(entry.name, meta);
      projects.push(listView(entry.name, meta, current));
    }

    projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return projects;
  }

  async function getProject(id) {
    if (!UUID_RE.test(id)) {
      throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    }

    const meta = await readRawMeta(id);

    if (!meta) {
      throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    }

    const current = await currentVersionEntry(id, meta);

    return {
      ...listView(id, meta, current),
      entryPoint: current.entryPoint,
      previewPath: `/p/${id}/`,
      versionCount: isLegacy(meta) ? 1 : meta.versions.length
    };
  }

  // Publishes a fully validated staging directory as a new project.
  async function createProject({ name, description, stagedDir, stats }) {
    let id = null;

    for (let attempt = 0; attempt < 5 && !id; attempt++) {
      const candidate = crypto.randomUUID();

      if (!(await pathExists(projectDir(candidate)))) {
        id = candidate;
      }
    }

    if (!id) {
      throw new ApiError(500, "Internal error", "ID_COLLISION");
    }

    const dir = projectDir(id);
    await fs.rename(stagedDir, dir); // atomic publish within the same volume

    const createdAt = now();
    const meta = {
      id,
      name,
      createdAt,
      updatedAt: createdAt,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          createdAt,
          fileCount: stats.fileCount,
          totalSize: stats.totalSize,
          entryPoint: stats.entryPoint,
          storage: "versions"
        }
      ]
    };

    if (description !== undefined) {
      meta.description = description;
    }

    try {
      await writeMetaAtomic(id, meta);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }

    return getProject(id);
  }

  return {
    root,
    tmpDir,
    init,
    withLock,
    stagingDir,
    readRawMeta,
    currentVersionEntry,
    versionSourceDir,
    projectDir,
    versionsDir,
    versionDir,
    listProjects,
    getProject,
    createProject
  };
}
