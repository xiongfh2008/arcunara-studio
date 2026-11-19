import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

test("RC12 edits notes on historical versions without touching published files or rollback pointers",async()=>{
  const server=await startServer();
  try {
    const created=await server.api("/api/projects",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Release notes",html:"<html>v1</html>"})
    });
    assert.equal(created.status,201);
    const id=created.json.id;
    const v2=await server.api(`/api/projects/${id}/versions`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({html:"<html>v2</html>"})
    });
    assert.equal(v2.status,201);
    const url=`/api/projects/${id}/versions/1`;
    const updated=await server.api(url,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({note:"  首版交付   "})
    });
    assert.equal(updated.status,200);
    assert.equal(updated.json.note,"首版交付");
    let versions=(await server.api(`/api/projects/${id}/versions`)).json.versions;
    assert.equal(versions[0].note,"首版交付");
    assert.equal(versions[1].note,"");
    assert.equal(versions[1].isCurrent,true);
    assert.match(await (await server.preview(`/p/${id}/`)).text(),/v2/);

    assert.equal((await server.api(url,{method:"PATCH",token:null,headers:{"content-type":"application/json"},body:'{"note":"untrusted"}'})).status,401);
    assert.equal((await server.api(url,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({note:"A".repeat(501)})})).status,400);
    assert.equal((await server.api(`/api/projects/${id}/versions/99`,{method:"PATCH",headers:{"content-type":"application/json"},body:'{"note":"x"}'})).status,404);
    assert.equal((await server.api(url,{method:"PATCH",headers:{"content-type":"application/json"},body:'{"note":22}'})).status,400);

    const rb=await server.api(`/api/projects/${id}/rollback`,{
      method:"POST",headers:{"content-type":"application/json"},body:'{"version":1}'
    });
    assert.equal(rb.status,200);
    versions=(await server.api(`/api/projects/${id}/versions`)).json.versions;
    assert.equal(versions[0].note,"首版交付");
    assert.equal(versions[0].isCurrent,true);
    assert.match(await (await server.preview(`/p/${id}/`)).text(),/v1/);

    const key=await server.api(`/api/projects/${id}/deploy-keys`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal((await server.api(url,{
      method:"PATCH",token:key.json.token,
      headers:{"content-type":"application/json"},body:'{"note":"unauthorized"}'
    })).status,403);
  } finally {await server.stop();await server.cleanup();}
});

test("RC12 legacy v0.2 projects can annotate their implicit v1 without migrating files",async()=>{
  const server=await startServer();
  try {
    const id=crypto.randomUUID();
    const dir=path.join(server.dataDir,id);
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,"index.html"),"<html>legacy</html>");
    await fs.writeFile(path.join(dir,"meta.json"),JSON.stringify({
      id,name:"Legacy notes",createdAt:new Date().toISOString()
    }));
    const result=await server.api(`/api/projects/${id}/versions/1`,{
      method:"PATCH",headers:{"content-type":"application/json"},body:'{"note":"存量项目"}'
    });
    assert.equal(result.status,200);
    const versions=await server.api(`/api/projects/${id}/versions`);
    assert.equal(versions.json.versions[0].note,"存量项目");
    assert.match(await (await server.preview(`/p/${id}/`)).text(),/legacy/);
  } finally {await server.stop();await server.cleanup();}
});
