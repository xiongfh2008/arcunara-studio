// RC6 upload idempotency: the X-Arcunara-Content-Hash header makes repeated
// deploys of identical content a no-op. Only the CURRENT version's hash
// dedupes — rolling back and re-deploying old content must still create a
// new (current) version. No header = legacy behavior (always a new version).

import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const HTML = "<html><body><h1>Idempotency</h1></body></html>";

let server;
let project;

function zipOf(html) {
  return filesZip([{ name: "index.html", data: html }]);
}

before(async () => {
  server = await startServer();
  const r = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Idempotent", html: HTML })
  });
  assert.equal(r.status, 201);
  project = r.json;
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

function upload(zip, contentHash) {
  const fd = new FormData();
  fd.set("file", new Blob([zip]), "deploy.zip");
  const headers = contentHash ? { "x-arcunara-content-hash": contentHash } : {};
  return server.api(`/api/projects/${project.id}/versions`, {
    method: "POST",
    headers,
    body: fd
  });
}

function contentHash(zip) {
  return crypto.createHash("sha256").update(zip).digest("hex");
}

test("re-uploading identical content with the same hash dedupes", async () => {
  const zip = zipOf("<html><body><h1>V2 content</h1></body></html>");

  const first = await upload(zip, contentHash(zip));
  assert.equal(first.status, 201);
  assert.equal(first.json.version, 2);
  assert.notEqual(first.json.deduplicated, true);

  const repeat = await upload(zip, contentHash(zip));
  assert.equal(repeat.status, 201);
  assert.equal(repeat.json.deduplicated, true);
  assert.equal(repeat.json.version, 2);

  // Preview keeps serving the content; version list unchanged.
  const versions = await server.api(`/api/projects/${project.id}/versions`);
  assert.equal(versions.json.versions.length, 2);

  // No orphaned version directories on disk.
  const dirs = await fs.readdir(path.join(server.dataDir, project.id, "versions"));
  assert.equal(dirs.length, 2);
});

test("changed content with a hash creates a new version", async () => {
  const zip = zipOf("<html><body><h1>V3 content</h1></body></html>");
  const r = await upload(zip, contentHash(zip));
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 3);
  assert.equal(r.json.deduplicated, undefined);
});

test("upload without a hash header always creates a new version (compat)", async () => {
  const zip = zipOf("<html><body><h1>V3 content</h1></body></html>");
  const r = await upload(zip, undefined);
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 4);
});

test("an invalid hash format is rejected with 400", async () => {
  const zip = zipOf("<html><body>whatever</body></html>");
  const r = await upload(zip, "not-a-hash");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_CONTENT_HASH");
});

test("rollback then re-deploy historical content creates a NEW current version", async () => {
  // Roll back to v1 (legacy-root, no contentHash) — v2's content is
  // historical but NOT current.
  const rb = await server.api(`/api/projects/${project.id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1 })
  });
  assert.equal(rb.status, 200);
  assert.equal(rb.json.currentVersion, 1);

  const zip = zipOf("<html><body><h1>V2 content</h1></body></html>");
  const r = await upload(zip, contentHash(zip));
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 5);
  assert.equal(r.json.deduplicated, undefined);

  const d = await server.api(`/api/projects/${project.id}`);
  assert.equal(d.json.currentVersion, 5);

  const preview = await server.preview(`/p/${project.id}/`);
  assert.ok((await preview.text()).includes("V2 content"));
});

test("dedupe race: two concurrent identical uploads collapse to one version", async () => {
  const zip = zipOf("<html><body><h1>Race content</h1></body></html>");
  const hash = contentHash(zip);

  const [a, b] = await Promise.all([upload(zip, hash), upload(zip, hash)]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  // Exactly one of them created the version; the other deduplicated.
  const created = [a, b].filter((r) => r.json.deduplicated !== true);
  assert.equal(created.length, 1);

  const versions = await server.api(`/api/projects/${project.id}/versions`);
  const raceVersions = versions.json.versions.filter(
    (v) => v.entryPoint === "index.html" && v.version > 5
  );
  assert.equal(raceVersions.length, 1);
});
