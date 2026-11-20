// RC18C — local-only input validation/staging for Zee-RP RP/1 sources.
// No remote fetch, uploads, shell invocation or rendering of user HTML/JS.
// The API process never imports this module.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";

const MAX_PAGES = 50;
const MAX_NODES = 3000;
const MAX_IMAGES = 500;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 96 * 1024 * 1024;
const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const ID = /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NEEDS_CHILDREN = new Set(["box", "card"]);

function error(message, code = "NATIVE_INPUT_INVALID") {
  const out = new Error(message);
  out.code = code;
  return out;
}

function isObject(obj) {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj);
}

export function validateNativeSource(spec) {
  if (!isObject(spec) || spec.language !== "rp/1" || spec.target !== 9 ||
      !Array.isArray(spec.pages) || spec.pages.length < 1 || spec.pages.length > MAX_PAGES) {
    throw error("Expected RP/1 target=9 JSON with 1 to 50 pages");
  }
  const pages = new Set();
  const images = new Set();
  let widgets = 0;
  for (const page of spec.pages) {
    if (!isObject(page) || !ID.test(page.id) || pages.has(page.id) ||
        !isObject(page.root)) throw error("Malformed or duplicate RP/1 page");
    pages.add(page.id);
    const nodeIds = new Set();
    const walk = (node, depth) => {
      if (!isObject(node) || depth > 40 || typeof node.type !== "string" ||
          !ID.test(node.id) || nodeIds.has(node.id)) {
        throw error("Malformed, duplicate, or deeply nested RP/1 widget");
      }
      nodeIds.add(node.id);
      widgets++;
      if (widgets > MAX_NODES) throw error("RP/1 widget quota exceeded", "NATIVE_WIDGET_LIMIT");
      if (node.type === "image") {
        images.add(node.src);
        if (images.size > MAX_IMAGES) throw error("Too many image assets", "NATIVE_ASSET_LIMIT");
      }
      if (NEEDS_CHILDREN.has(node.type)) {
        if (node.children !== undefined && !Array.isArray(node.children)) {
          throw error("Invalid RP/1 children");
        }
        for (const child of node.children || []) walk(child, depth + 1);
      }
      if (node.type === "dynamic-panel") {
        for (const state of node.states || []) {
          if (!isObject(state) || !isObject(state.root)) throw error("Invalid panel state");
          walk(state.root, depth + 1);
        }
      }
    };
    walk(page.root, 0);
  }
  return { pages: spec.pages.length, nodes: widgets, imageSources: [...images].sort() };
}

function safeAssetPath(source) {
  if (typeof source !== "string" || source.length < 1 || source.length > 500 ||
      source.startsWith("/") || source.includes("\\") || CONTROL.test(source) ||
      source.includes("?") || source.includes("#") || /^[a-z][\w+.-]*:/i.test(source) ||
      source.startsWith("//") || !EXTENSIONS.has(path.posix.extname(source).toLowerCase())) {
    throw error("Unsafe RP/1 image path: " + String(source).slice(0, 100), "NATIVE_ASSET_PATH");
  }
  const parts = source.split("/");
  if (parts.some(segment => !segment || segment === "." || segment === ".." ||
      segment.startsWith(".") || segment.includes(":"))) {
    throw error("Image path traversal or hidden segment is not allowed", "NATIVE_ASSET_PATH");
  }
  return parts;
}

async function hashFile(p) {
  const content = await fs.readFile(p);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function inspectAsset(root, source) {
  const segments = safeAssetPath(source);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (e) {
      if (e.code === "ENOENT") throw error("Image file is missing: " + source, "NATIVE_ASSET_MISSING");
      throw e;
    }
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory()) ||
        (i === segments.length - 1 && !stat.isFile())) {
      throw error("Image path uses a symlink or special file", "NATIVE_ASSET_UNSAFE");
    }
  }
  const stats = await fs.stat(current);
  if (stats.size < 1 || stats.size > MAX_IMAGE_BYTES) {
    throw error("Image size is outside supported bounds", "NATIVE_ASSET_LIMIT");
  }
  // No image decoding here. RP/1 compiler owns format support; this stage
  // only enforces safe on-disk paths, byte limits and deterministic hashing.
  return {path:source,absolutePath:current,bytes:stats.size,sha256:await hashFile(current)};
}

export async function inspectNativeAssets(spec, assetsRoot) {
  const validated = validateNativeSource(spec);
  const root = path.resolve(assetsRoot);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw error("Asset root must be a normal directory", "NATIVE_ASSET_UNSAFE");
  }
  const files = [];
  let total = 0;
  for (const name of validated.imageSources) {
    const item = await inspectAsset(root, name);
    total += item.bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      throw error("Image assets exceed total size quota", "NATIVE_ASSET_LIMIT");
    }
    files.push(item);
  }
  return {pages:validated.pages,nodes:validated.nodes,files,totalBytes:total};
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

// Copy a RP/1 spec and only the referenced images into a fresh directory.
// Never copy arbitrary JavaScript, uploaded HTML, dotfiles or metadata.
export async function stageNativeBundle(specFile, assetsRoot, destination) {
  const specPath = path.resolve(specFile);
  const assetsDir = path.resolve(assetsRoot);
  const out = path.resolve(destination);
  if (inside(assetsDir,out) || inside(out,assetsDir) || inside(out,specPath)) {
    throw error("Output must be separate from source and asset directory", "NATIVE_OUTPUT_LOCATION");
  }
  const spec = JSON.parse(await fs.readFile(specPath,"utf8"));
  const inspected = await inspectNativeAssets(spec,assetsDir);
  const specHash = crypto.createHash("sha256")
    .update(JSON.stringify(spec)).digest("hex");
  await fs.mkdir(out,{recursive:false,mode:0o700});
  try {
    await fs.writeFile(path.join(out,"source.rp1.json"),JSON.stringify(spec,null,2)+"\n",{
      flag:"wx",mode:0o600
    });
    const files = [];
    for (const item of inspected.files) {
      const dst = path.join(out,...item.path.split("/"));
      await fs.mkdir(path.dirname(dst),{recursive:true});
      await fs.copyFile(item.absolutePath,dst,fsConstants.COPYFILE_EXCL);
      const actualHash = await hashFile(dst);
      if (actualHash !== item.sha256) throw error("Image changed while staging","NATIVE_ASSET_CHANGED");
      files.push({path:item.path,bytes:item.bytes,sha256:item.sha256});
    }
    const manifest = {
      schema:"arcunara.native-stage.v1",
      inputLanguage:"rp/1",
      nativeTarget:9,
      sourceSha256:specHash,
      assets:files,
      totalBytes:inspected.totalBytes,
      pages:inspected.pages,
      nodes:inspected.nodes,
      hostValidation:{axureRP9:"not-run",axureRP11:"not-run"}
    };
    await fs.writeFile(path.join(out,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{
      flag:"wx",mode:0o600
    });
    return {directory:out,spec:path.join(out,"source.rp1.json"),manifest};
  } catch (e) {
    await fs.rm(out,{recursive:true,force:true});
    throw e;
  }
}
