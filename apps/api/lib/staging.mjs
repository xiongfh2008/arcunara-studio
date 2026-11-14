// Upload staging: assembles a validated, entry-detected content directory
// from an uploaded HTML/ZIP file. Everything happens inside the store's
// staging area; the store publishes it atomically only after full success.

import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./httputil.mjs";
import { isHtmlName, isZipName } from "./multipart.mjs";
import { detectAndRerootEntry } from "./entrypoint.mjs";
import { extractZipSafely } from "./zipextract.mjs";

async function rmQuiet(p) {
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
}

export async function stageFromUpload(file, { store, limits }) {
  if (isZipName(file.filename)) {
    return stageZip(file, { store, limits });
  }

  if (isHtmlName(file.filename)) {
    return stageHtml(file, { store });
  }

  throw new ApiError(400, "Unsupported file type", "UNSUPPORTED_FILE_TYPE");
}

async function stageZip(file, { store, limits }) {
  const stagedDir = store.stagingDir("zip");
  await fs.mkdir(stagedDir, { recursive: true, mode: 0o700 });

  try {
    const stats = await extractZipSafely(file.tmpPath, stagedDir, limits);
    const { entryPoint } = await detectAndRerootEntry(stagedDir);
    await rmQuiet(file.tmpPath);

    return {
      stagedDir,
      stats: {
        fileCount: stats.fileCount,
        totalSize: stats.totalBytes,
        entryPoint
      }
    };
  } catch (err) {
    await rmQuiet(stagedDir);
    await rmQuiet(file.tmpPath);
    throw err;
  }
}

async function stageHtml(file, { store }) {
  const stagedDir = store.stagingDir("html");
  await fs.mkdir(stagedDir, { recursive: true, mode: 0o700 });

  try {
    // Same content rule as the legacy JSON path: the document must be HTML.
    const content = await fs.readFile(file.tmpPath, "utf8");

    if (!content.toLowerCase().includes("<html")) {
      throw new ApiError(400, "Invalid HTML file", "INVALID_HTML_FILE");
    }

    await fs.rename(file.tmpPath, path.join(stagedDir, "index.html"));

    return {
      stagedDir,
      stats: {
        fileCount: 1,
        totalSize: file.bytes,
        entryPoint: "index.html"
      }
    };
  } catch (err) {
    await rmQuiet(stagedDir);
    await rmQuiet(file.tmpPath);
    throw err;
  }
}
