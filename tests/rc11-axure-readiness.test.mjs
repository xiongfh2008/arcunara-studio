import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

test("RC11 conversion readiness inventories native widgets and flags script-dependent interactions without execution",async()=>{
  const server=await startServer();
  try {
    const create=await server.api("/api/projects",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Audit",html:'<html><head><title>Audit</title></head><body><h1>First</h1><button onclick="alert(1)">Pay</button><input name="name"><a href="/next">Next</a><script>fetch("/api");</script></body></html>'})
    });
    assert.equal(create.status,201);
    const id=create.json.id;
    const report=await server.api(`/api/projects/${id}/axure-readiness`);
    assert.equal(report.status,200);
    assert.equal(report.json.version,1);
    assert.equal(report.json.totalHtmlPages,1);
    assert.equal(report.json.analyzedPages,1);
    assert.equal(report.json.elements.buttons,1);
    assert.equal(report.json.elements.inputs,1);
    assert.equal(report.json.elements.headings,1);
    assert.equal(report.json.nativeRpExportReady,false);
    assert.equal(report.json.status,"analysis-only");
    const codes=report.json.risks.map(x=>x.code);
    assert.ok(codes.includes("INLINE_EVENTS"));
    assert.ok(codes.includes("SCRIPT_DEPENDENCY"));
    assert.ok(codes.includes("NETWORK_API"));
    assert.doesNotMatch(JSON.stringify(report.json),/alert\(1\)|fetch\("\/api/);
    const unauth=await server.api(`/api/projects/${id}/axure-readiness`,{token:null});
    assert.equal(unauth.status,401);
    const invalid=await server.api(`/api/projects/${id}/axure-readiness?version=abc`);
    assert.equal(invalid.status,400);
    const missing=await server.api(`/api/projects/${id}/axure-readiness?version=9`);
    assert.equal(missing.status,404);

    const version2=await server.api(`/api/projects/${id}/versions`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({html:'<html><body><p>v2</p><img src="x.png"></body></html>'})
    });
    assert.equal(version2.status,201);
    assert.equal((await server.api(`/api/projects/${id}/axure-readiness?version=1`)).json.elements.buttons,1);
    assert.equal((await server.api(`/api/projects/${id}/axure-readiness?version=2`)).json.elements.images,1);

    const trash=await server.api(`/api/projects/${id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    assert.equal(trash.status,200);
    assert.equal((await server.api(`/api/projects/${id}/axure-readiness`)).status,409);
  } finally {await server.stop();await server.cleanup();}
});
