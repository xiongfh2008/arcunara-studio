// RC17 — read-only, authenticated project ZIP export without third-party deps.
// Uses ZIP method 0 (store) with a data descriptor, so every file is streamed
// once, not buffered or recompressed. Compatible with Windows Explorer/unzip.
// User-provided HTML/JS is never parsed or executed.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "./httputil.mjs";
import { isValidSegment } from "./pathsafety.mjs";

const MAX_EXPORT_FILES = 6000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const ZIP_UTF8_DESCRIPTOR_FLAGS = 0x0808;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01

function isUserSegment(name) {
  return isValidSegment(name, { allowDotfiles: false }) &&
    name.toLowerCase() !== "meta.json";
}

async function collectFiles(root) {
  const files = [];
  let totalBytes = 0;

  async function walk(dir, prefix) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      // Legacy-root has private meta.json; never export that or dotfiles.
      if (item.name.startsWith(".") || item.name.toLowerCase() === "meta.json") continue;
      if (!isUserSegment(item.name)) {
        throw new ApiError(409, "Unsafe export path", "EXPORT_UNSAFE_PATH");
      }
      const rel = prefix ? prefix + "/" + item.name : item.name;
      if (Buffer.byteLength(rel, "utf8") > 65535) {
        throw new ApiError(413, "Export entry path too long", "EXPORT_PATH_LIMIT");
      }
      const filename = path.join(dir, item.name);
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) {
        throw new ApiError(409, "Unsupported export entry", "EXPORT_UNSAFE_ENTRY");
      }
      if (item.isDirectory()) {
        await walk(filename, rel);
        continue;
      }
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ApiError(409, "Unsupported export entry", "EXPORT_UNSAFE_ENTRY");
      }
      totalBytes += stat.size;
      if (files.length >= MAX_EXPORT_FILES) {
        throw new ApiError(413, "Too many files to export", "EXPORT_FILE_LIMIT");
      }
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EXPORT_BYTES) {
        throw new ApiError(413, "Project version too large to export", "EXPORT_SIZE_LIMIT");
      }
      files.push({ rel, filename, size: stat.size });
    }
  }
  await walk(root, "");
  if (!files.length) {
    throw new ApiError(409, "Version contains no exportable files", "EXPORT_EMPTY");
  }
  return files;
}

function localHeader(name) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(ZIP_UTF8_DESCRIPTOR_FLAGS, 6);
  head.writeUInt16LE(0, 8); // method 0: no compression
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(ZIP_DOS_DATE, 12);
  head.writeUInt16LE(name.length, 26);
  return head;
}

function centralHeader(name, offset, size, crc) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE((3 << 8) | 20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(ZIP_UTF8_DESCRIPTOR_FLAGS, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt16LE(ZIP_DOS_DATE, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(size, 20);
  head.writeUInt32LE(size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  head.writeUInt32LE(offset, 42);
  return head;
}

async function* zipChunks(files) {
  const central = [];
  let offset = 0;

  for (const item of files) {
    const name = Buffer.from(item.rel, "utf8");
    const localOffset = offset;
    const head = localHeader(name);
    yield head;
    yield name;
    offset += head.length + name.length;

    // O_NOFOLLOW forbids a symlink at the final filename. The inventory
    // rejects symlink ancestors; all user writes are serialized by withLock.
    const flags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0);
    const file = await fs.open(item.filename, flags);
    let crc = 0;
    let bytes = 0;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== item.size) {
        throw new Error("Export file changed during streaming");
      }
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > item.size) throw new Error("Export file grew during streaming");
        crc = zlib.crc32(chunk, crc) >>> 0;
        yield chunk;
      }
    } finally {
      await file.close();
    }
    if (bytes !== item.size) throw new Error("Export file truncated during streaming");
    offset += bytes;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(bytes, 8);
    descriptor.writeUInt32LE(bytes, 12);
    yield descriptor;
    offset += descriptor.length;
    central.push(centralHeader(name, localOffset, bytes, crc), name);
  }

  const centralOffset = offset;
  for (const buffer of central) {
    yield buffer;
    offset += buffer.length;
  }
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(offset - centralOffset, 12);
  footer.writeUInt32LE(centralOffset, 16);
  yield footer;
}

// Locks the project through stream completion: a concurrent permanent delete
// or version publication cannot invalidate a source directory mid-download.
export async function exportProjectVersionZip(store, projectId, requestedVersion, res) {
  if (requestedVersion !== null && requestedVersion !== undefined &&
      (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)) {
    throw new ApiError(400, "Invalid version", "INVALID_VERSION");
  }

  return store.withLock(projectId, async () => {
    const meta = await store.readRawMeta(projectId);
    if (!meta) throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    if (meta.lifecycleState === "trashed") {
      throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
    }
    const current = await store.currentVersionEntry(projectId, meta);
    const versions = Array.isArray(meta.versions) ? meta.versions : [current];
    const entry = requestedVersion === null || requestedVersion === undefined
      ? current
      : versions.find(v => v.version === requestedVersion);
    if (!entry) throw new ApiError(404, "Version not found", "VERSION_NOT_FOUND");

    const files = await collectFiles(store.versionSourceDir(projectId, entry));
    const downloadName = "arcunara-" + projectId + "-v" + entry.version + ".zip";
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="' + downloadName + '"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });

    try {
      await pipeline(Readable.from(zipChunks(files)), res);
    } catch (err) {
      // Once ZIP headers/body are on the wire, never append an HTTP JSON
      // error into a corrupt archive. Terminate the connection instead.
      if (!res.destroyed) res.destroy(err);
      // A disconnected client is a normal lifecycle event.
    }
  });
}
