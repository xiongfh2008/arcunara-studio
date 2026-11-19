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
const SHARE_ID_RE = /^[0-9a-f]{16}$/;

// RC5 share tokens: {shareId}.{secret} — the secret is 32 random bytes
// (base64url, 43 chars); only its SHA-256 hash is persisted in meta.json.
const SHARE_SECRET_BYTES = 32;

// RC6 deploy keys: dpk_{keyId}.{secret} — same crypto shape as share tokens,
// scoped to one project and restricted to version upload + status queries.
const DEPLOY_KEY_ID_RE = /^[0-9a-f]{16}$/;

// RC6 content hash for upload idempotency (sha256 hex over the manifest).
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

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

  // Share index: shareId -> projectId. The validation path re-reads the
  // fresh meta from disk every time — the index only locates the project,
  // so a stale entry can never authorize access on its own. Rebuilt by a
  // full meta scan when an unknown shareId is requested.
  const shareIndex = new Map();
  const projectShareIds = new Map();
  let shareIndexFullyBuilt = false;

  function indexProjectShares(id, meta) {
    for (const old of projectShareIds.get(id) ?? []) {
      if (shareIndex.get(old) === id) shareIndex.delete(old);
    }
    const ids = new Set();
    if (Array.isArray(meta.shares)) {
      for (const s of meta.shares) {
        if (s && typeof s.id === "string" && SHARE_ID_RE.test(s.id)) {
          shareIndex.set(s.id, id);
          ids.add(s.id);
        }
      }
    }
    if (ids.size > 0 || Array.isArray(meta.shares)) {
      projectShareIds.set(id, ids);
    }
  }

  async function rebuildShareIndex() {
    shareIndex.clear();
    projectShareIds.clear();
    const entries = await fs.readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const meta = await readRawMeta(entry.name);
      if (meta) indexProjectShares(entry.name, meta);
    }

    shareIndexFullyBuilt = true;
  }

  // Locates the project owning a share id (null when unknown). Unknown ids
  // trigger one full scan; a miss afterwards is authoritative.
  async function locateShareProject(shareId) {
    if (!SHARE_ID_RE.test(shareId)) return null;

    if (!shareIndex.has(shareId) && !shareIndexFullyBuilt) {
      await rebuildShareIndex();
    }

    return shareIndex.get(shareId) ?? null;
  }

  // RC6 deploy-key index: keyId -> projectId, same stale-safe design as the
  // share index (validation always re-reads fresh meta from disk).
  const deployKeyIndex = new Map();
  const projectDeployKeyIds = new Map();
  let deployKeyIndexFullyBuilt = false;

  function indexProjectDeployKeys(id, meta) {
    for (const old of projectDeployKeyIds.get(id) ?? []) {
      if (deployKeyIndex.get(old) === id) deployKeyIndex.delete(old);
    }
    const ids = new Set();
    if (Array.isArray(meta.deployKeys)) {
      for (const k of meta.deployKeys) {
        if (k && typeof k.id === "string" && DEPLOY_KEY_ID_RE.test(k.id)) {
          deployKeyIndex.set(k.id, id);
          ids.add(k.id);
        }
      }
    }
    if (ids.size > 0 || Array.isArray(meta.deployKeys)) {
      projectDeployKeyIds.set(id, ids);
    }
  }

  async function rebuildDeployKeyIndex() {
    deployKeyIndex.clear();
    projectDeployKeyIds.clear();
    const entries = await fs.readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const meta = await readRawMeta(entry.name);
      if (meta) indexProjectDeployKeys(entry.name, meta);
    }

    deployKeyIndexFullyBuilt = true;
  }

  // Locates the project owning a deploy key id (null when unknown).
  async function locateDeployKeyProject(keyId) {
    if (!DEPLOY_KEY_ID_RE.test(keyId)) return null;

    if (!deployKeyIndex.has(keyId) && !deployKeyIndexFullyBuilt) {
      await rebuildDeployKeyIndex();
    }

    return deployKeyIndex.get(keyId) ?? null;
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
    indexProjectShares(id, meta); // keep the share index in sync
    indexProjectDeployKeys(id, meta); // keep the deploy-key index in sync
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
      totalSize: entry.totalSize,
      // RC5: absent flag means enabled (v0.2.0/v0.3.0-RC4 compatibility —
      // existing projects never lose their open preview behavior).
      previewEnabled: meta.previewEnabled !== false && meta.lifecycleState !== "trashed",
      lifecycleState: meta.lifecycleState || "active",
      archivedAt: meta.archivedAt ?? null,
      trashedAt: meta.trashedAt ?? null
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

    // Publish atomically: staged content becomes versions/1, meta follows.
    await fs.mkdir(versionsDir(id), { recursive: true, mode: 0o700 });

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
      await fs.rename(stagedDir, versionDir(id, 1)); // same-volume atomic move
      await writeMetaAtomic(id, meta);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }

    return getProject(id);
  }

  // Publishes a fully validated staging directory as the next version.
  // Legacy v0.2.0 projects are transparently recorded: their root files
  // become version 1 (storage: "legacy-root"), untouched on disk.
  //
  // RC6 idempotency: when a content hash is supplied and matches the hash of
  // the CURRENT version, the upload is a no-op — no new version directory is
  // created. The check runs under the project lock, so concurrent/retried
  // uploads of identical content collapse into one version safely. Re-adding
  // content that matches a NON-current historical version still creates a
  // new version (rolling back + re-deploying must move currentVersion).
  async function addVersion(id, { stagedDir, stats, contentHash }) {
    return withLock(id, async () => {
      const meta = await readRawMeta(id);
      if (meta?.lifecycleState === "trashed") {
        throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
      }

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      if (contentHash !== undefined && !CONTENT_HASH_RE.test(contentHash)) {
        throw new ApiError(
          400,
          "Invalid content hash format",
          "INVALID_CONTENT_HASH"
        );
      }

      if (
        contentHash &&
        !isLegacy(meta) &&
        meta.versions.length > 0
      ) {
        const current =
          meta.versions.find((v) => v.version === meta.currentVersion) ||
          meta.versions[meta.versions.length - 1];

        if (current.contentHash === contentHash) {
          // Identical content already live: discard the staged copy.
          await fs.rm(stagedDir, { recursive: true, force: true }).catch(
            () => {}
          );

          return {
            projectId: id,
            version: current.version,
            createdAt: current.createdAt,
            fileCount: current.fileCount,
            totalSize: current.totalSize,
            entryPoint: current.entryPoint,
            previewPath: `/p/${id}/`,
            currentVersion: current.version,
            deduplicated: true
          };
        }
      }

      const versions = isLegacy(meta)
        ? [await currentVersionEntry(id, meta)]
        : [...meta.versions];

      const next = versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
      const createdAt = now();

      await fs.mkdir(versionsDir(id), { recursive: true, mode: 0o700 });
      await fs.rename(stagedDir, versionDir(id, next));

      const entry = {
        version: next,
        createdAt,
        fileCount: stats.fileCount,
        totalSize: stats.totalSize,
        entryPoint: stats.entryPoint,
        storage: "versions"
      };

      if (contentHash) {
        entry.contentHash = contentHash;
      }

      versions.push(entry);

      meta.versions = versions;
      meta.currentVersion = next;
      meta.updatedAt = createdAt;

      try {
        await writeMetaAtomic(id, meta);
      } catch (err) {
        // Orphaned version directory: not referenced by meta, never listed.
        await fs.rm(versionDir(id, next), { recursive: true, force: true });
        throw err;
      }

      return {
        projectId: id,
        version: next,
        createdAt,
        fileCount: stats.fileCount,
        totalSize: stats.totalSize,
        entryPoint: stats.entryPoint,
        previewPath: `/p/${id}/`,
        currentVersion: next
      };
    });
  }

  async function listVersions(id) {
    const meta = await readRawMeta(id);

    if (!meta) {
      throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    }

    const versions = isLegacy(meta)
      ? [await currentVersionEntry(id, meta)]
      : meta.versions;

    return {
      projectId: id,
      versions: [...versions]
        .sort((a, b) => a.version - b.version)
        .map((v) => ({
          version: v.version,
          createdAt: v.createdAt,
          fileCount: v.fileCount,
          totalSize: v.totalSize,
          entryPoint: v.entryPoint,
          isCurrent: v.version === (meta.currentVersion ?? versions[versions.length - 1].version)
        }))
    };
  }

  async function rollback(id, targetVersion) {
    return withLock(id, async () => {
      const meta = await readRawMeta(id);

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      const versions = isLegacy(meta)
        ? [await currentVersionEntry(id, meta)]
        : meta.versions;

      const target = versions.find((v) => v.version === targetVersion);

      if (!target) {
        throw new ApiError(
          400,
          `Version ${targetVersion} does not exist`,
          "VERSION_NOT_FOUND"
        );
      }

      const currentVersion =
        meta.currentVersion ?? versions[versions.length - 1].version;

      if (target.version === currentVersion) {
        return {
          projectId: id,
          ok: true,
          rolledBack: false,
          currentVersion,
          previewPath: `/p/${id}/`
        };
      }

      meta.currentVersion = target.version;
      meta.updatedAt = now();

      await writeMetaAtomic(id, meta);

      return {
        projectId: id,
        ok: true,
        rolledBack: true,
        currentVersion: target.version,
        previewPath: `/p/${id}/`
      };
    });
  }

  // RC5: edits project metadata (name/description/previewEnabled). The
  // project id, versions, shares and all other meta fields are preserved —
  // this never recreates the project directory.
  async function updateProject(id, patch) {
    return withLock(id, async () => {
      const meta = await readRawMeta(id);

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      if (patch.name !== undefined) {
        if (typeof patch.name !== "string" || !patch.name.trim()) {
          throw new ApiError(400, "Name is required", "NAME_REQUIRED");
        }

        if (patch.name.trim().length > 100) {
          throw new ApiError(
            400,
            "Name is too long (max 100 characters)",
            "NAME_TOO_LONG"
          );
        }

        meta.name = patch.name.trim();
      }

      if (patch.description !== undefined) {
        if (typeof patch.description !== "string") {
          throw new ApiError(400, "Invalid description", "INVALID_DESCRIPTION");
        }

        const value = patch.description.trim().slice(0, 1000);
        if (value.length > 0) {
          meta.description = value;
        } else {
          delete meta.description; // explicit clear
        }
      }

      // Archive and trash are metadata-only; never delete user files or
      // invalidate the version tree. Restoring a project preserves history.
      if (patch.lifecycleState !== undefined) {
        if (!["active", "archived", "trashed"].includes(patch.lifecycleState)) {
          throw new ApiError(400, "Invalid lifecycle state", "INVALID_LIFECYCLE_STATE");
        }
        meta.lifecycleState = patch.lifecycleState;
        meta.archivedAt = patch.lifecycleState === "archived" ? now() : null;
        meta.trashedAt = patch.lifecycleState === "trashed" ? now() : null;
      }

      if (patch.previewEnabled !== undefined) {
        if (typeof patch.previewEnabled !== "boolean") {
          throw new ApiError(
            400,
            "previewEnabled must be a boolean",
            "INVALID_PREVIEW_ENABLED"
          );
        }

        meta.previewEnabled = patch.previewEnabled;
      }

      meta.updatedAt = now();
      await writeMetaAtomic(id, meta);

      return getProject(id);
    });
  }

  // A trashed project is not writable by CLI or shareable, and may be
  // restored without losing versions or previously configured shares.
  function requireNotTrashed(meta) {
    if (meta.lifecycleState === "trashed") {
      throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
    }
  }

  // ---- RC5 share management ---------------------------------------------

  function shareView(s) {
    // Status precedence: revoked > disabled > expired > active.
    let status = "active";

    if (s.revokedAt) {
      status = "revoked";
    } else if (s.enabled === false) {
      status = "disabled";
    } else if (s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) {
      status = "expired";
    }

    const view = {
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt ?? null,
      status,
      enabled: s.enabled !== false,
      revoked: Boolean(s.revokedAt),
      accessCount: s.accessCount ?? 0,
      lastAccessAt: s.lastAccessAt ?? null,
      lastAccessStatus: s.lastAccessStatus ?? null
    };

    if (s.revokedAt) view.revokedAt = s.revokedAt;

    return view;
  }

  async function createShare(id, { expiresAt = null } = {}) {
    return withLock(id, async () => {
      const meta = await readRawMeta(id);
      if (meta?.lifecycleState === "trashed") {
        throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
      }

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      let expires = null;

      if (expiresAt !== null && expiresAt !== undefined) {
        if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
          throw new ApiError(400, "Invalid expiresAt", "INVALID_EXPIRES_AT");
        }

        expires = new Date(Date.parse(expiresAt)).toISOString();

        if (Date.parse(expires) <= Date.now()) {
          throw new ApiError(
            400,
            "expiresAt must be in the future",
            "INVALID_EXPIRES_AT"
          );
        }
      }

      const shareId = crypto.randomBytes(8).toString("hex");
      const secret = crypto
        .randomBytes(SHARE_SECRET_BYTES)
        .toString("base64url");
      const createdAt = now();

      const share = {
        id: shareId,
        tokenHash: hashSecret(secret), // plaintext secret never stored
        createdAt,
        expiresAt: expires,
        enabled: true,
        accessCount: 0,
        lastAccessAt: null,
        lastAccessStatus: null
      };

      if (!Array.isArray(meta.shares)) meta.shares = [];
      meta.shares.push(share);

      try {
        await writeMetaAtomic(id, meta);
      } catch (err) {
        meta.shares.pop();
        throw err;
      }

      return {
        ...shareView(share),
        projectId: id,
        // Returned exactly once; only the hash is persisted.
        token: `${shareId}.${secret}`
      };
    });
  }

  async function listShares(id) {
    const meta = await readRawMeta(id);

    if (!meta) {
      throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    }

    return {
      projectId: id,
      shares: (Array.isArray(meta.shares) ? meta.shares : [])
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(shareView)
    };
  }

  // Mutates one share record under the project lock; fn receives the fresh
  // share object from meta and may mutate it in place.
  async function mutateShare(id, shareId, fn) {
    return withLock(id, async () => {
      const meta = await readRawMeta(id);

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      const share = (Array.isArray(meta.shares) ? meta.shares : []).find(
        (s) => s.id === shareId
      );

      if (!share) {
        throw new ApiError(404, "Share Not Found", "SHARE_NOT_FOUND");
      }

      fn(share);
      await writeMetaAtomic(id, meta);

      return { projectId: id, ...shareView(share) };
    });
  }

  async function revokeShare(id, shareId) {
    return mutateShare(id, shareId, (s) => {
      s.revokedAt = now();
    });
  }

  async function setShareEnabled(id, shareId, enabled) {
    return mutateShare(id, shareId, (s) => {
      if (s.revokedAt) {
        throw new ApiError(
          400,
          "Revoked shares cannot be re-enabled",
          "SHARE_REVOKED"
        );
      }

      s.enabled = Boolean(enabled);
    });
  }

  // Validates a share for preview access. Returns
  // {projectId, share, reason:null} on success, {projectId, share, reason}
  // on a located-but-denied share, or null when the share id is unknown.
  async function validateShare(shareId, secret) {
    const projectId = await locateShareProject(shareId);

    if (!projectId) {
      return null;
    }

    const meta = await readRawMeta(projectId); // fresh read, never cached
    const share = (Array.isArray(meta?.shares) ? meta.shares : []).find(
      (s) => s.id === shareId
    );

    if (!share || meta?.lifecycleState === "trashed") {
      return null;
    }

    if (share.revokedAt) {
      return { projectId, share, reason: "revoked" };
    }

    if (share.enabled === false) {
      return { projectId, share, reason: "disabled" };
    }

    if (share.expiresAt && Date.parse(share.expiresAt) <= Date.now()) {
      return { projectId, share, reason: "expired" };
    }

    const expected = Buffer.from(share.tokenHash ?? "", "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");

    if (
      expected.length !== 32 ||
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return { projectId, share, reason: "bad_token" };
    }

    return { projectId, share, reason: null };
  }

  // Lightweight access bookkeeping: root-document requests only. Runs under
  // the project lock so it can never clobber a concurrent version publish.
  async function recordShareAccess(shareId, status) {
    const projectId = await locateShareProject(shareId);

    if (!projectId) {
      return;
    }

    await withLock(projectId, async () => {
      const meta = await readRawMeta(projectId);

      if (!meta) return;

      const share = (Array.isArray(meta.shares) ? meta.shares : []).find(
        (s) => s.id === shareId
      );

      if (!share) return;

      if (status === "ok") {
        share.accessCount = (share.accessCount ?? 0) + 1;
      }

      share.lastAccessAt = now();
      share.lastAccessStatus = status;
      await writeMetaAtomic(projectId, meta);
    });
  }

  // ---- RC6 deploy keys ---------------------------------------------------

  function deployKeyView(k) {
    // Status precedence: revoked > disabled > expired > active.
    let status = "active";

    if (k.revokedAt) {
      status = "revoked";
    } else if (k.enabled === false) {
      status = "disabled";
    } else if (k.expiresAt && Date.parse(k.expiresAt) <= Date.now()) {
      status = "expired";
    }

    const view = {
      id: k.id,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt ?? null,
      status,
      enabled: k.enabled !== false,
      revoked: Boolean(k.revokedAt),
      lastUsedAt: k.lastUsedAt ?? null,
      lastDeployVersion: k.lastDeployVersion ?? null,
      lastDeployResult: k.lastDeployResult ?? null,
      lastDeployAt: k.lastDeployAt ?? null
    };

    if (k.revokedAt) view.revokedAt = k.revokedAt;

    return view;
  }

  async function createDeployKey(id, { expiresAt = null } = {}) {
    return withLock(id, async () => {
      const meta = await readRawMeta(id);
      if (meta?.lifecycleState === "trashed") {
        throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
      }

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      let expires = null;

      if (expiresAt !== null && expiresAt !== undefined) {
        if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
          throw new ApiError(400, "Invalid expiresAt", "INVALID_EXPIRES_AT");
        }

        expires = new Date(Date.parse(expiresAt)).toISOString();

        if (Date.parse(expires) <= Date.now()) {
          throw new ApiError(
            400,
            "expiresAt must be in the future",
            "INVALID_EXPIRES_AT"
          );
        }
      }

      const keyId = crypto.randomBytes(8).toString("hex");
      const secret = crypto
        .randomBytes(SHARE_SECRET_BYTES)
        .toString("base64url");
      const createdAt = now();

      const key = {
        id: keyId,
        tokenHash: hashSecret(secret), // plaintext secret never stored
        createdAt,
        expiresAt: expires,
        enabled: true,
        lastUsedAt: null,
        lastDeployVersion: null,
        lastDeployResult: null,
        lastDeployAt: null
      };

      if (!Array.isArray(meta.deployKeys)) meta.deployKeys = [];
      meta.deployKeys.push(key);

      try {
        await writeMetaAtomic(id, meta);
      } catch (err) {
        meta.deployKeys.pop();
        throw err;
      }

      return {
        ...deployKeyView(key),
        projectId: id,
        // Returned exactly once; only the hash is persisted. The dpk_ prefix
        // routes it to the deploy-key path in auth, never the admin token.
        token: `dpk_${keyId}.${secret}`
      };
    });
  }

  async function listDeployKeys(id) {
    const meta = await readRawMeta(id);

    if (!meta) {
      throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    }

    return {
      projectId: id,
      deployKeys: (Array.isArray(meta.deployKeys) ? meta.deployKeys : [])
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(deployKeyView)
    };
  }

  // Mutates one deploy key record under the project lock; fn receives the
  // fresh key object from meta and may mutate it in place.
  async function mutateDeployKey(id, keyId, fn) {
    if (!DEPLOY_KEY_ID_RE.test(keyId)) {
      throw new ApiError(404, "Deploy Key Not Found", "DEPLOY_KEY_NOT_FOUND");
    }

    return withLock(id, async () => {
      const meta = await readRawMeta(id);

      if (!meta) {
        throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
      }

      const key = (Array.isArray(meta.deployKeys) ? meta.deployKeys : []).find(
        (k) => k.id === keyId
      );

      if (!key) {
        throw new ApiError(404, "Deploy Key Not Found", "DEPLOY_KEY_NOT_FOUND");
      }

      fn(key);
      await writeMetaAtomic(id, meta);

      return { projectId: id, ...deployKeyView(key) };
    });
  }

  async function revokeDeployKey(id, keyId) {
    return mutateDeployKey(id, keyId, (k) => {
      k.revokedAt = now();
    });
  }

  async function setDeployKeyEnabled(id, keyId, enabled) {
    return mutateDeployKey(id, keyId, (k) => {
      if (k.revokedAt) {
        throw new ApiError(
          400,
          "Revoked deploy keys cannot be re-enabled",
          "DEPLOY_KEY_REVOKED"
        );
      }

      k.enabled = Boolean(enabled);
    });
  }

  // Validates a deploy key for API access. Returns
  // {projectId, key, reason:null} on success, {projectId, key, reason} on a
  // located-but-denied key, or null when the key id is unknown.
  async function validateDeployKey(keyId, secret) {
    const projectId = await locateDeployKeyProject(keyId);

    if (!projectId) {
      return null;
    }

    const meta = await readRawMeta(projectId); // fresh read, never cached
    const key = (Array.isArray(meta?.deployKeys) ? meta.deployKeys : []).find(
      (k) => k.id === keyId
    );

    if (!key || meta?.lifecycleState === "trashed") {
      return null;
    }

    const expected = Buffer.from(key.tokenHash ?? "", "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");

    if (
      expected.length !== 32 ||
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return { projectId, key, reason: "bad_token" };
    }

    if (key.revokedAt) {
      return { projectId, key, reason: "revoked" };
    }

    if (key.enabled === false) {
      return { projectId, key, reason: "disabled" };
    }

    if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
      return { projectId, key, reason: "expired" };
    }

    return { projectId, key, reason: null };
  }

  // Records deploy-key usage (success or failure) for the workbench display.
  // Runs under the project lock so it can never clobber a version publish.
  async function recordDeployUse(projectId, keyId, { version, result }) {
    if (!DEPLOY_KEY_ID_RE.test(keyId)) {
      return;
    }

    await withLock(projectId, async () => {
      const meta = await readRawMeta(projectId);

      if (!meta) return;

      const key = (Array.isArray(meta.deployKeys) ? meta.deployKeys : []).find(
        (k) => k.id === keyId
      );

      if (!key) return;

      key.lastUsedAt = now();
      key.lastDeployAt = key.lastUsedAt;
      key.lastDeployResult = result === "ok" ? "ok" : "failed";

      if (result === "ok" && Number.isInteger(version)) {
        key.lastDeployVersion = version;
      }

      await writeMetaAtomic(projectId, meta);
    });
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
    createProject,
    addVersion,
    listVersions,
    rollback,
    updateProject,
    createShare,
    listShares,
    revokeShare,
    setShareEnabled,
    validateShare,
    recordShareAccess,
    locateShareProject,
    createDeployKey,
    listDeployKeys,
    revokeDeployKey,
    setDeployKeyEnabled,
    validateDeployKey,
    recordDeployUse,
    locateDeployKeyProject
  };
}
