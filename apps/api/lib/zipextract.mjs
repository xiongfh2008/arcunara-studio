// Safe ZIP extraction (yauzl, streaming).
//
// Security posture — every rule is enforced while processing, entry by
// entry, before anything is published:
// - Zip Slip / traversal: absolute paths, "..", ".", backslash separators,
//   drive letters, UNC hints, NUL/control characters are rejected
//   (see lib/pathsafety.mjs).
// - Symlinks and non-regular entry types are rejected.
// - Quotas enforced live: file count, per-entry size, per-HTML size, total
//   uncompressed size (declared sizes are checked BEFORE decompression and
//   yauzl's validateEntrySizes re-validates actual bytes while streaming).
// - Duplicate or case/Unicode-aliasing entry paths are rejected so nothing
//   can be silently overwritten (incl. on case-insensitive filesystems).
// - Encrypted entries and multi-disk archives are rejected.
// - CRC/size mismatches surface as stream errors and abort the upload.
//
// Nothing from the archive is trusted: destination paths are joined from
// individually validated segments under a controlled staging directory.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { ApiError } from "./httputil.mjs";
import { collisionKey, isValidSegment } from "./pathsafety.mjs";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        // Reject backslash separators at the metadata layer (yauzl would
        // otherwise silently rewrite them to "/").
        strictFileNames: true
      },
      (err, zipfile) => (err ? reject(err) : resolve(zipfile))
    );
  });
}

// yauzl's close() unrefs the reader, which asynchronously closes the file
// descriptor (fd-slicer emits "close"). Wait for it so the temp file can be
// deleted immediately afterwards, even on Windows.
function closeZip(zipfile) {
  return new Promise((resolve) => {
    if (!zipfile.isOpen) return resolve();
    zipfile.reader.once("close", resolve);
    zipfile.close();
    setTimeout(resolve, 2000).unref(); // safety net
  });
}

function nextEntry(zipfile) {
  return new Promise((resolve, reject) => {
    zipfile.once("entry", resolve);
    zipfile.once("end", () => resolve(null));
    zipfile.once("error", reject);
    zipfile.readEntry();
  });
}

function openStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) =>
      err ? reject(err) : resolve(stream)
    );
  });
}

// Unix mode bits, when the archive records them (host OS = Unix). Null for
// DOS/Windows-created archives, which carry no mode information.
function entryUnixMode(entry) {
  const host = entry.versionMadeBy >> 8;
  if (host !== 3) return null;
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function isHtmlName(name) {
  return /\.html?$/i.test(name);
}

export async function extractZipSafely(zipPath, destDir, limits) {
  const usedPaths = new Set(); // collision keys of accepted entries
  let entryCount = 0; // files + directories, capped by maxFiles
  let fileCount = 0; // regular files only, reported in stats
  let totalBytes = 0;

  let zipfile;

  try {
    zipfile = await openZip(zipPath);
  } catch (err) {
    throw new ApiError(400, "Invalid ZIP archive", "INVALID_ZIP", err);
  }

  try {
    let entry;

    while ((entry = await nextEntry(zipfile)) !== null) {
      await processEntry(entry);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;

    // yauzl validates entry names during metadata decoding; map those
    // rejections to the same clear code as our own path checks.
    const message = err?.message ?? "";

    if (
      message.startsWith("invalid relative path") ||
      message.startsWith("absolute path") ||
      message.startsWith("invalid characters in fileName")
    ) {
      throw new ApiError(400, "Unsafe ZIP entry path", "UNSAFE_ENTRY_PATH", err);
    }

    // Malformed archives, CRC/size mismatches, unsupported compression
    // methods etc. surface as stream/parse errors.
    throw new ApiError(400, "Invalid ZIP archive", "INVALID_ZIP", err);
  } finally {
    await closeZip(zipfile);
  }

  return { fileCount, totalBytes };

  async function processEntry(entry) {
    const rawName = entry.fileName;

    // Backslash separators are rejected outright: ZIP requires "/", and
    // backslashes only appear in crafted (Windows-confusion) archives.
    if (rawName.includes("\\")) {
      throw new ApiError(
        400,
        "Unsafe ZIP entry path",
        "UNSAFE_ENTRY_PATH"
      );
    }

    if (entry.isEncrypted()) {
      throw new ApiError(
        400,
        "Encrypted ZIP entries are not supported",
        "ENCRYPTED_ENTRY"
      );
    }

    // Split into segments; a trailing slash marks a directory entry.
    const segments = rawName.split("/");
    let isDir = false;

    if (segments[segments.length - 1] === "") {
      isDir = true;
      segments.pop();
    }

    if (segments.length === 0) {
      return; // "/" root entry — nothing to create
    }

    for (const segment of segments) {
      if (!isValidSegment(segment)) {
        throw new ApiError(400, "Unsafe ZIP entry path", "UNSAFE_ENTRY_PATH");
      }
    }

    if (segments.length > limits.maxDepth) {
      throw new ApiError(
        413,
        "Archive entry path is too deep",
        "DEPTH_LIMIT_EXCEEDED"
      );
    }

    const relPath = segments.join("/");

    if (relPath.length > limits.maxPathLength) {
      throw new ApiError(
        413,
        "Archive entry path is too long",
        "PATH_LIMIT_EXCEEDED"
      );
    }

    const key = collisionKey(relPath);

    if (usedPaths.has(key)) {
      throw new ApiError(
        400,
        "Duplicate or aliasing ZIP entry path",
        "ENTRY_COLLISION"
      );
    }

    usedPaths.add(key);

    // Live file-count quota (directories included — each becomes an fs node).
    entryCount += 1;

    if (entryCount > limits.maxFiles) {
      throw new ApiError(413, "Too many files in archive", "TOO_MANY_FILES");
    }

    if (isDir) {
      await fs.mkdir(path.join(destDir, ...segments), { recursive: true });
      return;
    }

    fileCount += 1;

    const mode = entryUnixMode(entry);

    if (mode !== null) {
      const type = mode & S_IFMT;

      if (type === S_IFLNK) {
        throw new ApiError(
          400,
          "Symlink entries are not allowed",
          "SYMLINK_ENTRY"
        );
      }

      if (type !== S_IFREG && type !== 0) {
        throw new ApiError(
          400,
          "Unsupported ZIP entry type",
          "UNSUPPORTED_ENTRY_TYPE"
        );
      }
    }

    // Live quota enforcement — declared sizes are checked before any
    // decompression work happens for this entry.
    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new ApiError(
        413,
        "File too large in archive",
        "ENTRY_TOO_LARGE"
      );
    }

    if (
      isHtmlName(rawName) &&
      entry.uncompressedSize > limits.maxHtmlBytes
    ) {
      throw new ApiError(
        413,
        "HTML file too large in archive",
        "HTML_TOO_LARGE"
      );
    }

    totalBytes += entry.uncompressedSize;

    if (totalBytes > limits.maxExtractBytes) {
      throw new ApiError(
        413,
        "Archive expands beyond the total size limit",
        "EXTRACT_LIMIT_EXCEEDED"
      );
    }

    const target = path.join(destDir, ...segments);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const stream = await openStream(zipfile, entry);
    const out = fsSync.createWriteStream(target, {
      flags: "wx",
      mode: 0o600
    });

    await pipeline(stream, out);
  }
}
