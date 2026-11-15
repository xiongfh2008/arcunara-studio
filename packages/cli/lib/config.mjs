// .arcunara.json — local project ↔ remote Arcunara project association.
//
// Non-sensitive fields only: the deploy key lives in the ARCU_DEPLOY_KEY
// environment variable (or the OS credential store); it is NEVER written
// to this file, to Git, to logs, or to preview URLs.

import fs from "node:fs/promises";
import path from "node:path";

export const CONFIG_FILE = ".arcunara.json";

const UUID_RE = /^[0-9a-f-]{36}$/;

export async function loadConfig(startDir = process.cwd()) {
  const file = path.join(startDir, CONFIG_FILE);
  let raw;

  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${file}`);
  }

  if (parsed.apiToken || parsed.deployKey || parsed.token) {
    throw new Error(
      `${CONFIG_FILE} must not contain credentials. ` +
        `Set the ARCU_DEPLOY_KEY environment variable instead.`
    );
  }

  if (parsed.projectId !== undefined && !UUID_RE.test(parsed.projectId)) {
    throw new Error(`${CONFIG_FILE}: projectId is not a valid project id`);
  }

  return {
    projectId: parsed.projectId ?? null,
    apiBase: parsed.apiBase ?? null,
    previewBase: parsed.previewBase ?? null,
    uploadDir: parsed.uploadDir ?? null,
    buildCommand: parsed.buildCommand ?? null,
    path: file
  };
}

export async function saveConfig(dir, values) {
  const file = path.join(dir, CONFIG_FILE);
  const existing = await loadConfig(dir).catch(() => null);
  const merged = {
    projectId: values.projectId ?? existing?.projectId ?? null,
    apiBase: values.apiBase ?? existing?.apiBase ?? null,
    previewBase: values.previewBase ?? existing?.previewBase ?? null,
    uploadDir: values.uploadDir ?? existing?.uploadDir ?? null,
    buildCommand: values.buildCommand ?? existing?.buildCommand ?? null
  };

  await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return file;
}
