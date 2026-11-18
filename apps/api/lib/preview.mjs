// Preview server: serves stored project files to unauthenticated visitors
// on a dedicated port/origin.
//
// Security model (v0.3.0):
// - Everything under a project is untrusted user content.
// - CSP "sandbox allow-scripts allow-forms" gives every preview document an
//   opaque origin: uploaded scripts cannot touch the preview server's own
//   origin, cookies, or storage. (The platform workbench must never share
//   this origin; public deployment requires a dedicated preview origin —
//   see docs/KNOWN_LIMITATIONS.md.)
// - CSP allowlist: same-origin subresources + data: URIs only; external
//   network requests, plugins, base hijacking and workers (incl. service
//   workers) are blocked.
// - Path safety on every request: URL decoding per segment, rejection of
//   traversal/dotfiles/backslashes/colons/control chars, symlink checks on
//   every path component, meta.json and dotfiles always denied, MIME
//   allowlist for served types (unknown extensions → 404).

import fs from "node:fs/promises";
import fsSync from "node:fs";
import { isValidSegment, safeJoin } from "./pathsafety.mjs";
import { inspectAxureProject, renderNavPage } from "./axure.mjs";
import { createCloudflareAccessAuth } from "./cloudflare-access.mjs";

const PREVIEW_RE = /^\/p\/([0-9a-f-]{36})(\/.*)?$/;

// RC5 gated share route: /s/{shareId}.{secret}(/{path}). The secret rides
// in the path so relative subresource URLs (CSS/JS/img/fonts inside the
// prototype) resolve against the same token-protected prefix — every asset
// request is re-validated server-side, there is no entry-page-only guard.
const SHARE_RE = /^\/s\/([0-9a-f]{16})\.([A-Za-z0-9_-]{43})(\/.*)?$/;

// Strict allowlist — anything not listed is refused (executables, wasm,
// server-side templates, archives, ...).
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg"
};

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Sandboxed preview documents have opaque origins: without a CORS header,
  // CORS-mode subresources (web fonts) can never load, even from the same
  // project. Static preview assets are public and GET-only, so ACAO:* is
  // safe and keeps sandbox isolation intact.
  "Access-Control-Allow-Origin": "*",
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms; " +
    "default-src 'none'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self' data: https: http:; " +
    "connect-src 'self'; " +
    "media-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'"
};

// Platform-provided safe-preview navigation page for Axure exports. It is
// PLATFORM UI but still served on the untrusted preview origin, so it is
// sandboxed like every other preview document (opaque origin, no
// same-origin privileges) and contains no secrets. frame-src 'self' means
// "same origin as the preview server" — it is NOT scoped to a single
// project UUID; the project scoping comes from the code, which only ever
// assigns iframe URLs from this project's own rendered page list (and
// sandboxed frames cannot read cross-project responses regardless).
const NAV_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "sandbox allow-scripts; " +
    "default-src 'none'; " +
    "script-src 'unsafe-inline'; " +
    "style-src 'unsafe-inline'; " +
    "frame-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'none'; " +
    "frame-ancestors 'none'"
};

function notFound(res) {
  res.writeHead(404);
  res.end("Not Found");
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end();
}

// Decodes and validates one raw path segment. Returns null when unsafe.
function decodeSegment(raw) {
  let segment;

  try {
    segment = decodeURIComponent(raw);
  } catch {
    return null; // malformed encoding
  }

  if (!isValidSegment(segment, { allowDotfiles: false })) {
    return null;
  }

  if (segment === "meta.json") {
    return null; // project metadata is never served
  }

  return segment;
}

