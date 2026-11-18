// API router.
//
// v0.2.0 routes (/health, project list, JSON project creation, auth gate)
// keep their validated behavior; everything else is additive v0.3.0.
// Every failure path returns a JSON error with a stable "code" field
// (see docs/development.md).

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiError, sendError, sendJson, readBody } from "./httputil.mjs";
import { parseMultipartUpload } from "./multipart.mjs";
import { stageFromUpload } from "./staging.mjs";
import { inspectAxureProject } from "./axure.mjs";
import { parseDeployToken } from "./auth.mjs";
import { createLocalSession } from "./local-session.mjs";
import { createCloudflareAccessAuth } from "./cloudflare-access.mjs";

const PROJECT_ID = "([0-9a-f-]{36})";
const DETAIL_RE = new RegExp(`^/api/projects/${PROJECT_ID}$`);
const VERSIONS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/versions$`);
const ROLLBACK_RE = new RegExp(`^/api/projects/${PROJECT_ID}/rollback$`);
const SHARES_RE = new RegExp(`^/api/projects/${PROJECT_ID}/shares$`);
const SHARE_ACTION_RE = new RegExp(
  `^/api/projects/${PROJECT_ID}/shares/([0-9a-f]{16})/(revoke|enable|disable)$`
);
const DEPLOY_KEYS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/deploy-keys$`);
const DEPLOY_KEY_ACTION_RE = new RegExp(
  `^/api/projects/${PROJECT_ID}/deploy-keys/([0-9a-f]{16})/(revoke|enable|disable)$`
);

// The legacy JSON html cap — intentionally kept byte-identical with v0.2.0.
const LEGACY_HTML_BYTES = 180000;

// RC6: deploy keys are restricted to a fixed, exact-match allowlist scoped
// to the key's own project. Anything else — including every admin-only
// route (project creation, PATCH, rollback, share management, deploy-key
// management, other projects' endpoints) — is denied. Exact equality (not
// prefix matching) prevents path-shape bypasses such as
// /api/projects/{otherId}/versions or suffixed paths.
function deployKeyAllowed(method, pathname, projectId) {
  const versionsPath = `/api/projects/${projectId}/versions`;
  const detailPath = `/api/projects/${projectId}`;

  return (
    (method === "GET" && pathname === "/api/limits") ||
    (method === "POST" && pathname === versionsPath) ||
    (method === "GET" &&
      (pathname === versionsPath || pathname === detailPath))
  );
}

