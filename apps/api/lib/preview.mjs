// Preview server handler (v0.2.0 behavior).
//
// Serves stored project HTML to unauthenticated visitors on a dedicated
// port/origin. Phase C upgrades this to full multi-file static serving with
// path safety; the sandbox CSP posture is kept.

import fs from "node:fs/promises";
import path from "node:path";

const UUID_RE = /^[0-9a-f-]{36}$/;

const LEGACY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms; " +
    "default-src 'none'; " +
    "script-src 'unsafe-inline'; " +
    "style-src 'unsafe-inline'; " +
    "img-src data:"
};

export function createPreviewHandler({ store }) {
  return async function handle(req, res) {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;

    const match = /^\/p\/([0-9a-f-]{36})\/$/.exec(pathname);

    if (req.method !== "GET" || !match) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    try {
      const html = await fs.readFile(
        path.join(store.projectDir(match[1]), "index.html")
      );

      res.writeHead(200, LEGACY_HEADERS);
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  };
}
