// Entry point detection for staged project directories.
//
// Priority (v0.3.0 spec):
// 1. index.html in the staging root.
// 2. Exactly one top-level wrapper directory whose immediate child is
//    index.html — the wrapper is re-rooted (contents moved up one level)
//    so relative resource references keep working. The overall structure
//    is preserved; nothing is flattened.
// 3. Exactly one HTML file anywhere — it becomes the entry (structure kept).
// 4. Otherwise the archive is ambiguous and rejected with a clear error.

import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./httputil.mjs";

async function existsFile(p) {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

// Relative POSIX paths of all regular files below dir.
async function walkFiles(dir, prefix = "") {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files;
}

// Moves the children of inner up into dir and removes the empty wrapper.
async function reroot(dir, inner) {
  for (const entry of await fs.readdir(inner, { withFileTypes: true })) {
    await fs.rename(path.join(inner, entry.name), path.join(dir, entry.name));
  }
  await fs.rmdir(inner);
}

export async function detectAndRerootEntry(dir) {
  const files = await walkFiles(dir);

  if (files.length === 0) {
    throw new ApiError(400, "Archive contains no files", "EMPTY_ARCHIVE");
  }

  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));

  if (htmlFiles.length === 0) {
    throw new ApiError(400, "No HTML entry found in archive", "NO_HTML_ENTRY");
  }

  if (await existsFile(path.join(dir, "index.html"))) {
    return { entryPoint: "index.html" };
  }

  const topEntries = await fs.readdir(dir, { withFileTypes: true });

  if (topEntries.length === 1 && topEntries[0].isDirectory()) {
    const inner = path.join(dir, topEntries[0].name);

    if (await existsFile(path.join(inner, "index.html"))) {
      await reroot(dir, inner);
      return { entryPoint: "index.html" };
    }
  }

  if (htmlFiles.length === 1) {
    return { entryPoint: htmlFiles[0] };
  }

  throw new ApiError(
    400,
    "Could not determine a unique entry HTML file",
    "ENTRY_NOT_DETERMINED"
  );
}