export function createApiHandler({ config, store, auth, previewTickets, version, getPreviewPort }) {
  // Only an explicitly enabled loopback development instance may issue a
  // short-lived browser cookie. The admin bearer token is never exposed.
  const localSession = createLocalSession(config);
  const cloudflareAccess = createCloudflareAccessAuth(config);
  // The internal workbench is static, contains no credentials and remains
  // reachable without an API bearer token (as in previous versions).
  let consoleHtml = null;

  try {
    consoleHtml = readFileSync(
      new URL("../console.html", import.meta.url),
      "utf8"
    );
  } catch {
    consoleHtml = null;
  }

  function serveConsole(req, res) {
    if (!consoleHtml) {
      return sendJson(res, 404, { error: "Not Found" });
    }

    // Inject the browser-facing preview wiring: an absolute public base URL
    // when configured (Docker / dedicated preview origin), otherwise null —
    // the workbench then falls back to same-host + the ACTUAL bound preview
    // port (which may differ from the configured one under port 0 testing).
    const previewPort = getPreviewPort
      ? getPreviewPort()
      : config.previewPort;

    const html = consoleHtml
      .replace("__ARCU_PREVIEW_PORT__", String(previewPort))
      .replace("__ARCU_PREVIEW_BASE__", JSON.stringify(config.previewPublicBaseUrl))
      .replace("__ARCU_LOCAL_MODE_VALUE__", String(localSession.eligible(req)))
      .replace("__ARCU_ACCESS_MODE_VALUE__", String(cloudflareAccess.enabled))
      .replace("__ARCU_PUBLIC_PREVIEW_MODE_VALUE__", String(config.stagingPublicPreview === true));

    const localCookie = localSession.issueCookie(req);
    res.writeHead(200, {
      ...(localCookie ? { "Set-Cookie": localCookie } : {}),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; " +
        "script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "form-action 'none'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'none'"
    });

    res.end(html);
  }

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

      if (
        req.method === "GET" &&
        (pathname === "/console" || pathname === "/console/")
      ) {
        return serveConsole(req, res);
      }

      // RC6: deploy-key mode. The dpk_ prefix routes to the restricted
      // project-scoped guard; the admin token path below is unchanged and
      // never widened. A malformed or invalid deploy token is always 401.
      const deployToken = parseDeployToken(req.headers.authorization);

      if (deployToken) {
        if (!pathname.startsWith("/api/")) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        const verdict = await store.validateDeployKey(
          deployToken.keyId,
          deployToken.secret
        );

        if (!verdict || verdict.reason === "bad_token") {
          return sendJson(res, 401, {
            error: "Unauthorized",
            code: "DEPLOY_KEY_INVALID"
          });
        }

        if (verdict.reason) {
          return sendJson(res, 401, {
            error: `Deploy key ${verdict.reason}`,
            code: `DEPLOY_KEY_${verdict.reason.toUpperCase()}`
          });
        }

        if (!deployKeyAllowed(req.method, pathname, verdict.projectId)) {
          return sendJson(res, 403, {
            error: "Deploy key is not allowed to perform this operation",
            code: "DEPLOY_KEY_FORBIDDEN"
          });
        }

        req.deployKey = { projectId: verdict.projectId, keyId: verdict.key.id };
      } else if (
        !pathname.startsWith("/api/") ||
        (!auth(req) && !localSession.authorized(req) &&
          !(await cloudflareAccess.authorized(req)))
      ) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (req.method === "GET" && pathname === "/api/limits") {
        // Active upload quotas for the workbench's quota-aware error hints.
        // Values are configuration, not secrets; auth required to avoid
        // unfingerprinted probing.
        return sendJson(res, 200, { limits: config.limits });
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await store.listProjects();
        return sendJson(res, 200, { projects });
      }

      if (req.method === "POST" && pathname === "/api/projects") {
        return await handleCreateProject(req, res, { config, store });
      }

      const versionsMatch = VERSIONS_RE.exec(pathname);

      if (versionsMatch) {
        const id = versionsMatch[1];

        if (req.method === "POST") {
          try {
            return await handleVersionCreate(req, res, { config, store, id });
          } catch (err) {
            // Any failed deploy-key upload (validation, quota, staging...)
            // is recorded for the workbench display.
            await recordDeployUseIfKeyed(req, store, id, null, "failed");
            throw err;
          }
        }

        if (req.method === "GET") {
          const result = await store.listVersions(id);
          return sendJson(res, 200, result);
        }
      }

      const rollbackMatch = ROLLBACK_RE.exec(pathname);

      if (rollbackMatch && req.method === "POST") {
        return await handleRollback(req, res, { config, store, id: rollbackMatch[1] });
      }

      const detailMatch = DETAIL_RE.exec(pathname);

      if (detailMatch) {
        const id = detailMatch[1];

        if (req.method === "GET") {
          const view = await store.getProject(id);

          // Additive RC3 field: the workbench labels Axure projects with the
          // safe-preview entry (page directory) instead of the raw player.
          try {
            const meta = await store.readRawMeta(id);
            const entry = await store.currentVersionEntry(id, meta);
            view.isAxure = (
              await inspectAxureProject(store.versionSourceDir(id, entry))
            ).isAxure;
          } catch {
            view.isAxure = false;
          }

          return sendJson(res, 200, view);
        }

        // RC5: edit project name/description/previewEnabled. Additive and
        // idempotent; the project id and all stored data are unchanged.
        if (req.method === "PATCH") {
          const payload = await readJsonPayload(req, config.limits);
          const patch = {};

          for (const key of ["name", "description", "previewEnabled"]) {
            if (payload[key] !== undefined) {
              patch[key] = payload[key];
            }
          }

          const view = await store.updateProject(id, patch);
          return sendJson(res, 200, view);
        }
      }

      // Issue an ephemeral, project-scoped browser preview capability only
      // after the standard administrator guard has succeeded. This is NOT a
      // share-management operation and deploy keys cannot call this route.
      const ticketMatch = new RegExp(`^/api/projects/${PROJECT_ID}/preview-ticket// API router.
//
// v0.2.0 routes (/health, project list, JSON project creation, auth gate)
// keep their validated behavior; everything else is additive v0.3.0.
// Every failure path returns a JSON error with a stable "code" field
// (see docs/development.md).

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiError, sendError, sendJson, readBody } from "./httputil.mjs";
import { parseMultipartUpload } from "./multipart.mjs";
import { stageFromUpload } from "./staging.mjs";
import { inspectAxureProject } from "./axure.mjs";
import { parseDeployToken } from "./auth.mjs";
import { createLocalSession } from "./local-session.mjs";
import { createCloudflareAccessAuth } from "./cloudflare-access.mjs";

const PROJECT_ID = "([0-9a-f-]{36})";
const DETAIL_RE = new RegExp(`^/api/projects/${PROJECT_ID}$`);
const VERSIONS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/versions$`);
const ROLLBACK_RE = new RegExp(`^/api/projects/${PROJECT_ID}/rollback$`);
const SHARES_RE = new RegExp(`^/api/projects/${PROJECT_ID}/shares$`);
const SHARE_ACTION_RE = new RegExp(
  `^/api/projects/${PROJECT_ID}/shares/([0-9a-f]{16})/(revoke|enable|disable)$`
);
const DEPLOY_KEYS_RE = new RegExp(`^/api/projects/${PROJECT_ID}/deploy-keys$`);
const DEPLOY_KEY_ACTION_RE = new RegExp(
  `^/api/projects/${PROJECT_ID}/deploy-keys/([0-9a-f]{16})/(revoke|enable|disable)$`
);

// The legacy JSON html cap — intentionally kept byte-identical with v0.2.0.
const LEGACY_HTML_BYTES = 180000;

// RC6: deploy keys are restricted to a fixed, exact-match allowlist scoped
// to the key's own project. Anything else — including every admin-only
// route (project creation, PATCH, rollback, share management, deploy-key
// management, other projects' endpoints) — is denied. Exact equality (not
// prefix matching) prevents path-shape bypasses such as
// /api/projects/{otherId}/versions or suffixed paths.
function deployKeyAllowed(method, pathname, projectId) {
  const versionsPath = `/api/projects/${projectId}/versions`;
  const detailPath = `/api/projects/${projectId}`;

  return (
    (method === "GET" && pathname === "/api/limits") ||
    (method === "POST" && pathname === versionsPath) ||
    (method === "GET" &&
      (pathname === versionsPath || pathname === detailPath))
  );
}

export function createApiHandler({ config, store, auth, previewTickets, version, getPreviewPort }) {
  // Only an explicitly enabled loopback development instance may issue a
  // short-lived browser cookie. The admin bearer token is never exposed.
  const localSession = createLocalSession(config);
  const cloudflareAccess = createCloudflareAccessAuth(config);
  // The internal workbench is static, contains no credentials and remains
  // reachable without an API bearer token (as in previous versions).
  let consoleHtml = null;

  try {
    consoleHtml = readFileSync(
      new URL("../console.html", import.meta.url),
      "utf8"
    );
  } catch {
    consoleHtml = null;
  }

  function serveConsole(req, res) {
    if (!consoleHtml) {
      return sendJson(res, 404, { error: "Not Found" });
    }

    // Inject the browser-facing preview wiring: an absolute public base URL
    // when configured (Docker / dedicated preview origin), otherwise null —
    // the workbench then falls back to same-host + the ACTUAL bound preview
    // port (which may differ from the configured one under port 0 testing).
    const previewPort = getPreviewPort
      ? getPreviewPort()
      : config.previewPort;

    const html = consoleHtml
      .replace("__ARCU_PREVIEW_PORT__", String(previewPort))
      .replace("__ARCU_PREVIEW_BASE__", JSON.stringify(config.previewPublicBaseUrl))
      .replace("__ARCU_LOCAL_MODE_VALUE__", String(localSession.eligible(req)))
      .replace("__ARCU_ACCESS_MODE_VALUE__", String(cloudflareAccess.enabled))
      .replace("__ARCU_PUBLIC_PREVIEW_MODE_VALUE__", String(config.stagingPublicPreview === true));

    const localCookie = localSession.issueCookie(req);
    res.writeHead(200, {
      ...(localCookie ? { "Set-Cookie": localCookie } : {}),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; " +
        "script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "form-action 'none'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'none'"
    });

    res.end(html);
  }

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

      if (
        req.method === "GET" &&
        (pathname === "/console" || pathname === "/console/")
      ) {
        return serveConsole(req, res);
      }

      // RC6: deploy-key mode. The dpk_ prefix routes to the restricted
      // project-scoped guard; the admin token path below is unchanged and
      // never widened. A malformed or invalid deploy token is always 401.
      const deployToken = parseDeployToken(req.headers.authorization);

      if (deployToken) {
        if (!pathname.startsWith("/api/")) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        const verdict = await store.validateDeployKey(
          deployToken.keyId,
          deployToken.secret
        );

        if (!verdict || verdict.reason === "bad_token") {
          return sendJson(res, 401, {
            error: "Unauthorized",
            code: "DEPLOY_KEY_INVALID"
          });
        }

        if (verdict.reason) {
          return sendJson(res, 401, {
            error: `Deploy key ${verdict.reason}`,
            code: `DEPLOY_KEY_${verdict.reason.toUpperCase()}`
          });
        }

        if (!deployKeyAllowed(req.method, pathname, verdict.projectId)) {
          return sendJson(res, 403, {
            error: "Deploy key is not allowed to perform this operation",
            code: "DEPLOY_KEY_FORBIDDEN"
          });
        }

        req.deployKey = { projectId: verdict.projectId, keyId: verdict.key.id };
      } else if (
        !pathname.startsWith("/api/") ||
        (!auth(req) && !localSession.authorized(req) &&
          !(await cloudflareAccess.authorized(req)))
      ) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (req.method === "GET" && pathname === "/api/limits") {
        // Active upload quotas for the workbench's quota-aware error hints.
        // Values are configuration, not secrets; auth required to avoid
        // unfingerprinted probing.
        return sendJson(res, 200, { limits: config.limits });
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await store.listProjects();
        return sendJson(res, 200, { projects });
      }

      if (req.method === "POST" && pathname === "/api/projects") {
        return await handleCreateProject(req, res, { config, store });
      }

      const versionsMatch = VERSIONS_RE.exec(pathname);

      if (versionsMatch) {
        const id = versionsMatch[1];

        if (req.method === "POST") {
          try {
            return await handleVersionCreate(req, res, { config, store, id });
          } catch (err) {
            // Any failed deploy-key upload (validation, quota, staging...)
            // is recorded for the workbench display.
            await recordDeployUseIfKeyed(req, store, id, null, "failed");
            throw err;
          }
        }

        if (req.method === "GET") {
          const result = await store.listVersions(id);
          return sendJson(res, 200, result);
        }
      }

      const rollbackMatch = ROLLBACK_RE.exec(pathname);

      if (rollbackMatch && req.method === "POST") {
        return await handleRollback(req, res, { config, store, id: rollbackMatch[1] });
      }

      const detailMatch = DETAIL_RE.exec(pathname);

      if (detailMatch) {
        const id = detailMatch[1];

        if (req.method === "GET") {
          const view = await store.getProject(id);

          // Additive RC3 field: the workbench labels Axure projects with the
          // safe-preview entry (page directory) instead of the raw player.
          try {
            const meta = await store.readRawMeta(id);
            const entry = await store.currentVersionEntry(id, meta);
            view.isAxure = (
              await inspectAxureProject(store.versionSourceDir(id, entry))
            ).isAxure;
          } catch {
            view.isAxure = false;
          }

          return sendJson(res, 200, view);
        }

        // RC5: edit project name/description/previewEnabled. Additive and
        // idempotent; the project id and all stored data are unchanged.
        if (req.method === "PATCH") {
          const payload = await readJsonPayload(req, config.limits);
          const patch = {};

          for (const key of ["name", "description", "previewEnabled"]) {
            if (payload[key] !== undefined) {
              patch[key] = payload[key];
            }
          }

          const view = await store.updateProject(id, patch);
          return sendJson(res, 200, view);
        }
      }

).exec(pathname);
      if (ticketMatch && req.method === "POST") {
        if (!config.stagingPublicPreview || !previewTickets) {
          return sendJson(res, 404, { error: "Not Found" });
        }
        const meta = await store.readRawMeta(ticketMatch[1]);
        if (!meta || meta.previewEnabled === false) {
          return sendJson(res, 404, { error: "Not Found" });
        }
        const ticket = previewTickets.issue(ticketMatch[1]);
        return sendJson(res, 201, ticket);
      }

      const sharesMatch = SHARES_RE.exec(pathname);

      if (sharesMatch) {
        const id = sharesMatch[1];

        if (req.method === "GET") {
          return sendJson(res, 200, await store.listShares(id));
        }

        if (req.method === "POST") {
          const payload = await readJsonPayload(req, config.limits);
          const expiresAt = await resolveExpiry(payload);

          const share = await store.createShare(id, { expiresAt });
          return sendJson(res, 201, share);
        }
      }

      const shareActionMatch = SHARE_ACTION_RE.exec(pathname);

      if (shareActionMatch && req.method === "POST") {
        const [, id, shareId, action] = shareActionMatch;

        if (action === "revoke") {
          return sendJson(res, 200, await store.revokeShare(id, shareId));
        }

        if (action === "enable") {
          return sendJson(res, 200, await store.setShareEnabled(id, shareId, true));
        }

        return sendJson(res, 200, await store.setShareEnabled(id, shareId, false));
      }

      // RC6: deploy-key management (admin only — the deploy-key guard never
      // reaches here because the exact-match allowlist excludes this path).
      const deployKeysMatch = DEPLOY_KEYS_RE.exec(pathname);

      if (deployKeysMatch) {
        const id = deployKeysMatch[1];

        if (req.method === "GET") {
          return sendJson(res, 200, await store.listDeployKeys(id));
        }

        if (req.method === "POST") {
          const payload = await readJsonPayload(req, config.limits);
          const expiresAt = await resolveExpiry(payload);

          const key = await store.createDeployKey(id, { expiresAt });
          return sendJson(res, 201, key);
        }
      }

      const deployKeyActionMatch = DEPLOY_KEY_ACTION_RE.exec(pathname);

      if (deployKeyActionMatch && req.method === "POST") {
        const [, id, keyId, action] = deployKeyActionMatch;

        if (action === "revoke") {
          return sendJson(res, 200, await store.revokeDeployKey(id, keyId));
        }

        if (action === "enable") {
          return sendJson(res, 200, await store.setDeployKeyEnabled(id, keyId, true));
        }

        return sendJson(res, 200, await store.setDeployKeyEnabled(id, keyId, false));
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

// Shared expiresAt/expiresInHours parsing for share and deploy-key creation
// (previously inline in the share route; behavior unchanged).
function resolveExpiry(payload) {
  if (payload.expiresAt !== undefined && payload.expiresAt !== null) {
    if (typeof payload.expiresAt !== "string") {
      throw new ApiError(400, "Invalid expiresAt", "INVALID_EXPIRES_AT");
    }
    return payload.expiresAt;
  }

  if (typeof payload.expiresInHours === "number") {
    if (
      !Number.isFinite(payload.expiresInHours) ||
      payload.expiresInHours <= 0 ||
      payload.expiresInHours > 24 * 365
    ) {
      throw new ApiError(400, "Invalid expiresInHours", "INVALID_EXPIRES_AT");
    }
    return new Date(
      Date.now() + payload.expiresInHours * 3600 * 1000
    ).toISOString();
  }

  return null;
}

async function readJsonPayload(req, limits) {
  try {
    return JSON.parse(await readBody(req, limits.maxJsonBodyBytes));
  } catch (err) {
    if (err instanceof ApiError) {
      throw err; // 413 passthrough with legacy message
    }
    throw new ApiError(400, "Invalid JSON");
  }
}

// Stages a legacy-style JSON html payload as a single-file project.
async function stageJsonHtml(html, store) {
  const stagedDir = store.stagingDir("new");

  try {
    await fs.mkdir(stagedDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stagedDir, "index.html"), html, {
      flag: "wx",
      mode: 0o600
    });

    return {
      stagedDir,
      stats: {
        fileCount: 1,
        totalSize: Buffer.byteLength(html),
        entryPoint: "index.html"
      }
    };
  } catch (err) {
    await fs.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
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

  const payload = await readJsonPayload(req, config.limits);

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const html = typeof payload.html === "string" ? payload.html : "";

  if (
    !name ||
    name.length > 100 ||
    !html.toLowerCase().includes("<html") ||
    Buffer.byteLength(html) > LEGACY_HTML_BYTES
  ) {
    return sendJson(res, 400, { error: "Invalid name or HTML" });
  }

  const description = cleanDescription(payload.description, config.limits);
  const staged = await stageJsonHtml(html, store);

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

// v0.3.0: upload a new version (multipart file or legacy JSON html).
// Failure at any validation stage never changes the current version.
// RC6: an optional X-Arcunara-Content-Hash header enables idempotent
// re-deploys (identical content to the current version is a no-op); when
// the caller authenticated with a deploy key, its usage is recorded for
// the workbench (success and failure). Deploy-key uploads never touch
// previewEnabled or any other project setting.
async function handleVersionCreate(req, res, { config, store, id }) {
  const rawHash = req.headers["x-arcunara-content-hash"];
  const contentHash =
    typeof rawHash === "string" && rawHash.trim() !== ""
      ? rawHash.trim().toLowerCase()
      : undefined;

  const meta = await store.readRawMeta(id);

  if (!meta) {
    throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
  }

  const contentType = req.headers["content-type"] || "";

  if (contentType.startsWith("multipart/form-data")) {
    const { fields: _fields, file } = await parseMultipartUpload(req, {
      tmpDir: store.tmpDir,
      limits: config.limits
    });

    try {
      const staged = await stageFromUpload(file, { store, limits: config.limits });

      try {
        const view = await store.addVersion(id, { ...staged, contentHash });
        await recordDeployUseIfKeyed(req, store, id, view.version, "ok");
        return sendJson(res, 201, view);
      } catch (err) {
        await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    } catch (err) {
      await fs.rm(file.tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  if (contentType.startsWith("application/json")) {
    const payload = await readJsonPayload(req, config.limits);
    const html = typeof payload.html === "string" ? payload.html : "";

    if (
      !html.toLowerCase().includes("<html") ||
      Buffer.byteLength(html) > LEGACY_HTML_BYTES
    ) {
      throw new ApiError(400, "Invalid HTML payload", "INVALID_HTML");
    }

    const staged = await stageJsonHtml(html, store);

    try {
      const view = await store.addVersion(id, { ...staged, contentHash });
      await recordDeployUseIfKeyed(req, store, id, view.version, "ok");
      return sendJson(res, 201, view);
    } catch (err) {
      await fs.rm(staged.stagedDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  return sendJson(res, 415, {
    error: "Use application/json or multipart/form-data",
    code: "UNSUPPORTED_MEDIA_TYPE"
  });
}

// Best-effort deploy-key usage bookkeeping (RC6). No-op for admin calls.
async function recordDeployUseIfKeyed(req, store, projectId, version, result) {
  if (!req.deployKey || req.deployKey.projectId !== projectId) {
    return;
  }

  await store
    .recordDeployUse(projectId, req.deployKey.keyId, { version, result })
    .catch(() => {});
}

async function handleRollback(req, res, { config, store, id }) {
  const payload = await readJsonPayload(req, config.limits);
  const target = payload.version;

  if (!Number.isInteger(target) || target < 1) {
    throw new ApiError(
      400,
      "Version must be a positive integer",
      "INVALID_VERSION"
    );
  }

  const result = await store.rollback(id, target);
  return sendJson(res, 200, result);
}
