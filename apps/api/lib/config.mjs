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

export function loadConfig(env = process.env) {
  const tokenFile = env.ARCU_TOKEN_FILE || "/run/secrets/api_token";
  const token = readFileSync(tokenFile, "utf8").trim();

  if (!token) {
    throw new Error("API token file is empty");
  }

  const limits = {
    // Legacy JSON upload cap — kept byte-identical with v0.2.0 behavior.
    maxJsonBodyBytes: intFromEnv(env, "ARCU_MAX_JSON_BODY_BYTES", 256 * 1024),

    // Multipart/ZIP upload engine limits (see docs/development.md).
    maxZipBytes: intFromEnv(env, "ARCU_MAX_ZIP_BYTES", 20 * MIB),
    maxExtractBytes: intFromEnv(env, "ARCU_MAX_EXTRACT_BYTES", 80 * MIB),
    maxFileBytes: intFromEnv(env, "ARCU_MAX_FILE_BYTES", 20 * MIB),
    maxHtmlBytes: intFromEnv(env, "ARCU_MAX_HTML_BYTES", 2 * MIB),
    maxFiles: intFromEnv(env, "ARCU_MAX_FILES", 2000),
    maxDepth: intFromEnv(env, "ARCU_MAX_DEPTH", 20),
    maxPathLength: intFromEnv(env, "ARCU_MAX_PATH_LENGTH", 256),
    maxDescriptionChars: intFromEnv(env, "ARCU_MAX_DESCRIPTION_CHARS", 1000),
    maxUploadBodyBytes: intFromEnv(env, "ARCU_MAX_UPLOAD_BODY_BYTES", 24 * MIB)
  };

  return {
    store: env.ARCU_DATA_DIR || "/app/data",
    token,
    tokenFile,
    apiPort: portFromEnv(env, "ARCU_API_PORT", 3000),
    apiHost: env.ARCU_API_HOST || "0.0.0.0",
    previewPort: portFromEnv(env, "ARCU_PREVIEW_PORT", 3001),
    previewHost: env.ARCU_PREVIEW_HOST || "0.0.0.0",
    limits
  };
}
