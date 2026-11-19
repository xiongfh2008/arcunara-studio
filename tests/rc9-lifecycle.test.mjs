import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

test("RC9 archive and recoverable trash preserve versions while denying public resources", async () => {
  const server = await startServer();
  try {
    const create = await server.api("/api/projects", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({name:"Lifecycle",html:"<html><body>RC9</body></html>"})
    });
    assert.equal(create.status,201);
    const id = create.json.id;
    assert.equal(create.json.lifecycleState,"active");
    const share = await server.api(`/api/projects/${id}/shares`,{
      method:"POST", headers: {"content-type":"application/json"},
      body:"{}"
    });
    assert.equal(share.status,201);
    const shareUrl = `/s/${share.json.token}/`;
    assert.equal((await server.preview(shareUrl)).status,200);

    let result = await server.api(`/api/projects/${id}`, {
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"archived"})
    });
    assert.equal(result.status,200);
    assert.equal(result.json.lifecycleState,"archived");
    assert.ok(result.json.archivedAt);
    assert.equal((await server.preview(`/p/${id}/`)).status,200);
    assert.equal((await server.preview(shareUrl)).status,200);

    result = await server.api(`/api/projects/${id}`, {
      method:"PATCH", headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    assert.equal(result.status,200);
    assert.equal(result.json.lifecycleState,"trashed");
    assert.equal(result.json.previewEnabled,false);
    assert.ok(result.json.trashedAt);
    assert.equal((await server.preview(`/p/${id}/`)).status,404);
    assert.equal((await server.preview(`/p/${id}/index.html`)).status,404);
    assert.equal((await server.preview(shareUrl)).status,404);
    assert.equal((await server.api(`/api/projects/${id}/shares`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    })).status,409);
    assert.equal((await server.api(`/api/projects/${id}/versions`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({html:"<html><body>blocked</body></html>"})
    })).status,409);
    const index = await server.api("/api/projects");
    assert.equal(index.json.projects.find(x=>x.id===id).lifecycleState,"trashed");
    const versions = await server.api(`/api/projects/${id}/versions`);
    assert.equal(versions.json.versions.length,1);

    const restore = await server.api(`/api/projects/${id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"active"})
    });
    assert.equal(restore.status,200);
    assert.equal(restore.json.lifecycleState,"active");
    assert.equal(restore.json.trashedAt,null);
    assert.equal((await server.preview(`/p/${id}/`)).status,200);
    assert.equal((await server.preview(shareUrl)).status,200);

    const invalid = await server.api(`/api/projects/${id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"deleted"})
    });
    assert.equal(invalid.status,400);
    assert.equal(invalid.json.code,"INVALID_LIFECYCLE_STATE");
  } finally {
    await server.stop();
    await server.cleanup();
  }
});

test("RC9 lifecycle is protected from deploy keys", async () => {
  const server = await startServer();
  try {
    const create = await server.api("/api/projects",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Deploy guard",html:"<html>safe</html>"})
    });
    const id = create.json.id;
    const deploy = await server.api(`/api/projects/${id}/deploy-keys`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal(deploy.status,201);
    const bad = await server.api(`/api/projects/${id}`,{
      token:deploy.json.token,method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    assert.equal(bad.status,403);
    const state = await server.api(`/api/projects/${id}`);
    assert.equal(state.json.lifecycleState,"active");
  } finally {
    await server.stop();
    await server.cleanup();
  }
});
