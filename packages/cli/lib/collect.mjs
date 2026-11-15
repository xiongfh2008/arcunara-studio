// Source collection for `arcunara deploy`.
//
// Security rules:
// - Directories are walked with lstat; symbolic links (and other
//   non-regular files) are rejected with a clear error — no link escape.
// - Every collected path is relative to the source root; absolute paths
//   cannot occur by construction, and dot-segment names are rejected.
// - Sensitive local files never enter the archive: all dotfiles, secrets
//   (.env, *.pem, *.key, id_rsa*, *.p12, *.pfx) and development
//   directories (.git, node_modules, dist caches...) are excluded. This
//   mirrors the preview server, which denies dotfiles anyway.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".arcunara",
  ".turbo",
  ".next",
  ".cache"
]);

const EXCLUDED_FILE_PATTERNS = [
  /^\.env/i, // .env, .env.local, .env.production...
  /\.(pem|key|p12|pfx|keystore)$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /\.arcunara\.json$/i,
  /^(thumbs\.db|desktop\.ini)$/i
];

function isSegmentSafe(segment) {
  // Reject traversal shapes and Windows-invalid names defensively even
  // though fs.readdir never yields them from a walked tree.
  return (
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes(":") &&
    segment.length > 0
  );
}

function excludedName(name) {
  // All dotfiles are excluded (the preview server refuses them anyway).
  return name.startsWith(".") || EXCLUDED_FILE_PATTERNS.some((re) => re.test(name));
}

async function walk(root, relDir, files, depth) {
  if (depth > 64) {
    throw new Error(`Directory nesting too deep: ${relDir || "."}`);
  }

  const entries = await fs.readdir(path.join(root, relDir), {
    withFileTypes: true
  });

  for (const entry of entries) {
    const name = entry.name;

    if (!isSegmentSafe(name)) {
      throw new Error(`Unsafe file name: ${path.join(relDir, name)}`);
    }

    const rel = relDir ? `${relDir}/${name}` : name;

    if (excludedName(name)) {
      continue;
    }

    // lstat — never follow symbolic links or special files.
    const stat = await fs.lstat(path.join(root, rel));

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to follow symbolic link: ${rel} (remove it or copy real files)`
      );
    }

    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(name.toLowerCase())) {
        continue;
      }

      await walk(root, rel, files, depth + 1);
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported file type (not a regular file): ${rel}`);
    }

    files.push({ relPath: rel, size: stat.size, mtime: stat.mtime });
  }
}

// Collects a directory into memory, enforcing server-side style caps early
// so oversized sources fail before any network traffic.
export async function collectDirectory(root, limits) {
  const files = [];

  await walk(path.resolve(root), "", files, 0);

  if (files.length === 0) {
    throw new Error(`No publishable files found in ${root} (dotfiles and development directories are excluded)`);
  }

  if (limits && files.length > limits.maxFiles) {
    throw new Error(
      `Too many files: ${files.length} (server limit ${limits.maxFiles})`
    );
  }

  let totalSize = 0;

  for (const file of files) {
    if (limits && file.size > limits.maxFileBytes) {
      throw new Error(
        `File too large: ${file.relPath} (${file.size} bytes > ${limits.maxFileBytes})`
      );
    }

    totalSize += file.size;
  }

  if (limits && totalSize > limits.maxExtractBytes) {
    throw new Error(
      `Total content too large: ${totalSize} bytes (server limit ${limits.maxExtractBytes})`
    );
  }

  const entries = [];

  for (const file of files) {
    const data = await fs.readFile(path.join(root, file.relPath));
    entries.push({ name: file.relPath, data, mtime: file.mtime });
  }

  return {
    files,
    entries,
    totalSize,
    fileCount: files.length,
    contentHash: contentHashOf(entries)
  };
}

// RC6 idempotency key: sha256 over the ordered manifest
// (relative path + content). Stable across machines and runs.
export function contentHashOf(entries) {
  const hash = crypto.createHash("sha256");

  for (const entry of entries) {
    hash.update(entry.name.replace(/\\/g, "/"), "utf8");
    hash.update("\0");
    hash.update(entry.data);
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function contentHashOfBuffer(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
