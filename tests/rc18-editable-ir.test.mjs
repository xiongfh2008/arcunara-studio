import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

function json(value) {
  return { method: "POST", headers: {"content-type":"application/json"},
    body:JSON.stringify(value) };
}
function zipBody(files, name) {
  const form = new FormData();
  if (name) form.set("name",name);
  form.set("file",new Blob([filesZip(files.map(([n,data])=>({name:n,data})))]),"prototype.zip");
  return { method: "POST", body: form };
}

test("RC18A maps static text, geometry, inputs, images and same-project navigation to versioned IR", async () => {
  const server = await startServer();
  try {
    const first = await server.api("/api/projects",zipBody([
      ["index.html",'<html><head><title>Demo &amp; test</title></head><body><h1 style="position:absolute;left:18px;top:24px;width:170px;color:#123456">Hello <b>World</b></h1><button style="height:32px">Submit</button><input type="text" placeholder="Name"><img src="assets/icon.png" alt="logo"><a href="other.html">Next page</a><script>throw new Error("must NOT run")</script></body></html>'],
      ["other.html","<html><body><p>Other</p></body></html>"],
      ["assets/icon.png",Buffer.from([137,80,78,71,0])]
    ],"Mapping"));
    assert.equal(first.status,201,JSON.stringify(first.json));
    const id = first.json.id;
    const endpoint = "/api/projects/" + id + "/axure-ir";
    const mapped = await server.api(endpoint + "?version=1");
    assert.equal(mapped.status,200,JSON.stringify(mapped.json));
    const ir = mapped.json;
    assert.equal(ir.schema,"arcunara.editable-ir.v1");
    assert.equal(ir.target,"axure-rp11");
    assert.equal(ir.artifactType,"editable-candidate-intermediate-json");
    assert.equal(ir.status,"mapping-only");
    assert.equal(ir.nativeRpExportReady,false);
    assert.equal(ir.compiler.available,false);
    assert.equal(ir.summary.pages,2);
    assert.equal(ir.pages[0].title,"Demo & test");
    const heading=ir.pages[0].nodes.find(x=>x.sourceTag==="h1");
    assert.equal(heading.text,"Hello World");
    assert.deepEqual(heading.geometry,{x:18,y:24,width:170});
    assert.equal(heading.style.color,"#123456");
    assert.ok(ir.pages[0].nodes.some(x=>x.type==="button"&&x.text==="Submit"));
    assert.equal(ir.pages[0].nodes.find(x=>x.type==="input").input.placeholder,"Name");
    assert.equal(ir.pages[0].nodes.find(x=>x.type==="image").assetPath,"assets/icon.png");
    assert.deepEqual(ir.pages[0].nodes.find(x=>x.type==="link").navigation,
      {kind:"navigate-page",target:"other.html"});
    assert.ok(ir.warnings.includes("SCRIPT_INTERACTIONS_UNMAPPED"));
    assert.doesNotMatch(JSON.stringify(ir),/must NOT run/);
    const again=await server.api(endpoint+"?version=1");
    assert.deepEqual(ir,again.json);
    assert.equal((await server.api("/api/projects/"+id)).json.currentVersion,1);

    const second=await server.api("/api/projects/"+id+"/versions",json({
      html:"<html><body><p>Second version</p></body></html>"
    }));
    assert.equal(second.status,201);
    const newer=await server.api(endpoint);
    assert.equal(newer.status,200);
    assert.equal(newer.json.version,2);
    assert.equal(newer.json.pages[0].nodes[0].text,"Second version");
    assert.equal((await server.api(endpoint+"?version=1")).json.pages[0].title,"Demo & test");
    assert.equal((await server.api("/api/projects/"+id)).json.currentVersion,2);
  } finally {await server.stop();await server.cleanup();}
});

