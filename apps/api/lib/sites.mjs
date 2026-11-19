// RC13: explicitly opt-in static website delivery on a separate listener.
//
// Unlike the prototype preview this intentionally permits ordinary browser JS
// and root-absolute assets. It MUST NOT be mounted under /console, /api, /p,
// /s, or a shared application origin. Projects resolve by one UUID per host:
//   {uuid}.{dedicated-site-domain}/
// Refuses symlinks, meta.json, dotfiles, unknown file types and traversal.
// No HTML is executed on the server and no uploads are handled here.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { isValidSegment, safeJoin } from "./pathsafety.mjs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MIME = Object.freeze({
  ".html":"text/html; charset=utf-8", ".htm":"text/html; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".mjs":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".txt":"text/plain; charset=utf-8", ".xml":"application/xml; charset=utf-8",
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
  ".webp":"image/webp", ".avif":"image/avif", ".gif":"image/gif",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".woff":"font/woff",
  ".woff2":"font/woff2", ".ttf":"font/ttf", ".otf":"font/otf",
  ".wasm":"application/wasm", ".mp4":"video/mp4", ".webm":"video/webm",
  ".mp3":"audio/mpeg", ".ogg":"audio/ogg", ".pdf":"application/pdf",
  ".map":"application/json; charset=utf-8"
});
const BASE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin"
});

function notFound(res) {
  res.writeHead(404, BASE_HEADERS);
  res.end("Not Found");
}

function decodeSegments(rawPath) {
  if (!rawPath.startsWith("/") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) return null;
  const raw = rawPath.split("/").slice(1);
  if (raw.length > 0 && raw.at(-1) === "") raw.pop();
  const segments = [];
  for (const part of raw) {
    let value;
    try { value = decodeURIComponent(part); } catch { return null; }
    if (!isValidSegment(value, { allowDotfiles:false }) ||
        value.toLowerCase() === "meta.json") return null;
    segments.push(value);
  }
  return segments;
}

async function safeFile(root, segments) {
  const file = safeJoin(root, segments);
  if (!file) return null;
  let final = null;
  for (let i = 1; i <= segments.length; i++) {
    const part = safeJoin(root, segments.slice(0,i));
    let st;
    try { st = await fs.lstat(part); } catch { return null; }
    if (st.isSymbolicLink()) return null;
    if (i === segments.length) final = st;
    else if (!st.isDirectory()) return null;
  }
  return final?.isFile() ? {file, bytes: final.size} : null;
}

async function sendFile(res, root, segments, headOnly) {
  const last = segments.at(-1) ?? "";
  const mime = MIME[path.extname(last).toLowerCase()];
  if (!mime) return false;
  const item = await safeFile(root,segments);
  if (!item) return false;
  res.writeHead(200,{
    ...BASE_HEADERS,
    "Content-Type":mime,
    "Content-Length":item.bytes
  });
  if (headOnly) {
    res.end();
  } else {
    const stream = fsSync.createReadStream(item.file);
    stream.on("error",()=>res.destroy());
    stream.pipe(res);
  }
  return true;
}

export function createSiteHandler({ store, config }) {
  if (!config.siteHostingEnabled || !config.siteDomain) {
    throw new Error("Static sites listener requires explicit hosting configuration");
  }
  const hosts = new RegExp(`^(${UUID})\\.${config.siteDomain.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}(?::[0-9]{1,5})?$`);
  return async function site(req,res) {
    const method = req.method;
    if (method !== "GET" && method !== "HEAD") return notFound(res);
    const host = String(req.headers.host ?? "").toLowerCase();
    const match = hosts.exec(host);
    if (!match) return notFound(res);
    const id = match[1];
    const rawPath = String(req.url ?? "/").split("?")[0];
    const segments = decodeSegments(rawPath);
    if (!segments) return notFound(res);
    try {
      const meta = await store.readRawMeta(id);
      if (!meta || meta.siteEnabled !== true || meta.lifecycleState === "trashed") return notFound(res);
      const entry = await store.currentVersionEntry(id,meta);
      const root = store.versionSourceDir(id,entry);
      const isDirectoryRequest = rawPath.endsWith("/");
      const direct = segments.length === 0
        ? ["index.html"]
        : [...segments];
      if (isDirectoryRequest && segments.length > 0) direct.push("index.html");
      if (await sendFile(res,root,direct,method==="HEAD")) return;
      if (isDirectoryRequest) return notFound(res);

      // Static SPA fallback only for navigation. Never turn failed asset
      // requests into HTML, and never allow /api/* or /s/* cross routing.
      const accept = String(req.headers.accept ?? "");
      const last = segments.at(-1) ?? "";
      if (accept.includes("text/html") &&
          !last.includes(".") &&
          !["api","s","p","console"].includes(segments[0])) {
        if (await sendFile(res,root,["index.html"],method==="HEAD")) return;
      }
      return notFound(res);
    } catch (err) {
      console.error("Static site request failed:",err?.message ?? err);
      return notFound(res);
    }
  };
}
