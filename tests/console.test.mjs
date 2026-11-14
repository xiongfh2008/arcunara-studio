// Internal workbench (/console) tests: served without a token on the API
// origin only, hardened CSP, and no secret material embedded in the page.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

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

  // The preview port placeholder is injected for cross-origin links.
  assert.ok(!r.text.includes("__ARCU_PREVIEW_PORT__"), "placeholder replaced");
});

test("workbench is not served on the preview origin", async () => {
  const res = await server.preview("/console");
  assert.equal(res.status, 404);
});
