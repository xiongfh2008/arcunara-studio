// Version management tests: version upload, fixed preview links, history,
// rollback, failure isolation, and v0.2.0 legacy project compatibility.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const HTML_V1 = "<html><body><h1>Version 1</h1></body></html>";
const HTML_V3 = "<html><body><h1>Version 3</h1></body></html>";

const ZIP_V2 = () =>
  filesZip([
    { name: "index.html", data: "<html><head><link rel=\"stylesheet\" href=\"css/v2.css\"></head><body><h1>Version 2</h1></body></html>" },
    { name: "css/v2.css", data: "body{color:green}" }
  ]);

let server;
let project;

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

async function createJsonProject(name, html) {
  const r = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, html })
  });
  assert.equal(r.status, 201);
  return r.json;
}

async function uploadVersionZip(id, name, zip) {
  const fd = new FormData();
  fd.set("file", new Blob([zip]), name);
  return server.api(`/api/projects/${id}/versions`, { method: "POST", body: fd });
}

async function uploadVersionHtml(id, html) {
  return server.api(`/api/projects/${id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html })
  });
}

async function rollback(id, version) {
  return server.api(`/api/projects/${id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version })
  });
}

async function previewText(url) {
  const res = await server.preview(url);
  assert.equal(res.status, 200, url);
  return res.text();
}

test("creates versions while the preview URL stays fixed", async () => {
  project = await createJsonProject("Lifecycle", HTML_V1);
  const previewPath = `/p/${project.id}/`;

  assert.equal(await previewText(previewPath), HTML_V1);

  const v2 = await uploadVersionZip(project.id, "v2.zip", ZIP_V2());
  assert.equal(v2.status, 201);
  assert.equal(v2.json.version, 2);
  assert.equal(v2.json.currentVersion, 2);
  assert.equal(v2.json.fileCount, 2);
  assert.equal(v2.json.entryPoint, "index.html");
  assert.equal(v2.json.previewPath, previewPath, "preview link unchanged");

  assert.equal(await previewText(previewPath), "<html><head><link rel=\"stylesheet\" href=\"css/v2.css\"></head><body><h1>Version 2</h1></body></html>");
  const css = await server.preview(`/p/${project.id}/css/v2.css`);
  assert.equal(css.status, 200);
  assert.equal(await css.text(), "body{color:green}");

  const v3 = await uploadVersionHtml(project.id, HTML_V3);
  assert.equal(v3.status, 201);
  assert.equal(v3.json.version, 3);

  assert.equal(await previewText(previewPath), HTML_V3);

  const list = await server.api("/api/projects");
  const view = list.json.projects.find((p) => p.id === project.id);
  assert.equal(view.currentVersion, 3);

  const detail = await server.api(`/api/projects/${project.id}`);
  assert.equal(detail.json.versionCount, 3);
  assert.equal(detail.json.totalSize, Buffer.byteLength(HTML_V3));
});

test("lists version history with isCurrent flags", async () => {
  const r = await server.api(`/api/projects/${project.id}/versions`);

  assert.equal(r.status, 200);
  assert.equal(r.json.projectId, project.id);
  assert.deepEqual(
    r.json.versions.map((v) => v.version),
    [1, 2, 3]
  );
  assert.deepEqual(
    r.json.versions.map((v) => v.isCurrent),
    [false, false, true]
  );
  assert.equal(r.json.versions[1].fileCount, 2);
  assert.equal(r.json.versions[0].entryPoint, "index.html");
});

test("rolls back to earlier versions, content follows", async () => {
  const r = await rollback(project.id, 2);

  assert.equal(r.status, 200);
  assert.equal(r.json.rolledBack, true);
  assert.equal(r.json.currentVersion, 2);
  assert.equal(r.json.previewPath, `/p/${project.id}/`, "preview link unchanged");

  assert.equal(
    await previewText(`/p/${project.id}/`),
    "<html><head><link rel=\"stylesheet\" href=\"css/v2.css\"></head><body><h1>Version 2</h1></body></html>"
  );

  const r2 = await rollback(project.id, 1);
  assert.equal(r2.json.currentVersion, 1);
  assert.equal(await previewText(`/p/${project.id}/`), HTML_V1);
});

test("rollback to the current version is a no-op", async () => {
  const r = await rollback(project.id, 1);

  assert.equal(r.status, 200);
  assert.equal(r.json.rolledBack, false);
  assert.equal(r.json.currentVersion, 1);
});

