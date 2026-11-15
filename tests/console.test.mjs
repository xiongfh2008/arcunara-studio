// Internal workbench (/console) and preview-link generation tests.
//
// Covers the three deployment modes of ARCU_PREVIEW_PUBLIC_BASE_URL:
//   - unset: links built from same-host + the ACTUAL bound preview port
//     (which is ephemeral in tests — proving listen address ≠ link address)
//   - Docker host mapping / SSH forwarding: absolute base injected
//   - future dedicated preview origin: absolute base injected, normalized
// Plus: no credential material on workbench or preview pages, invalid
// configurations refuse to start, and the URL builder never touches tokens.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

test("serves the workbench page without a token on the API origin", async () => {
  const r = await server.api("/console", { token: null });

  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");

  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);

  // Page must not embed any credential material (a real token literal),
  // while the `Bearer ${token}` header construction in JS is expected.
  assert.ok(
    !/Bearer\s+["'`][A-Za-z0-9_-]{8,}["'`]/.test(r.text),
    "no hardcoded bearer token literal"
  );
  assert.ok(r.json === null, "HTML body, not JSON");

  // Both placeholders are replaced.
  assert.ok(!r.text.includes("__ARCU_PREVIEW_PORT__"), "port placeholder replaced");
  assert.ok(!r.text.includes("__ARCU_PREVIEW_BASE__"), "base placeholder replaced");
});

test("default mode injects null base and the actual bound preview port", async () => {
  const r = await server.api("/console", { token: null });

  assert.match(r.text, /window\.__PREVIEW_BASE__ = null;/, "no public base configured");

  const expectedPort = new URL(server.previewBase).port;
  assert.match(
    r.text,
    new RegExp(`window\\.__PREVIEW_PORT__ = ${expectedPort};`),
    "injected port is the actual bound preview port, not the configured (ephemeral) one"
  );

  // The URL builder never references the admin token.
  const builder = /function previewUrlFor\(id\) \{([\s\S]*?)\n\}/.exec(r.text);
  assert.ok(builder, "previewUrlFor found");
  assert.ok(!/token/i.test(builder[1]), "URL builder does not touch tokens");
});

test("docker mode injects the host-mapped preview base URL", async () => {
  const custom = await startServer({
    ARCU_PREVIEW_PUBLIC_BASE_URL: "http://127.0.0.1:28089"
  });

  try {
    const r = await custom.api("/console", { token: null });
    assert.match(
      r.text,
      /window\.__PREVIEW_BASE__ = "http:\/\/127\.0\.0\.1:28089";/
    );
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("dedicated preview origin is injected normalized (no trailing slash)", async () => {
  const custom = await startServer({
    ARCU_PREVIEW_PUBLIC_BASE_URL: "https://preview.example.com/"
  });

  try {
    const r = await custom.api("/console", { token: null });
    assert.match(
      r.text,
      /window\.__PREVIEW_BASE__ = "https:\/\/preview\.example\.com";/
    );
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("base URL path prefixes are preserved and normalized", async () => {
  const custom = await startServer({
    ARCU_PREVIEW_PUBLIC_BASE_URL: "https://example.com/preview/"
  });

  try {
    const r = await custom.api("/console", { token: null });
    assert.match(
      r.text,
      /window\.__PREVIEW_BASE__ = "https:\/\/example\.com\/preview";/
    );
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("invalid base URLs refuse to start", async () => {
  const cases = ["ftp://preview.example.com", "not-a-url", "http://user:pass@h.com"];

  for (const value of cases) {
    await assert.rejects(
      () => startServer({ ARCU_PREVIEW_PUBLIC_BASE_URL: value }),
      /ARCU_PREVIEW_PUBLIC_BASE_URL/,
      value
    );
  }
});

test("preview pages never expose the admin token", async () => {
  const zip = filesZip([{ name: "index.html", data: "<html><body>ok</body></html>" }]);

  const fd = new FormData();
  fd.set("name", "TokenLeak");
  fd.set("file", new Blob([zip]), "x.zip");
  const created = await server.api("/api/projects", { method: "POST", body: fd });
  assert.equal(created.status, 201);

  const res = await server.preview(`/p/${created.json.id}/`);
  const body = await res.text();

  assert.ok(!body.includes(server.token), "no token in preview body");
  for (const [name] of res.headers) {
    assert.ok(!res.headers.get(name).includes(server.token), `no token in header ${name}`);
  }
});

test("workbench is not served on the preview origin", async () => {
  const res = await server.preview("/console");
  assert.equal(res.status, 404);
});
