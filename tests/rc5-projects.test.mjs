// RC5 Task A/D: project management — search fields, PATCH editing, server-
// side preview enable/disable, detail/list sync, id stability, and share
// config survival across version updates.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

const HTML = "<html><body><h1>RC5 project</h1></body></html>";

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

async function createJsonProject(name, html = HTML, description) {
  const body = { name, html };
  if (description !== undefined) body.description = description;
  const r = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(r.status, 201);
  return r.json;
}

test("list and detail expose previewEnabled and keep old fields", async () => {
  project = await createJsonProject("RC5 Manage", HTML, "初始描述");

  const list = await server.api("/api/projects");
  const view = list.json.projects.find((p) => p.id === project.id);
  assert.equal(view.previewEnabled, true, "default is enabled");
  assert.equal(view.name, "RC5 Manage");

  const detail = await server.api(`/api/projects/${project.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.previewEnabled, true);
  assert.equal(detail.json.previewPath, `/p/${project.id}/`);
});

test("PATCH renames a project without changing its id or data", async () => {
  const r = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "改名后的项目", description: "新描述" })
  });

  assert.equal(r.status, 200);
  assert.equal(r.json.id, project.id, "UUID unchanged");
  assert.equal(r.json.name, "改名后的项目");
  assert.equal(r.json.description, "新描述");
  assert.equal(r.json.currentVersion, project.currentVersion);
  assert.equal(r.json.previewPath, `/p/${project.id}/`);

  // List and detail views are in sync.
  const list = await server.api("/api/projects");
  const view = list.json.projects.find((p) => p.id === project.id);
  assert.equal(view.name, "改名后的项目");
  assert.equal(view.description, "新描述");

  const detail = await server.api(`/api/projects/${project.id}`);
  assert.equal(detail.json.name, "改名后的项目");
});

test("PATCH can clear the description", async () => {
  const r = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "" })
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.description, undefined);
});

test("PATCH rejects invalid payloads", async () => {
  const empty = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "   " })
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "NAME_REQUIRED");

  const long = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(101) })
  });
  assert.equal(long.status, 400);
  assert.equal(long.json.code, "NAME_TOO_LONG");

  const badFlag = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: "yes" })
  });
  assert.equal(badFlag.status, 400);
  assert.equal(badFlag.json.code, "INVALID_PREVIEW_ENABLED");

  const missing = await server.api(`/api/projects/${crypto.randomUUID()}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "nope" })
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "PROJECT_NOT_FOUND");
});

test("disabling preview blocks the entry page AND all static resources server-side", async () => {
  // Give the project a subresource so we can prove resource-level denial.
  const zip = await (await import("./helpers/zipbuilder.mjs")).filesZip([
    { name: "index.html", data: '<html><head><link rel="stylesheet" href="css/app.css"></head><body>x</body></html>' },
    { name: "css/app.css", data: "body{color:red}" }
  ]);
  const fd = new FormData();
  fd.set("file", new Blob([zip]), "v2.zip");
  const v2 = await server.api(`/api/projects/${project.id}/versions`, { method: "POST", body: fd });
  assert.equal(v2.status, 201);

  const beforeEntry = await server.preview(`/p/${project.id}/`);
  assert.equal(beforeEntry.status, 200);
  const beforeCss = await server.preview(`/p/${project.id}/css/app.css`);
  assert.equal(beforeCss.status, 200);

  const off = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: false })
  });
  assert.equal(off.status, 200);
  assert.equal(off.json.previewEnabled, false);

  const entry = await server.preview(`/p/${project.id}/`);
  assert.equal(entry.status, 404, "entry denied");
  const css = await server.preview(`/p/${project.id}/css/app.css`);
  assert.equal(css.status, 404, "static subresource denied too");

  // Bare id and HEAD are denied as well.
  const bare = await server.preview(`/p/${project.id}`, { redirect: "manual" });
  assert.equal(bare.status, 404);
  const head = await server.preview(`/p/${project.id}/`, { method: "HEAD" });
  assert.equal(head.status, 404);

  // Re-enable restores the exact previous behavior (compat).
  const on = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: true })
  });
  assert.equal(on.status, 200);
  assert.equal((await server.preview(`/p/${project.id}/`)).status, 200);
  assert.equal((await server.preview(`/p/${project.id}/css/app.css`)).status, 200);
});

test("projects without the previewEnabled field keep open preview (legacy meta)", async () => {
  const id = crypto.randomUUID();
  const dir = path.join(server.dataDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), HTML, "utf8");
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, name: "LegacyNoFlag", createdAt: "2026-01-01T00:00:00.000Z" }),
    "utf8"
  );

  const res = await server.preview(`/p/${id}/`);
  assert.equal(res.status, 200, "absent flag means enabled");
});

test("version upload preserves shares and edited metadata", async () => {
  const p = await createJsonProject("ShareKeeper", HTML);
  const share = await server.api(`/api/projects/${p.id}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(share.status, 201);

  const fd = new FormData();
  fd.set("file", new Blob(["<html><body>v2</body></html>"]), "v2.html");
  const v2 = await server.api(`/api/projects/${p.id}/versions`, { method: "POST", body: fd });
  assert.equal(v2.status, 201);

  const shares = await server.api(`/api/projects/${p.id}/shares`);
  assert.equal(shares.json.shares.length, 1, "share survived the version publish");
  assert.equal(shares.json.shares[0].id, share.json.id);

  const list = await server.api("/api/projects");
  const view = list.json.projects.find((x) => x.id === p.id);
  assert.equal(view.currentVersion, 2, "list reflects the new version");
});
