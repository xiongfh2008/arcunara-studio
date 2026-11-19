// API integration & v0.2.0 regression tests.
//
// The server runs as a real child process (see tests/helpers/harness.mjs)
// against a throwaway temp directory. Legacy behavior is asserted where the
// v0.2.0 contract is preserved; deviations are intentional v0.3.0 additions
// and are noted inline.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HTML_A =
  "<!DOCTYPE html><html><head><title>Alpha</title></head><body><h1>Alpha page</h1></body></html>";
const HTML_B = "<html><body><p>Beta page</p></body></html>";

let server;
let createdA;
let createdB;

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

function post(token, payload, contentType = "application/json") {
  return server.api("/api/projects", {
    method: "POST",
    token,
    headers: { "content-type": contentType },
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

test("GET /health is public and reports the service version", async () => {
  const r = await server.api("/health");

  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    ok: true,
    service: "arcunara-studio-dev",
    version: "0.3.0"
  });
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("rejects /api/ requests without a bearer token", async () => {
  const r = await server.api("/api/projects", { token: null });

  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "Unauthorized" });
});

test("rejects a wrong bearer token", async () => {
  const r = await server.api("/api/projects", { token: "wrong-token" });

  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "Unauthorized" });
});

test("non-API paths stay unauthorized even with a valid token", async () => {
  const r = await server.api("/", { token: server.token });

  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "Unauthorized" });
});

test("valid token reads the initially empty project list", async () => {
  const r = await server.api("/api/projects");

  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { projects: [] });
});

test("creates a project from legacy JSON and returns metadata", async () => {
  const r = await post(server.token, { name: "Alpha", html: HTML_A });

  assert.equal(r.status, 201);
  assert.match(r.json.id, UUID_RE);
  assert.equal(r.json.name, "Alpha");
  assert.equal(r.json.previewPath, `/p/${r.json.id}/`);
  assert.ok(!Number.isNaN(Date.parse(r.json.createdAt)));
  assert.equal(r.json.currentVersion, 1);
  assert.equal(r.json.entryPoint, "index.html");
  assert.equal(r.json.fileCount, 1);
  assert.equal(r.json.totalSize, Buffer.byteLength(HTML_A));

  createdA = r.json;
});

test("creates a second project with a later timestamp", async () => {
  await delay(50);

  const r = await post(server.token, { name: "Beta", html: HTML_B });

  assert.equal(r.status, 201);
  assert.match(r.json.id, UUID_RE);
  assert.notEqual(r.json.id, createdA.id);

  createdB = r.json;
});

test("rejects invalid project payloads with 400", async () => {
  const cases = [
    ["missing name", { html: HTML_A }],
    ["blank name", { name: "   ", html: HTML_A }],
    ["name over 100 chars", { name: "x".repeat(101), html: HTML_A }],
    ["non-string name", { name: 42, html: HTML_A }],
    ["html without <html tag", { name: "NoTag", html: "<body>hello</body>" }],
    ["non-string html", { name: "NoHtml", html: 123 }],
    ["html over 180000 bytes", { name: "TooBig", html: `<html>${"x".repeat(180000)}` }]
  ];

  for (const [label, payload] of cases) {
    const r = await post(server.token, payload);

    assert.equal(r.status, 400, label);
    assert.equal(r.json.error, "Invalid name or HTML", label);
  }
});

test("accepts HTML of exactly 180000 bytes (boundary)", async () => {
  const html = `<html>${"x".repeat(179994)}`;
  assert.equal(Buffer.byteLength(html), 180000);

  const r = await post(server.token, { name: "BoundaryHtml", html });

  assert.equal(r.status, 201);
});

test("accepts application/json with a charset suffix", async () => {
  const r = await post(
    server.token,
    { name: "Charset", html: HTML_B },
    "application/json; charset=utf-8"
  );

  assert.equal(r.status, 201);
});

test("rejects malformed JSON bodies with 400", async () => {
  const r = await post(server.token, "{not-json");

  assert.equal(r.status, 400);
  assert.equal(r.json.error, "Invalid JSON");
});

