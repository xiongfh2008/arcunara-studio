import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

async function upload(server,endpoint,files,name) {
  const form = new FormData();
  if (name) form.set("name",name);
  form.set("file",new Blob([filesZip(files.map(([n,data])=>({name:n,data})))]),"site.zip");
  return server.api(endpoint,{method:"POST",body:form});
}

test("RC15 compares added/removed/changed/unchanged including equal-size content edits",async()=>{
  const server=await startServer();
  try {
    const first=await upload(server,"/api/projects",[
      ["index.html","<html><body>Same</body></html>"],
      ["assets/app.css","a{color:red}"],
      ["old.txt","old file"]
    ],"Version comparison");
    assert.equal(first.status,201,JSON.stringify(first.json));
    const id=first.json.id;
    const second=await upload(server,`/api/projects/${id}/versions`,[
      ["index.html","<html><body>Same</body></html>"],
      ["assets/app.css","a{color:blu}"],
      ["new.txt","new file"]
    ]);
    assert.equal(second.status,201,JSON.stringify(second.json));
    const pathDiff=`/api/projects/${id}/compare-versions?from=1&to=2`;
    const diff=await server.api(pathDiff);
    assert.equal(diff.status,200,JSON.stringify(diff.json));
    assert.deepEqual(diff.json.counts,{added:1,removed:1,changed:1,unchanged:1});
    assert.equal(diff.json.added[0].path,"new.txt");
    assert.equal(diff.json.removed[0].path,"old.txt");
    assert.equal(diff.json.changed[0].path,"assets/app.css");
    assert.equal(diff.json.readOnly,true);
    assert.doesNotMatch(JSON.stringify(diff.json),/a\{color:red\}/);
    assert.equal((await server.api(`/api/projects/${id}`)).json.currentVersion,2);
    assert.equal((await server.preview(`/p/${id}/`)).status,200);
    const same=await server.api(`/api/projects/${id}/compare-versions?from=2&to=2`);
    assert.deepEqual(same.json.counts,{added:0,removed:0,changed:0,unchanged:3});

    const rb=await server.api(`/api/projects/${id}/rollback`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:'{"version":1}'
    });
    assert.equal(rb.status,200);
    assert.deepEqual((await server.api(pathDiff)).json.counts,diff.json.counts);
    assert.equal((await server.api(pathDiff,{token:null})).status,401);
    assert.equal((await server.api(`/api/projects/${id}/compare-versions?from=x&to=1`)).status,400);
    assert.equal((await server.api(`/api/projects/${id}/compare-versions?from=1&to=99`)).status,404);
    const dk=await server.api(`/api/projects/${id}/deploy-keys`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal((await server.api(pathDiff,{token:dk.json.token})).status,403);
    const trash=await server.api(`/api/projects/${id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:'{"lifecycleState":"trashed"}'
    });
    assert.equal(trash.status,200);
    assert.equal((await server.api(pathDiff)).status,409);
  } finally { await server.stop();await server.cleanup(); }
});

test("RC15 ignores legacy meta.json and only compares user content",async()=>{
  const server=await startServer();
  try {
    const id=crypto.randomUUID();
    const dir=path.join(server.dataDir,id);
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,"index.html"),"<html>legacy</html>");
    await fs.writeFile(path.join(dir,"meta.json"),JSON.stringify({
      id,name:"Legacy diff",createdAt:new Date().toISOString()
    }));
    const result=await server.api(`/api/projects/${id}/compare-versions?from=1&to=1`);
    assert.equal(result.status,200);
    assert.equal(result.json.counts.unchanged,1);
    assert.equal(result.json.counts.changed,0);
    assert.ok(!JSON.stringify(result.json).includes("meta.json"));
  } finally { await server.stop();await server.cleanup(); }
});
