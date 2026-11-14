// API router.
//
// v0.2.0 routes (/health, project list, JSON project creation, auth gate)
// keep their validated behavior; new endpoints are additive. Every failure
// path returns a JSON error with a stable "code" field (see
// docs/development.md).

import fs from "node:fs/promises";
import path from "node:path";
import { ApiError, sendError, sendJson, readBody } from "./httputil.mjs";
import { parseMultipartUpload } from "./multipart.mjs";
import { stageFromUpload } from "./staging.mjs";

export function createApiHandler({ config, store, auth, version }) {
  return async function handle(req, res) {
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;

      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "arcunara-studio-dev",
          version
        });
      }

      if (!pathname.startsWith("/api/") || !auth(req)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await store.listProjects();
        return sendJson(res, 200, { projects });
      }

      if (req.method === "POST" && pathname === "/api/projects") {
        return await handleCreateProject(req, res, { config, store });
      }

      const detailMatch = /^\/api\/projects\/([0-9a-f-]{36})$/.exec(pathname);

      if (req.method === "GET" && detailMatch) {
        const view = await store.getProject(detailMatch[1]);
        return sendJson(res, 200, view);
      }

      return sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      sendError(res, err);
    }
  };
}

function cleanDescription(raw, limits) {
  if (typeof raw !== "string") {
    return undefined;
  }

  const value = raw.trim().slice(0, limits.maxDescriptionChars);
  return value.length > 0 ? value : undefined;
}

async function handleCreateProject(req, res, { config, store }) {
  const contentType = req.headers["content-type"] || "";

  if (contentType.startsWith("multipart/form-data")) {
    return await handleMultipartCreate(req, res, { config, store });
  }

  if (!contentType.startsWith("application/json")) {
    return sendJson(res, 415, {
      error: "Use application/json or multipart/form-data",
      code: "UNSUPPORTED_MEDIA_TYPE"
    });
  }

  let payload;

  try {
    payload = JSON.parse(
      await readBody(req, config.limits.maxJsonBodyBytes)
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return sendError(res, err); // 413 passthrough with legacy message
    }
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const name =
    typeof payload.name === "string" ? payload.name.trim() : "";

  const html = typeof payload.html === "string" ? payload.html : "";

  if (
    !name ||
    name.length > 100 ||
    !html.toLowerCase().includes("<html") ||
    Buffer.byteLength(html) > 180000
  ) {
    return sendJson(res, 400, { error: "Invalid name or HTML" });
  }

  const description = cleanDescription(payload.description, config.limits);
  const stagedDir = store.stagingDir("new");

  try {
    await fs.mkdir(stagedDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stagedDir, "index.html"), html, {
      flag: "wx",
      mode: 0o600
    });

    const view = await store.createProject({
      name,
      description,
      stagedDir,
      stats: {
        fileCount: 1,
        totalSize: Buffer.byteLength(html),
        entryPoint: "index.html"
      }
    });

    return sendJson(res, 201, view);
  } catch (err) {
    await fs.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// v0.3.0: multipart upload of a single .html/.htm/.zip file.
async function handleMultipartCreate(req, res, { config, store }) {
  const { fields, file } = await parseMultipartUpload(req, {
    tmpDir: store.tmpDir,
    limits: config.limits
  });

  try {
    const name = typeof fields.name === "string" ? fields.name.trim() : "";

    if (!name) {
      throw new ApiError(400, "Name is required", "NAME_REQUIRED");
    }

    if (name.length > 100) {
      throw new ApiError(
        400,
        "Name is too long (max 100 characters)",
        "NAME_TOO_LONG"
      );
    }

    const description = cleanDescription(fields.description, config.limits);
    const staged = await stageFromUpload(file, { store, limits: config.limits });

    try {
      const view = await store.createProject({
        name,
        description,
        stagedDir: staged.stagedDir,
        stats: staged.stats
      });

      return sendJson(res, 201, view);
    } catch (err) {
      await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    // The parsed upload temp file belongs to this handler until staging
    // moves it; make sure route-level failures never leak it.
    await fs.rm(file.tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
