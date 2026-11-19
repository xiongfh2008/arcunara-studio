// RC15 — read-only, versioned file difference report.
//
// Does NOT parse or execute any uploaded HTML/JS. It hashes unchanged-size
// candidates only to distinguish edits from identical files; file sizes
// detect other changes. Never includes source bodies, metadata or secrets.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ApiError } from "./httputil.mjs";
import { walkFiles } from "./entrypoint.mjs";

const MAX_FILES_PER_VERSION = 6000;
const MAX_SCAN_BYTES_PER_VERSION = 160 * 1024 * 1024;

function isUserFile(rel) {
  return rel.split("/").every(part =>
    Boolean(part) && !part.startsWith(".") && part.toLowerCase() !== "meta.json"
  );
}

async function inventory(dir) {
  const names = (await walkFiles(dir)).filter(isUserFile);
  if (names.length > MAX_FILES_PER_VERSION) {
    throw new ApiError(413,"Too many files to compare","DIFF_FILE_LIMIT");
  }
  const output = new Map();
  let bytes = 0;
  for (const rel of names) {
    const filename = path.join(dir,...rel.split("/"));
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    bytes += stat.size;
    if (bytes > MAX_SCAN_BYTES_PER_VERSION) {
      throw new ApiError(413,"Versions are too large to compare","DIFF_SIZE_LIMIT");
    }
    output.set(rel,{size:stat.size,filename});
  }
  return output;
}

async function digest(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function compareProjectVersions(store,projectId,fromVersion,toVersion) {
  if (![fromVersion,toVersion].every(v=>Number.isSafeInteger(v) && v>=1)) {
    throw new ApiError(400,"Invalid version parameters","INVALID_VERSION");
  }
  const meta=await store.readRawMeta(projectId);
  if (!meta) throw new ApiError(404,"Not Found","PROJECT_NOT_FOUND");
  if (meta.lifecycleState === "trashed") {
    throw new ApiError(409,"Project is in trash","PROJECT_TRASHED");
  }
  const current=await store.currentVersionEntry(projectId,meta);
  const versions=Array.isArray(meta.versions)?meta.versions:[current];
  const from=versions.find(v=>v.version===fromVersion);
  const to=versions.find(v=>v.version===toVersion);
  if (!from || !to) {
    throw new ApiError(404,"Version not found","VERSION_NOT_FOUND");
  }
  const fromFiles=await inventory(store.versionSourceDir(projectId,from));
  const toFiles=fromVersion===toVersion
    ? fromFiles
    : await inventory(store.versionSourceDir(projectId,to));
  const added=[],removed=[],changed=[];
  let unchanged=0;
  const allPaths=[...new Set([...fromFiles.keys(),...toFiles.keys()])].sort();
  for (const rel of allPaths) {
    const a=fromFiles.get(rel),b=toFiles.get(rel);
    if (!a) { added.push({path:rel,bytes:b.size}); continue; }
    if (!b) { removed.push({path:rel,bytes:a.size}); continue; }
    if (fromVersion===toVersion) {unchanged++;continue;}
    if (a.size!==b.size || await digest(a.filename)!==await digest(b.filename)) {
      changed.push({path:rel,fromBytes:a.size,toBytes:b.size});
    } else {
      unchanged++;
    }
  }
  return {
    projectId,
    fromVersion,
    toVersion,
    added, removed, changed,
    unchangedCount:unchanged,
    counts:{added:added.length,removed:removed.length,changed:changed.length,unchanged},
    readOnly:true,
    method:"sha256-for-equal-size-files",
    currentVersion:current.version
  };
}
