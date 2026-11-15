// Preview engine tests: multi-file static serving, MIME allowlist, CSP
// sandbox headers, path-safety denials, and cross-project isolation.

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

// Raw HTTP GET that does NOT normalize the request path the way
// fetch/undici does — needed to verify server-side traversal rejection.
function rawGet(base, requestPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      { host: url.hostname, port: url.port, path: requestPath, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f0300050201c9a9e5ee" +
    "0000000049454e44ae426082",
  "hex"
);

const INDEX_HTML =
  '<!DOCTYPE html><html><head>' +
  '<link rel="stylesheet" href="css/style.css">' +
  '<script src="js/app.js" defer></script>' +
  '</head><body><h1 id="t">Home</h1><a href="page1.html">next</a>' +
  '<img src="images/logo.png" alt="logo">' +
  '</body></html>';

const CSS = "body { background: #def; color: #123; }";
const JS = "window.addEventListener('load', () => { document.getElementById('t').textContent = 'loaded'; });";

let server;
let projectId;
let legacyId;

before(async () => {
  server = await startServer();

  const zip = filesZip([
    { name: "index.html", data: INDEX_HTML },
    { name: "css/style.css", data: CSS },
    { name: "js/app.js", data: JS },
    { name: "images/logo.png", data: PNG_BYTES },
    { name: "fonts/example.woff2", data: Buffer.from("wOF2", "utf8") },
    { name: "page1.html", data: "<html><body><a href=\"index.html\">home</a></body></html>" },
    { name: "data/data.json", data: "{\"ok\":true}" },
    { name: "docs/notes.txt", data: "notes" },
    { name: "tool.exe", data: "MZfake" }
  ]);

  const fd = new FormData();
  fd.set("name", "Rich");
  fd.set("file", new Blob([zip]), "rich.zip");
  const r = await server.api("/api/projects", { method: "POST", body: fd });

  assert.equal(r.status, 201, "setup: zip project created");
  projectId = r.json.id;

  // Legacy-style single-HTML project (JSON path, root layout).
  const r2 = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Legacy", html: "<html><body>legacy</body></html>" })
  });
  assert.equal(r2.status, 201, "setup: legacy project created");
  legacyId = r2.json.id;
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

test("serves the entry page with sandbox CSP and nosniff", async () => {
  const res = await server.preview(`/p/${projectId}/`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");

  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /sandbox allow-scripts allow-forms/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /font-src 'self' data: https: http:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'self'/);

  // Sandboxed (opaque-origin) documents can only load CORS-mode
  // subresources such as web fonts when the server approves any origin.
  assert.equal(res.headers.get("access-control-allow-origin"), "*");

  assert.equal(await res.text(), INDEX_HTML);
});

test("serves CSS, JS, images, fonts, JSON, text with correct MIME types", async () => {
  const cases = [
    ["/css/style.css", CSS, "text/css; charset=utf-8"],
    ["/js/app.js", JS, "text/javascript; charset=utf-8"],
    ["/images/logo.png", null, "image/png"],
    ["/fonts/example.woff2", "wOF2", "font/woff2"],
    ["/data/data.json", '{"ok":true}', "application/json; charset=utf-8"],
    ["/docs/notes.txt", "notes", "text/plain; charset=utf-8"],
    ["/page1.html", '<html><body><a href="index.html">home</a></body></html>', "text/html; charset=utf-8"]
  ];

  for (const [target, body, mime] of cases) {
    const res = await server.preview(`/p/${projectId}${target}`);

    assert.equal(res.status, 200, target);
    assert.equal(res.headers.get("content-type"), mime, target);

    if (body !== null) {
      assert.equal(await res.text(), body, target);
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(buf, PNG_BYTES, target);
    }
  }
});

test("serves SVG as an image type", async () => {
  const zip = filesZip([
    { name: "index.html", data: INDEX_HTML },
    { name: "icon.svg", data: "<svg xmlns='http://www.w3.org/2000/svg'></svg>" }
  ]);

  const fd = new FormData();
  fd.set("name", "Svg");
  fd.set("file", new Blob([zip]), "svg.zip");
  const created = await server.api("/api/projects", { method: "POST", body: fd });
  assert.equal(created.status, 201);

  const res = await server.preview(`/p/${created.json.id}/icon.svg`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
});

test("redirects /p/{id} to the trailing-slash URL", async () => {
  const res = await server.preview(`/p/${projectId}`, { redirect: "manual" });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/p/${projectId}/`);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("redirects the entry URL when the entry is not index.html", async () => {
  const zip = filesZip([{ name: "docs/page.html", data: "<html><body>solo</body></html>" }]);

  const fd = new FormData();
  fd.set("name", "Solo");
  fd.set("file", new Blob([zip]), "solo.zip");
  const created = await server.api("/api/projects", { method: "POST", body: fd });
  assert.equal(created.status, 201);
  assert.equal(created.json.entryPoint, "docs/page.html");

  const res = await server.preview(`/p/${created.json.id}/`, { redirect: "manual" });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/p/${created.json.id}/docs/page.html`);

  const target = await server.preview(`/p/${created.json.id}/docs/page.html`);
  assert.equal(target.status, 200);
  assert.equal(await target.text(), "<html><body>solo</body></html>");
});

test("HEAD requests return headers without a body", async () => {
  const res = await server.preview(`/p/${projectId}/css/style.css`, { method: "HEAD" });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await res.text(), "");
});

