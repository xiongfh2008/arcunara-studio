// Environment-driven configuration.
//
// Server defaults match the validated v0.2.0 deployment. The ARCU_MAX_*
// limits govern the v0.3.0 multipart/ZIP upload engine and are enforced
// while streaming, not after completion.

import { readFileSync } from "node:fs";

const MIB = 1024 * 1024;

function intFromEnv(
  env,
  name,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {}
) {
  const raw = env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: "${raw}"`);
  }

  return value;
}

function portFromEnv(env, name, fallback) {
  return intFromEnv(env, name, fallback, { min: 0, max: 65535 });
}

// Browser-facing base URL for preview links built by the workbench.
// The preview server's LISTEN address (port/host) is an internal concern —
// under Docker the browser reaches previews via the host-mapped port or a
// dedicated public origin, so the workbench must never construct links from
// the internal port when an explicit base URL is configured.
function previewPublicBaseUrlFromEnv(env) {
  const raw = env.ARCU_PREVIEW_PUBLIC_BASE_URL;

  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  let url;

  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid ARCU_PREVIEW_PUBLIC_BASE_URL: "${raw}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid ARCU_PREVIEW_PUBLIC_BASE_URL protocol: "${url.protocol}" (use http/https)`
    );
  }

  if (url.username || url.password) {
    throw new Error("ARCU_PREVIEW_PUBLIC_BASE_URL must not contain credentials");
  }

  if (url.search || url.hash) {
    throw new Error("ARCU_PREVIEW_PUBLIC_BASE_URL must not contain a query or fragment");
  }

  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function loadConfig(env = process.env) {
  const tokenFile = env.ARCU_TOKEN_FILE || "/run/secrets/api_token";
  const token = readFileSync(tokenFile, "utf8").trim();

  if (!token) {
    throw new Error("API token file is empty");
  }

  // Local convenience is opt-in and must never silently turn on in Docker/VPS.
  // Both listeners must bind exactly to IPv4 loopback before issuing a local
  // browser session. The admin token is still required for CLI and remote use.
  const apiHost = env.ARCU_API_HOST || "0.0.0.0";
  const previewHost = env.ARCU_PREVIEW_HOST || "0.0.0.0";
  const localFlag = env.ARCU_LOCAL_AUTO_LOGIN || "0";
  if (localFlag !== "0" && localFlag !== "1") {
    throw new Error("ARCU_LOCAL_AUTO_LOGIN must be 0 or 1");
  }
  const localAutoLogin = localFlag === "1";
  if (localAutoLogin && (apiHost !== "127.0.0.1" || previewHost !== "127.0.0.1")) {
    throw new Error("ARCU_LOCAL_AUTO_LOGIN requires both API and preview to bind 127.0.0.1");
  }

  // Larger, previously tested Axure-export profile for explicitly enabled
  // loopback-only development. The normal production defaults stay strict.
  // Explicit ARCU_MAX_* overrides always take precedence.
  const localAxureLimits = localAutoLogin;
  const limits = {
    // Legacy JSON upload cap — kept byte-identical with v0.2.0 behavior.
    maxJsonBodyBytes: intFromEnv(env, "ARCU_MAX_JSON_BODY_BYTES", 256 * 1024),

    // Multipart/ZIP upload engine limits (see docs/development.md).
    maxZipBytes: intFromEnv(env, "ARCU_MAX_ZIP_BYTES", 20 * MIB),
    maxExtractBytes: intFromEnv(env, "ARCU_MAX_EXTRACT_BYTES", (localAxureLimits ? 128 : 80) * MIB),
    maxFileBytes: intFromEnv(env, "ARCU_MAX_FILE_BYTES", 20 * MIB),
    maxHtmlBytes: intFromEnv(env, "ARCU_MAX_HTML_BYTES", (localAxureLimits ? 8 : 2) * MIB),
    maxFiles: intFromEnv(env, "ARCU_MAX_FILES", localAxureLimits ? 5000 : 2000),
    maxDepth: intFromEnv(env, "ARCU_MAX_DEPTH", 20),
    maxPathLength: intFromEnv(env, "ARCU_MAX_PATH_LENGTH", 256),
    maxDescriptionChars: intFromEnv(env, "ARCU_MAX_DESCRIPTION_CHARS", 1000),
    maxUploadBodyBytes: intFromEnv(env, "ARCU_MAX_UPLOAD_BODY_BYTES", 24 * MIB)
  };


  return {
    localAutoLogin,
    store: env.ARCU_DATA_DIR || "/app/data",
    token,
    tokenFile,
    apiPort: portFromEnv(env, "ARCU_API_PORT", 3000),
    apiHost,
    previewPort: portFromEnv(env, "ARCU_PREVIEW_PORT", 3001),
    previewHost,
    previewPublicBaseUrl: previewPublicBaseUrlFromEnv(env),
    limits
  };
}
