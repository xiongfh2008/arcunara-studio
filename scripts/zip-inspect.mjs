// Read-only ZIP analyzer for vetting real-world exports before upload.
//
// Usage:  node scripts/zip-inspect.mjs <path-to-zip>
//
// Reports structure (entry counts, depth, path lengths, extensions, wrapper
// directories), quota headroom against the current default AND test-env
// limits, security pre-checks (traversal/aliasing/symlinks), and a
// sensitive-API scan of bundled JavaScript (eval/storage/fetch/SW...).
// Uses the same validation rules as the upload engine (lib/pathsafety.mjs).

import yauzl from "yauzl";
import { collisionKey, isValidSegment } from "../apps/api/lib/pathsafety.mjs";

const DEFAULTS = { maxFiles: 2000, maxExtractBytes: 80 * 1024 * 1024, maxHtmlBytes: 2 * 1024 * 1024, maxDepth: 20, maxPathLength: 256 };
const TESTENV = { maxFiles: 5000, maxExtractBytes: 128 * 1024 * 1024, maxHtmlBytes: 8 * 1024 * 1024, maxDepth: 20, maxPathLength: 256 };

const MIB = 1024 * 1024;
const fmt = (n) => (n / MIB).toFixed(2) + " MiB";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("usage: node scripts/zip-inspect.mjs <zip>");
  process.exit(1);
}

function openZip(p) {
  return new Promise((resolve, reject) =>
    yauzl.open(p, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (e, z) => (e ? reject(e) : resolve(z)))
  );
}

function nextEntry(zf) {
  return new Promise((resolve, reject) => {
    zf.once("entry", resolve);
    zf.once("end", () => resolve(null));
    zf.once("error", reject);
    zf.readEntry();
  });
}

function entryStream(zf, entry) {
  return new Promise((resolve, reject) =>
    zf.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s)))
  );
}

