import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

const json = (value) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value)
});

test("RC16 permanently deletes only trashed projects with exact ID confirmation", async () => {
  const server = await startServer();
  try {
    const created = await server.api("/api/projects", {
      method: "POST",
      ...json({ name: "RC16 fixture", html: "<html><body>RC16 safe fixture</body></html>" })
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;
    const endpoint = "/api/projects/" + id;
    const dir = path.join(server.dataDir, id);
    const share = await server.api(endpoint + "/shares", { method: "POST", ...json({}) });
    assert.equal(share.status, 201);
    const key = await server.api(endpoint + "/deploy-keys", { method: "POST", ...json({}) });
    assert.equal(key.status, 201);
    const sharePath = "/s/" + share.json.token + "/";
    assert.equal((await server.preview(sharePath)).status, 200);

    assert.equal((await server.api(endpoint, { method: "DELETE", ...json({confirmProjectId:id}) })).status, 409);
    assert.equal((await server.api(endpoint, {method:"DELETE", ...json({confirmProjectId:"bad"})})).status, 400);
    assert.equal((await server.api(endpoint, {method:"DELETE", token:null, ...json({confirmProjectId:id})})).status, 401);
    assert.equal((await server.api(endpoint, {method:"DELETE", token:key.json.token, ...json({confirmProjectId:id})})).status, 403);
    assert.equal((await server.api(endpoint)).status, 200);
    assert.equal((await server.preview(sharePath)).status, 200);

    const trashed = await server.api(endpoint, {method:"PATCH",...json({lifecycleState:"trashed"})});
    assert.equal(trashed.status, 200);
    assert.equal((await server.api(endpoint, {method:"DELETE", ...json({confirmProjectId:"not-the-id"})})).json.code, "DELETE_CONFIRMATION_MISMATCH");
    assert.equal((await fs.stat(dir)).isDirectory(), true);

    const purged = await server.api(endpoint, {method:"DELETE", ...json({confirmProjectId:id})});
    assert.equal(purged.status, 200, JSON.stringify(purged.json));
    assert.deepEqual(purged.json, {projectId:id, deleted:true});
    await assert.rejects(fs.stat(dir), {code:"ENOENT"});
    assert.equal((await server.api(endpoint)).status, 404);
    assert.equal((await server.api(endpoint + "/versions")).status, 404);
    assert.ok(!(await server.api("/api/projects")).json.projects.some(p => p.id === id));
    assert.equal((await server.preview("/p/" + id + "/")).status, 404);
    assert.equal((await server.preview(sharePath)).status, 404);
    assert.equal((await server.api(endpoint, {method:"DELETE", ...json({confirmProjectId:id})})).status, 404);
    const keyAttempt = await server.api(endpoint, {token:key.json.token});
    assert.equal(keyAttempt.status, 401);
  } finally {
    await server.stop();
    await server.cleanup();
  }
});

test("RC16 legacy-root projects also require trash before permanent deletion", async () => {
  const server=await startServer();
  try {
    const { randomUUID } = await import("node:crypto");
    const id=randomUUID();
    const dir=path.join(server.dataDir,id);
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,"index.html"),"<html>legacy</html>");
    const createdAt=new Date().toISOString();
    await fs.writeFile(path.join(dir,"meta.json"),JSON.stringify({id,name:"legacy",createdAt}));
    assert.equal((await server.api("/api/projects/"+id)).status,200);
    await server.api("/api/projects/"+id,{method:"PATCH",...json({lifecycleState:"trashed"})});
    const result=await server.api("/api/projects/"+id,{method:"DELETE",...json({confirmProjectId:id})});
    assert.equal(result.status,200,JSON.stringify(result.json));
    await assert.rejects(fs.stat(dir),{code:"ENOENT"});
  } finally {
    await server.stop();
    await server.cleanup();
  }
});

test("RC16 console exposes permanent delete only for trashed projects", async () => {
  const server=await startServer();
  try {
    const response=await server.apiBase && await fetch(server.apiBase+"/console");
    const html=await response.text();
    assert.equal(response.status,200);
    assert.match(html,/id="purgeProjectBtn"/);
    assert.match(html,/lc !== "trashed"/);
    assert.match(html,/confirmProjectId: id/);
    assert.match(html,/method: "DELETE"/);
  } finally {
    await server.stop();
    await server.cleanup();
  }
});