test("rejects non-JSON content types with 415", async () => {
  const r = await post(
    server.token,
    JSON.stringify({ name: "X", html: HTML_A }),
    "text/plain"
  );

  assert.equal(r.status, 415);
  assert.equal(r.json.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("rejects JSON bodies over the 256 KiB limit with 413", async () => {
  const payload = JSON.stringify({
    name: "TooLarge",
    html: `<html>${"a".repeat(300 * 1024)}`
  });

  const r = await post(server.token, payload);

  assert.equal(r.status, 413);
  assert.equal(r.json.error, "Request too large");
});

test("accepts a JSON request body of exactly 256 KiB (boundary)", async () => {
  const payload = JSON.stringify({ name: "BoundaryBody", html: HTML_A });
  const padded = payload + " ".repeat(256 * 1024 - Buffer.byteLength(payload));
  assert.equal(Buffer.byteLength(padded), 256 * 1024);

  const r = await post(server.token, padded);

  assert.equal(r.status, 201);
});

test("lists projects newest first with enriched metadata", async () => {
  assert.ok(createdB.createdAt > createdA.createdAt, "timestamps differ");

  const r = await server.api("/api/projects");

  assert.equal(r.status, 200);

  const projects = r.json.projects;
  const first = projects.findIndex((p) => p.id === createdB.id);
  const second = projects.findIndex((p) => p.id === createdA.id);

  assert.ok(first !== -1 && second !== -1, "both projects listed");
  assert.ok(first < second, "newest project first");

  for (const p of projects) {
    assert.deepEqual(
      Object.keys(p).sort(),
      ["archivedAt", "createdAt", "currentVersion", "fileCount", "id", "lifecycleState", "name", "previewEnabled", "totalSize", "trashedAt", "updatedAt"]
    );
    assert.equal(p.currentVersion, 1);
    assert.equal(p.fileCount, 1);
    assert.ok(Number.isFinite(p.totalSize));
  }
});

test("returns project details with preview path", async () => {
  const r = await server.api(`/api/projects/${createdA.id}`);

  assert.equal(r.status, 200);
  assert.equal(r.json.id, createdA.id);
  assert.equal(r.json.name, "Alpha");
  assert.equal(r.json.previewPath, `/p/${createdA.id}/`);
  assert.equal(r.json.entryPoint, "index.html");
  assert.equal(r.json.versionCount, 1);
});

test("unknown project id returns 404", async () => {
  const r = await server.api(`/api/projects/${crypto.randomUUID()}`);

  assert.equal(r.status, 404);
  assert.equal(r.json.code, "PROJECT_NOT_FOUND");
});

test("malformed project id returns 404", async () => {
  const r = await server.api("/api/projects/not-a-uuid");

  assert.equal(r.status, 404);
});

test("preview serves the stored HTML with sandbox headers", async () => {
  const res = await server.preview(`/p/${createdA.id}/`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");

  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /sandbox allow-scripts allow-forms/);
  assert.match(csp, /default-src 'none'/);

  assert.equal(await res.text(), HTML_A);
});

test("persisted files match the created project", async () => {
  const versionDir = path.join(server.dataDir, createdA.id, "versions", "1");
  const storedHtml = await fs.readFile(
    path.join(versionDir, "index.html"),
    "utf8"
  );
  assert.equal(storedHtml, HTML_A);

  const meta = JSON.parse(
    await fs.readFile(path.join(server.dataDir, createdA.id, "meta.json"), "utf8")
  );
  assert.equal(meta.id, createdA.id);
  assert.equal(meta.name, "Alpha");
  assert.equal(meta.createdAt, createdA.createdAt);
  assert.deepEqual(
    meta.versions.map((v) => v.version),
    [1]
  );
});

test("preview returns 404 for unknown or malformed targets", async () => {
  const cases = [
    `/p/${crypto.randomUUID()}/`,
    "/p/not-a-uuid/",
    "/p/"
  ];

  for (const target of cases) {
    const res = await server.preview(target);

    assert.equal(res.status, 404, target);
    assert.equal(await res.text(), "Not Found", target);
  }

  const postRes = await server.preview(`/p/${createdA.id}/`, { method: "POST" });
  assert.equal(postRes.status, 404);
});

test("unknown /api/ routes return 404 with a valid token", async () => {
  const r = await server.api("/api/unknown");

  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Not Found" });
});