function streamBuffer(stream, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        stream.destroy();
        resolve(null); // too big to scan
        return;
      }
      chunks.push(c);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const JS_PATTERNS = {
  "eval(": /\beval\s*\(/g,
  "new Function": /new\s+Function\s*\(/g,
  "localStorage": /\blocalStorage\b/g,
  "sessionStorage": /\bsessionStorage\b/g,
  "document.cookie": /document\s*\.\s*cookie/g,
  "XMLHttpRequest": /\bXMLHttpRequest\b/g,
  "fetch(": /\bfetch\s*\(/g,
  "WebSocket": /\bnew\s+WebSocket\b/g,
  "serviceWorker": /\bnavigator\s*\.\s*serviceWorker\b/g,
  "document.write": /document\s*\.\s*write\s*\(/g,
};

const files = [];
const dirs = [];
const problems = [];
const usedKeys = new Map();
const jsScan = Object.fromEntries(Object.keys(JS_PATTERNS).map((k) => [k, { matches: 0, files: new Set() }]));
const extHist = new Map();
let totalBytes = 0;
let maxFile = null;
let maxHtml = null;
let maxDepth = 0;
let maxPath = { len: 0, path: "" };
let symlinkCount = 0;
let encryptedCount = 0;
let nonRegular = 0;

const zf = await openZip(zipPath).catch((e) => {
  console.error("cannot open zip:", e.message);
  process.exit(1);
});

let entry;
while ((entry = await nextEntry(zf)) !== null) {
  const raw = entry.fileName;

  if (entry.isEncrypted?.()) encryptedCount++;

  const isDir = raw.endsWith("/");
  const segments = raw.split("/");
  if (isDir) segments.pop();
  const relPath = segments.join("/");

  if (!isDir) {
    if (raw.includes("\\") || relPath.split("/").some((s) => !s || s === "." || s === ".." || !isValidSegment(s))) {
      problems.push(`UNSAFE-ISH: ${raw}`);
    }
    if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) problems.push(`ABSOLUTE: ${raw}`);
  }

  if (relPath.length > maxPath.len) maxPath = { len: relPath.length, path: relPath };
  maxDepth = Math.max(maxDepth, segments.length);

  const key = collisionKey(relPath);
  if (usedKeys.has(key) && usedPathsDifferent(usedKeys.get(key), relPath)) {
    problems.push(`COLLISION: ${usedKeys.get(key)} <-> ${relPath}`);
  }
  usedKeys.set(key, relPath);

  const mode = entry.versionMadeBy >> 8 === 3 ? (entry.externalFileAttributes >>> 16) & 0xffff : null;
  if (mode !== null && (mode & S_IFMT) === S_IFLNK) {
    symlinkCount++;
    problems.push(`SYMLINK: ${raw}`);
  } else if (mode !== null && !isDir && (mode & S_IFMT) !== S_IFREG && (mode & S_IFMT) !== 0) {
    nonRegular++;
    problems.push(`NON-REGULAR: ${raw}`);
  }

  if (isDir) {
    dirs.push(raw);
    continue;
  }

  files.push(raw);
  totalBytes += entry.uncompressedSize;

  if (!maxFile || entry.uncompressedSize > maxFile.size) {
    maxFile = { name: raw, size: entry.uncompressedSize };
  }

  const ext = (raw.lastIndexOf(".") > 0 ? raw.slice(raw.lastIndexOf(".")).toLowerCase() : "(none)");
  extHist.set(ext, (extHist.get(ext) ?? 0) + 1);

  if (/\.html?$/i.test(raw) && (!maxHtml || entry.uncompressedSize > maxHtml.size)) {
    maxHtml = { name: raw, size: entry.uncompressedSize };
  }

  if (/\.js$/i.test(raw) && entry.uncompressedSize <= 4 * MIB) {
    const stream = await entryStream(zf, entry).catch(() => null);
    if (stream) {
      const buf = await streamBuffer(stream, 4 * MIB).catch(() => null);
      if (buf) {
        const text = buf.toString("utf8");
        for (const [label, re] of Object.entries(JS_PATTERNS)) {
          const m = text.match(re);
          if (m && m.length > 0) {
            jsScan[label].matches += m.length;
            jsScan[label].files.add(raw);
          }
        }
      }
    }
  }
}
zf.close();

function usedPathsDifferent(a, b) {
  return a !== b;
}

// --- report ---------------------------------------------------------------
console.log(`=== ${zipPath.split(/[\\/]/).pop()} ===`);
console.log(`entries: ${files.length + dirs.length} (files ${files.length}, dirs ${dirs.length})`);
console.log(`total uncompressed: ${fmt(totalBytes)}`);
console.log(`largest file: ${fmt(maxFile?.size ?? 0)} — ${maxFile?.name}`);
if (maxHtml) console.log(`largest HTML: ${fmt(maxHtml.size)} — ${maxHtml.name}`);
console.log(`max depth: ${maxDepth}   max path length: ${maxPath.len} chars (${Buffer.byteLength(maxPath.path, "utf8")} bytes utf8)`);
console.log(`symlinks: ${symlinkCount}  encrypted: ${encryptedCount}  non-regular: ${nonRegular}`);

const topExt = [...extHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`extensions: ${topExt.map(([e, c]) => `${e}×${c}`).join("  ")}`);

const top = files.filter((f) => !f.includes("/"));
const hasRootIndex = files.some((f) => f === "index.html");
const topLevelDirs = new Set(files.concat(dirs).map((f) => f.split("/")[0]).filter((f) => f !== "index.html" && !f.includes(".")));
console.log(`root index.html: ${hasRootIndex ? "YES" : "no"}   top-level entries: ${files.concat(dirs).length === top.length ? "all flat" : new Set([...files, ...dirs].map((f) => f.split("/")[0])).size}`);

console.log("\n--- quota headroom ---");
for (const [label, q] of [["default", DEFAULTS], ["test-env (RC2)", TESTENV]]) {
  console.log(
    `[${label}] files ${files.length + dirs.length}/${q.maxFiles}${files.length + dirs.length > q.maxFiles ? " ✗" : " ✓"}  ` +
      `total ${fmt(totalBytes)}/${fmt(q.maxExtractBytes)}${totalBytes > q.maxExtractBytes ? " ✗" : " ✓"}  ` +
      `html ${fmt(maxHtml?.size ?? 0)}/${fmt(q.maxHtmlBytes)}${(maxHtml?.size ?? 0) > q.maxHtmlBytes ? " ✗" : " ✓"}  ` +
      `depth ${maxDepth}/${q.maxDepth}${maxDepth > q.maxDepth ? " ✗" : " ✓"}  ` +
      `path ${maxPath.len}/${q.maxPathLength}${maxPath.len > q.maxPathLength ? " ✗" : " ✓"}`
  );
}

console.log("\n--- security pre-checks ---");
console.log(`aliasing/traversal/structure problems: ${problems.length}`);
for (const p of problems.slice(0, 20)) console.log("  " + p);
if (problems.length > 20) console.log(`  … ${problems.length - 20} more`);

console.log("\n--- sensitive-API scan of bundled JS ---");
for (const [label, s] of Object.entries(jsScan)) {
  const flag = s.matches > 0 ? "⚠" : "·";
  const sample = [...s.files][0];
  console.log(`${flag} ${label.padEnd(16)} matches:${String(s.matches).padStart(5)}  files:${s.files.size}${sample ? `  e.g. ${sample}` : ""}`);
}