test("returns 404 for missing resources, directories and unknown extensions", async () => {
  const cases = [
    `/p/${projectId}/missing.css`,
    `/p/${projectId}/js/`,
    `/p/${projectId}/js`, // directory without trailing slash
    `/p/${projectId}/tool.exe`, // not on the MIME allowlist
    `/p/${projectId}/notes` // no extension
  ];

  for (const target of cases) {
    const res = await server.preview(target);
    assert.equal(res.status, 404, target);
    assert.equal(await res.text(), "Not Found", target);
  }
});

test("blocks traversal, encoding tricks, dotfiles and metadata", async () => {
  const cases = [
    `/p/${projectId}/../${projectId}/meta.json`,
    `/p/${projectId}/%2e%2e%2fmeta.json`,
    `/p/${projectId}/%2e%2e/meta.json`,
    `/p/${projectId}/..%2fmeta.json`,
    `/p/${projectId}/%252e%252e%252fmeta.json`,
    `/p/${projectId}/css/%2e%2e%2f%2e%2e%2fmeta.json`,
    `/p/${projectId}/%5c..%5cmeta.json`,
    `/p/${projectId}/..%5cmeta.json`,
    `/p/${projectId}/meta.json`,
    `/p/${projectId}/.env`,
    `/p/${projectId}/.git/config`,
    `/p/${projectId}/js/%2e%2e/meta.json`,
    `/p/${projectId}/js/..%2f..%2fmeta.json`,
    `/p/${projectId}/data%2fdata.json`, // encoded slash is not a separator
    `/p/${projectId}/js%3Fevil`, // encoded query char in segment
    `/p/${projectId}/js/app.js%00.png`,
    `/p/${projectId}/js/app.js:${"x"}`, // colon (ADS style)
    `/p/${legacyId}/meta.json`,
    `/p/${legacyId}/.env`
  ];

  for (const target of cases) {
    const res = await server.preview(target);
    assert.equal(res.status, 404, target);
  }
});

test("serves legacy v0.2.0 root-layout projects and protects their metadata", async () => {
  const res = await server.preview(`/p/${legacyId}/`);

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<html><body>legacy</body></html>");
});

test("rejects raw dot-segment traversal sent without URL normalization", async () => {
  // fetch() normalizes "/../" client-side, so raw sockets are required to
  // verify the server itself refuses traversal paths (curl/other clients).
  const cases = [
    `/p/${projectId}/../${legacyId}/css/style.css`,
    `/p/${legacyId}/../${projectId}/js/app.js`,
    `/p/${projectId}/../../p/${legacyId}/`,
    `/p/${projectId}/../${legacyId}/meta.json`,
    `/p/${projectId}/css/../meta.json`
  ];

  for (const target of cases) {
    const res = await rawGet(server.previewBase, target);
    assert.equal(res.status, 404, target);
    assert.equal(res.body, "Not Found", target);
  }
});

test("perserved zip layout keeps nested directories intact", async () => {
  const cssOnDisk = await fs.readFile(
    path.join(server.dataDir, projectId, "versions", "1", "css", "style.css"),
    "utf8"
  );
  assert.equal(cssOnDisk, CSS);
});