test("rollback to an unknown version returns 400", async () => {
  const r = await rollback(project.id, 99);

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "VERSION_NOT_FOUND");
});

test("rollback without a version returns 400", async () => {
  const r = await server.api(`/api/projects/${project.id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_VERSION");
});

test("failed version upload leaves the current version untouched", async () => {
  const before = await previewText(`/p/${project.id}/`);
  const detailBefore = await server.api(`/api/projects/${project.id}`);

  const bad = Buffer.from("not a zip at all");
  const r = await uploadVersionZip(project.id, "bad.zip", bad);

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_ZIP");

  const after = await previewText(`/p/${project.id}/`);
  assert.equal(after, before);

  const detailAfter = await server.api(`/api/projects/${project.id}`);
  assert.equal(detailAfter.json.currentVersion, detailBefore.json.currentVersion);

  const tmp = await fs.readdir(path.join(server.dataDir, ".tmp"));
  assert.deepEqual(tmp, [], "no staging leftovers");
});

test("version uploads for unknown projects return 404", async () => {
  const missing = crypto.randomUUID();

  const rJson = await uploadVersionHtml(missing, HTML_V1);
  assert.equal(rJson.status, 404);
  assert.equal(rJson.json.code, "PROJECT_NOT_FOUND");

  const fd = new FormData();
  fd.set("file", new Blob(["<html>x</html>"]), "x.html");
  const rFile = await server.api(`/api/projects/${missing}/versions`, {
    method: "POST",
    body: fd
  });
  assert.equal(rFile.status, 404);
});

test("rejects invalid JSON html version payloads", async () => {
  const r = await uploadVersionHtml(project.id, "<body>no html tag</body>");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_HTML");
});

test("changing entry points keeps previews working across rollbacks", async () => {
  const p = await createJsonProject("Entry", HTML_V1);

  const zip = filesZip([{ name: "docs/page.html", data: "<html><body>solo v2</body></html>" }]);
  const v2 = await uploadVersionZip(p.id, "v2.zip", zip);
  assert.equal(v2.status, 201);
  assert.equal(v2.json.entryPoint, "docs/page.html");

  const redirected = await server.preview(`/p/${p.id}/`, { redirect: "manual" });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get("location"), `/p/${p.id}/docs/page.html`);

  await rollback(p.id, 1);

  const back = await server.preview(`/p/${p.id}/`);
  assert.equal(back.status, 200);
  assert.equal(await back.text(), HTML_V1);
});

test("v0.2.0 legacy project directories stay readable and updatable", async () => {
  // Simulate a real v0.2.0 deployment directory: root index.html + minimal
  // meta.json, no versions/ directory at all.
  const id = crypto.randomUUID();
  const dir = path.join(server.dataDir, id);
  const legacyHtml = "<html><body><h1>Legacy v0.2.0</h1></body></html>";

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), legacyHtml, "utf8");
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, name: "LegacyV020", createdAt: "2026-01-01T00:00:00.000Z" }),
    "utf8"
  );

  // List & detail synthesize the legacy version view.
  const detail = await server.api(`/api/projects/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.currentVersion, 1);
  assert.equal(detail.json.fileCount, 1);
  assert.equal(detail.json.totalSize, Buffer.byteLength(legacyHtml));
  assert.equal(detail.json.versionCount, 1);

  const versions = await server.api(`/api/projects/${id}/versions`);
  assert.deepEqual(versions.json.versions.map((v) => v.version), [1]);
  assert.equal(versions.json.versions[0].isCurrent, true);

  // Preview serves the root layout.
  assert.equal(await previewText(`/p/${id}/`), legacyHtml);

  // Update: root files are recorded as v1, new content becomes v2.
  const v2 = await uploadVersionHtml(id, HTML_V3);
  assert.equal(v2.status, 201);
  assert.equal(v2.json.version, 2);

  assert.equal(await previewText(`/p/${id}/`), HTML_V3, "preview shows new version");

  // Original legacy data is preserved untouched.
  assert.equal(
    await fs.readFile(path.join(dir, "index.html"), "utf8"),
    legacyHtml
  );

  const versionsAfter = await server.api(`/api/projects/${id}/versions`);
  assert.deepEqual(versionsAfter.json.versions.map((v) => v.version), [1, 2]);
  assert.equal(versionsAfter.json.versions[0].entryPoint, "index.html");

  // Rollback to the legacy root version.
  await rollback(id, 1);
  assert.equal(await previewText(`/p/${id}/`), legacyHtml, "rollback serves legacy root");
});