export function createPreviewHandler({ store, config = {}, previewTickets = null }) {
  // Optional public staging /p/ gate: cryptographically verify Cloudflare
  // Access on every private preview request, including assets and redirects.
  // The share capability URL /s/ is separately protected by its token.
  const requirePreviewAccess = config.stagingPublicPreview === true;
  const previewAccess = requirePreviewAccess
    ? createCloudflareAccessAuth(config)
    : null;
  async function lookupProjectDir(id) {
    const meta = await store.readRawMeta(id);

    if (!meta) {
      return null;
    }

    const entry = await store.currentVersionEntry(id, meta);
    return store.versionSourceDir(id, entry);
  }

  // Lstat-walks every path component to reject symlinked directories/files.
  async function resolveSafeFile(dir, segments) {
    const target = safeJoin(dir, segments);

    if (!target) {
      return null;
    }

    let stat = null;

    for (let i = 1; i <= segments.length; i++) {
      const partial = safeJoin(dir, segments.slice(0, i));

      let lstat;

      try {
        lstat = await fs.lstat(partial);
      } catch {
        return null;
      }

      if (lstat.isSymbolicLink()) {
        return null;
      }

      if (i === segments.length) {
        stat = lstat;
      }
    }

    if (!stat || !stat.isFile()) {
      return null;
    }

    return { target, size: stat.size };
  }

  async function serveFile(res, dir, segments, { headOnly = false } = {}) {
    const mime = MIME_TYPES[extOf(segments[segments.length - 1])];

    if (!mime) {
      return notFound(res); // extension not on the allowlist
    }

    const file = await resolveSafeFile(dir, segments);

    if (!file) {
      return notFound(res);
    }

    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": mime,
      "Content-Length": file.size
    });

    if (headOnly) {
      return res.end();
    }

    const stream = fsSync.createReadStream(file.target);

    stream.on("error", () => {
      if (!res.headersSent) {
        notFound(res);
      } else {
        res.destroy(); // raced with a deletion; nothing else to do
      }
    });

    stream.pipe(res);
  }

  async function serveEntry(res, basePath, dir, entryPoint, { headOnly = false }) {
    if (entryPoint !== "index.html") {
      return redirect(res, `${basePath}/${encodeURI(entryPoint)}`);
    }

    return serveFile(res, dir, ["index.html"], { headOnly });
  }

  // Shared serving core for /p/{id}/... and /s/{token}/...: resolves the
  // current version directory for `id`, serves the Axure nav page or the
  // requested file. All path-safety rules are identical on both routes.
  async function serveProjectPath(res, id, basePath, rest, { headOnly = false } = {}) {
    const dir = await lookupProjectDir(id);

    if (!dir) {
      return notFound(res);
    }

    if (rest === "/") {
      const meta = await store.readRawMeta(id);
      const entry = await store.currentVersionEntry(id, meta);
      const sourceDir = store.versionSourceDir(id, entry);

      // Axure exports land on the platform safe-preview directory page;
      // the native index.html player stays reachable at its plain URL
      // ({base}/index.html) for debugging. Everything else — non-Axure
      // projects and Axure exports without business pages — keeps the
      // RC2 entry behavior unchanged.
      let axure = null;

      try {
        axure = await inspectAxureProject(sourceDir);
      } catch (err) {
        console.error("Preview axure-inspect error:", err?.message ?? err);
        axure = null;
      }

      if (axure && axure.isAxure && axure.pages.length > 0) {
        const html = renderNavPage(basePath, axure.pages);
        res.writeHead(200, {
          ...NAV_HEADERS,
          "Content-Length": Buffer.byteLength(html)
        });
        if (headOnly) {
          return res.end();
        }
        return res.end(html);
      }

      return await serveEntry(res, basePath, dir, entry.entryPoint, { headOnly });
    }

    // Split RAW path (literal "/" only), then decode each segment —
    // %2F can never introduce new separators and %2e%2e cannot traverse.
    const rawSegments = rest.slice(1).split("/");

    if (rawSegments[rawSegments.length - 1] === "") {
      return notFound(res); // no directory listings/indexes
    }

    const segments = [];

    for (const raw of rawSegments) {
      const segment = decodeSegment(raw);

      if (!segment) {
        return notFound(res);
      }

      segments.push(segment);
    }

    return await serveFile(res, dir, segments, { headOnly });
  }

  // Gated share access: validates the token against fresh meta on EVERY
  // request (entry page, HTML pages, and each static subresource). Any
  // failure is an indistinguishable 404. Root-document requests update the
  // lightweight access stats.
  async function handleShareRequest(req, res, match, { headOnly }) {
    const [, shareId, secret, rest] = match;
    const basePath = `/s/${shareId}.${secret}`;

    if (!rest) {
      // Bare token — normalize to the trailing-slash share URL.
      return redirect(res, `${basePath}/`);
    }

    // RC8: administrator-issued short-lived tickets use the same /s URL
    // shape as shares, but live only in process memory (no persistent share
    // records / no stats). The Cloudflare edge allows /s by path; each
    // resource must still prove its bearer capability here.
    const ephemeral = config.stagingPublicPreview && previewTickets
      ? previewTickets.validate(shareId, secret)
      : null;
    if (ephemeral) {
      try {
        const meta = await store.readRawMeta(ephemeral.projectId);
        if (!meta || meta.previewEnabled === false) return notFound(res);
        return await serveProjectPath(
          res, ephemeral.projectId, basePath, rest, { headOnly }
        );
      } catch (err) {
        console.error("Temporary preview error:", err?.message ?? err);
        return notFound(res);
      }
    }

    let verdict;

    try {
      verdict = await store.validateShare(shareId, secret);
    } catch (err) {
      console.error("Share validation error:", err?.message ?? err);
      return notFound(res);
    }

    if (!verdict) {
      return notFound(res);
    }

    if (verdict.reason) {
      // Located but denied — record the outcome without counting a visit.
      try {
        await store.recordShareAccess(shareId, verdict.reason);
      } catch {}
      return notFound(res);
    }

    if (rest === "/" && req.method === "GET") {
      // One share visit = one root-document request. Iframe page navigations
      // and static assets are NOT counted (they use deeper paths).
      try {
        await store.recordShareAccess(shareId, "ok");
      } catch {}
    }

    try {
      return await serveProjectPath(res, verdict.projectId, basePath, rest, {
        headOnly
      });
    } catch (err) {
      console.error("Share serve error:", err?.message ?? err);
      return notFound(res);
    }
  }

  return async function handle(req, res) {
    const method = req.method === "HEAD" ? "GET" : req.method;
    const headOnly = req.method === "HEAD";
    const rawPath = (req.url || "/").split("?")[0];

    // Reject dot-segments on the RAW request before any URL normalization:
    // "/a/../b" must not silently resolve to a different in-store path.
    if (/(?:^|\/)\.\.?(?:$|[/?#])/.test(rawPath)) {
      return notFound(res);
    }

    const pathname = new URL(req.url || "/", "http://localhost").pathname;

    const shareMatch = SHARE_RE.exec(pathname);

    if (shareMatch) {
      if (method !== "GET") {
        return notFound(res);
      }

      return await handleShareRequest(req, res, shareMatch, { headOnly });
    }

    const match = PREVIEW_RE.exec(pathname);

    if ((method !== "GET" && method !== "HEAD") || !match) {
      return notFound(res);
    }

    const id = match[1];
    const rest = match[2];

    // Do not make the UUID an authorization credential when /p is exposed
    // through the staging hostname. Cloudflare Access at the edge is not
    // enough: direct-to-origin requests must also fail without a valid JWT.
    // Return an indistinguishable 404 and never use the admin bearer token
    // to authorize prototype execution.
    if (requirePreviewAccess &&
        !(await previewAccess.authorized(req))) {
      return notFound(res);
    }

    try {
      const meta = await store.readRawMeta(id);

      if (!meta) {
        return notFound(res);
      }

      // RC5: server-side preview gate. A disabled project returns the same
      // 404 for its entry page AND every static resource (and for the bare
      // canonical redirect) — hiding links in the workbench alone would not
      // stop direct access.
      if (meta.previewEnabled === false) {
        return notFound(res);
      }

      if (!rest) {
        // Bare project id — normalize to the trailing-slash preview URL.
        return redirect(res, `/p/${id}/`);
      }

      return await serveProjectPath(res, id, `/p/${id}`, rest, { headOnly });
    } catch (err) {
      console.error("Preview error:", err?.message ?? err);
      return notFound(res);
    }
  };
}

function extOf(name) {
  const dot = name.lastIndexOf(".");

  if (dot <= 0) {
    return "";
  }

  return name.slice(dot).toLowerCase();
}