test("RC18A never executes HTML scripts and rejects unsafe or external resources", async()=>{
  const server=await startServer();
  try {
    const c=await server.api("/api/projects",json({
      name:"Security",
      html:'<html><body><h2>Literal &lt;tag&gt;</h2><input type="password" value="supersecret"><input type="hidden" value="hidden-value"><a href="javascript:alert(1)">Bad link</a><img src="../meta.json"><div onclick="alert(1)"></div><style>.x{display:grid}</style><script>fetch("/leak"); throw "executed"</script></body></html>'
    }));
    assert.equal(c.status,201);
    const result=await server.api("/api/projects/"+c.json.id+"/axure-ir");
    assert.equal(result.status,200,JSON.stringify(result.json));
    const text=JSON.stringify(result.json);
    assert.doesNotMatch(text,/supersecret|hidden-value|fetch\("\/leak"|executed/);
    assert.equal(result.json.pages[0].nodes[0].text,"Literal <tag>");
    assert.ok(!result.json.pages[0].nodes.some(n=>n.input?.kind==="password"));
    for (const name of ["SENSITIVE_OR_UNSUPPORTED_INPUT_OMITTED","LINK_ACTION_UNMAPPED",
      "UNRESOLVED_IMAGE_ASSET","SCRIPT_INTERACTIONS_UNMAPPED",
      "INLINE_EVENTS_UNMAPPED","EXTERNAL_OR_EMBEDDED_CSS_UNRESOLVED"]) {
      assert.ok(result.json.warnings.includes(name),name);
    }
    assert.equal(result.json.nativeRpExportReady,false);
  } finally {await server.stop();await server.cleanup();}
});

test("RC18A endpoint is admin-only, validates version, and denies trashed projects", async()=>{
  const server=await startServer();
  try {
    const c=await server.api("/api/projects",json({
      name:"Permissions",html:"<html><body><p>Welcome</p></body></html>"
    }));
    const id=c.json.id, endpoint="/api/projects/"+id+"/axure-ir";
    assert.equal((await server.api(endpoint,{token:null})).status,401);
    const key=await server.api("/api/projects/"+id+"/deploy-keys",json({}));
    assert.equal(key.status,201);
    assert.equal((await server.api(endpoint,{token:key.json.token})).status,403);
    for(const query of ["?version=0","?version=-1","?version=foo",
      "?version=1.1","?version=1&version=2","?version=9007199254740993123"]) {
      const response=await server.api(endpoint+query);
      assert.equal(response.status,400,query);
      assert.equal(response.json.code,"INVALID_VERSION",query);
    }
    assert.equal((await server.api(endpoint+"?version=8")).status,404);
    assert.equal((await server.api("/api/projects/"+crypto.randomUUID()+"/axure-ir")).status,404);
    await server.api("/api/projects/"+id,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    const trash=await server.api(endpoint);
    assert.equal(trash.status,409);
    assert.equal(trash.json.code,"PROJECT_TRASHED");
  } finally {await server.stop();await server.cleanup();}
});

test("RC18A legacy-root is supported and scan limit blocks too many pages", async()=>{
  const server=await startServer();
  try {
    const id=crypto.randomUUID();
    const dir=path.join(server.dataDir,id);
    await fs.mkdir(dir,{recursive:true});
    const createdAt=new Date().toISOString();
    await fs.writeFile(path.join(dir,"index.html"),"<html><p>Old project</p></html>");
    await fs.writeFile(path.join(dir,"meta.json"),JSON.stringify({
      id,name:"Legacy",createdAt,internalOnly:"NEVER_SEND"
    }));
    const mapped=await server.api("/api/projects/"+id+"/axure-ir?version=1");
    assert.equal(mapped.status,200,JSON.stringify(mapped.json));
    assert.equal(mapped.json.pages[0].nodes[0].text,"Old project");
    assert.doesNotMatch(JSON.stringify(mapped.json),/NEVER_SEND/);

    const newProject=await server.api("/api/projects",json({
      name:"Page limit",html:"<html>first</html>"
    }));
    const root=path.join(server.dataDir,newProject.json.id,"versions","1");
    for(let i=0;i<51;i++)await fs.writeFile(path.join(root,"page"+i+".html"),"<html>page</html>");
    const excessive=await server.api("/api/projects/"+newProject.json.id+"/axure-ir");
    assert.equal(excessive.status,413);
    assert.equal(excessive.json.code,"IR_PAGE_LIMIT");
  } finally {await server.stop();await server.cleanup();}
});

test("RC18A workbench visibly differentiates mapped JSON from real .rp export", async()=>{
  const server=await startServer();
  try {
    const html=await (await fetch(server.apiBase+"/console")).text();
    assert.match(html,/id="downloadAxureIrBtn"/);
    assert.match(html,/\/axure-ir\?version=/);
    assert.match(html,/nativeRpExportReady !== false/);
    assert.match(html,/JSON，非 \.rp/);
    assert.match(html,/Zee-RP/);
  } finally {await server.stop();await server.cleanup();}
});
