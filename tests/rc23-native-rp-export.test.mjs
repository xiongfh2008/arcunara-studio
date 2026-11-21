// RC23 integration: actual API routes, native job lifecycle and binary gate.
// The mocked bytes in this test are ONLY a gate fixture, never a real .rp;
// real Zee-RP check/generate/decompile is required at worker deployment.
import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {startServer} from "./helpers/harness.mjs";
import {compileQueuedJob} from "../packages/rp-converter/job-worker.mjs";
import {stageNativeBundle} from "../packages/rp-converter/native-inputs.mjs";

function apiPost(app,url,body={}) {
  return app.api(url,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(body)});
}
async function htmlProject(app,name="Native export test") {
  const r=await app.api("/api/projects",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({name,html:"<html><head><title>RP Native</title></head><body><h1 style='position:absolute;left:10px;top:20px'>Hello</h1><button>Next</button></body></html>"})
  });
  assert.equal(r.status,201,JSON.stringify(r.json));
  return r.json.id;
}
test("disabled export rejects requests without creating any native RP artifacts",async()=>{
  const app=await startServer();
  try {
    const project=await htmlProject(app);
    const r=await apiPost(app,`/api/projects/${project}/native-rp-export`,{});
    assert.equal(r.status,503);
    assert.equal(r.json.code,"RP_EXPORT_DISABLED");
    const page=await app.api("/console",{token:null});
    assert.equal(page.status,200);
    assert.match(page.text,/window\.__ARCU_NATIVE_RP_EXPORT__ = false/);
    assert.ok(!await fs.stat(path.join(app.dataDir,".rp-jobs")).then(()=>true).catch(()=>false));
  }finally{await app.stop();await app.cleanup();}
});
test("admin can queue real RP/1 compile job, but cannot download until checked",async()=>{
  const app=await startServer({ARCU_NATIVE_RP_EXPORT_ENABLED:"1"});
  try {
    const project=await htmlProject(app);
    const base=`/api/projects/${project}/native-rp-export`;
    const unknown=await apiPost(app,base,{version:90});
    assert.equal(unknown.status,404);
    assert.equal((await apiPost(app,base,{version:0})).status,400);
    const q=await apiPost(app,base,{version:1});
    assert.equal(q.status,202,JSON.stringify(q.json));
    assert.equal(q.json.status,"queued");
    assert.match(q.json.id,/^[0-9a-f-]{36}$/);
    assert.equal(q.json.hostValidated,false);
    const dir=path.join(app.dataDir,".rp-jobs",q.json.id);
    const spec=JSON.parse(await fs.readFile(path.join(dir,"source.rp1.json"),"utf8"));
    assert.equal(spec.language,"rp/1");
    assert.equal(spec.target,9);
    assert.ok(spec.pages.length>0);
    const before=await app.api(base+"/"+q.json.id+"/download");
    assert.equal(before.status,409);
    assert.equal(before.json.code,"RP_JOB_NOT_READY");
    assert.equal((await app.api(base+"/"+q.json.id)).json.status,"queued");
    assert.equal((await app.api(base+"/"+q.json.id,{token:null})).status,401);
    const other=await htmlProject(app,"Other project");
    assert.equal((await app.api(`/api/projects/${other}/native-rp-export/${q.json.id}`)).status,404);
    const missing=await app.api(base+"/00000000-0000-0000-0000-000000000000");
    assert.equal(missing.status,404);
    const ui=await app.api("/console",{token:null});
    assert.match(ui.text,/window\.__ARCU_NATIVE_RP_EXPORT__ = true/);

    // Inject a controlled fake worker to prove the API will stream artifacts
    // ONLY after it receives exact digest, size and structural check metadata.
    let called=0;
    const worked=await compileQueuedJob({
      dataDir:app.dataDir,
      jobsDir:path.join(app.dataDir,".rp-jobs"),
      zeeRoot:"/fake/zee-rp",
      jobId:q.json.id,
      run:async(args)=>{
        called++;
        if(args[1]==="stage"){
          await stageNativeBundle(args[2],args[3],args[4]);return;
        }
        assert.equal(args[1],"compile");
        const source=JSON.parse(await fs.readFile(args[2],"utf8"));
        const output=args[4];
        const binary=Buffer.alloc(320,0x27);
        await fs.writeFile(output,binary);
        await fs.writeFile(output+".verification.json",JSON.stringify({
          sourceTarget:9,
          status:"engine-readback-passed-host-validation-pending",
          nativeRp11Certified:false,
          structuralReadback:{passed:true,pages:source.pages.length},
          outputBytes:binary.length,
          outputSha256:crypto.createHash("sha256").update(binary).digest("hex")
        }));
      }
    });
    assert.equal(worked,true);
    assert.equal(called,2);
    const complete=await app.api(base+"/"+q.json.id);
    assert.equal(complete.status,200);
    assert.equal(complete.json.status,"completed");
    assert.equal(complete.json.engineReadbackPassed,true);
    assert.equal(complete.json.hostValidated,false);
    const raw=await fetch(app.apiBase+base+"/"+q.json.id+"/download",{
      headers:{Authorization:"Bearer "+app.token}
    });
    assert.equal(raw.status,200);
    assert.match(raw.headers.get("content-disposition"),/\.rp"/);
    assert.equal(raw.headers.get("content-type"),"application/octet-stream");
    assert.equal((await raw.arrayBuffer()).byteLength,320);
    const artifact=path.join(dir,"output.rp");
    await fs.appendFile(artifact,Buffer.alloc(1));
    const altered=await app.api(base+"/"+q.json.id+"/download");
    assert.equal(altered.status,409);
    assert.equal(altered.json.code,"RP_ARTIFACT_INVALID");
  } finally {await app.stop();await app.cleanup();}
});
test("deploy keys and member tokens cannot access native export",async()=>{
  const app=await startServer({
    ARCU_NATIVE_RP_EXPORT_ENABLED:"1",
    ARCU_TEAM_ACCESS_ENABLED:"1"
  });
  try {
    const id=await htmlProject(app);
    const base=`/api/projects/${id}/native-rp-export`;
    const users=await app.api("/api/users",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Role test",email:"role23@example.org"})
    });
    assert.equal(users.status,201);
    const member=users.json.token;
    const denied=await app.api(base,{method:"POST",token:member,
      headers:{"content-type":"application/json"},body:JSON.stringify({version:1})});
    assert.equal(denied.status,404); // No project membership => hidden existence
    const key=await app.api(`/api/projects/${id}/deploy-keys`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal(key.status,201);
    assert.equal((await app.api(base,{method:"POST",token:key.json.token,
      headers:{"content-type":"application/json"},body:"{}"})).status,403);
  }finally{await app.stop();await app.cleanup();}
});
