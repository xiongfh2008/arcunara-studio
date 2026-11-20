import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const body = value=>({headers:{"content-type":"application/json"},body:JSON.stringify(value)});
const create = (value)=>({method:"POST",...body(value)});
const sha = value=>crypto.createHash("sha256").update(value,"utf8").digest("hex");

test("RC21A editor loads single HTML and saves immutable next version; no-op does not duplicate",async()=>{
  const app=await startServer();
  try{
    const original="<html><head><title>AI</title></head><body><h1>Original</h1></body></html>";
    const newHtml="<html><head><title>AI revised</title></head><body><h1>Updated</h1></body></html>";
    const p=await app.api("/api/projects",create({name:"AI generated",html:original}));
    assert.equal(p.status,201,JSON.stringify(p.json));
    const id=p.json.id, endpoint="/api/projects/"+id+"/html-editor";
    const first=await app.api(endpoint);
    assert.equal(first.status,200,JSON.stringify(first.json));
    assert.equal(first.json.version,1);
    assert.equal(first.json.entryPoint,"index.html");
    assert.equal(first.json.sha256,sha(original));
    assert.equal(first.json.html,original);
    assert.equal(first.json.scriptExecution,false);
    assert.equal(first.json.singleFile,true);
    const unchanged=await app.api(endpoint+"/publish",{
      method:"POST",...body({baseVersion:1,baseSha256:first.json.sha256,html:original})
    });
    assert.equal(unchanged.status,200);
    assert.equal(unchanged.json.unchanged,true);
    assert.equal((await app.api("/api/projects/"+id)).json.versionCount,1);

    const saved=await app.api(endpoint+"/publish",{
      method:"POST",...body({baseVersion:1,baseSha256:first.json.sha256,html:newHtml})
    });
    assert.equal(saved.status,201,JSON.stringify(saved.json));
    assert.equal(saved.json.version,2);
    assert.equal(saved.json.currentVersion,2);
    assert.equal((await app.api(endpoint)).json.html,newHtml);
    const v=(await app.api("/api/projects/"+id+"/versions")).json.versions;
    assert.deepEqual(v.map(x=>x.version),[1,2]);
    assert.equal(v.find(x=>x.version===1).isCurrent,false);
    const before=await fs.readFile(path.join(app.dataDir,id,"versions","1","index.html"),"utf8");
    const after=await fs.readFile(path.join(app.dataDir,id,"versions","2","index.html"),"utf8");
    assert.equal(before,original);
    assert.equal(after,newHtml);
    assert.equal((await app.api("/api/projects/"+id)).json.entryPoint,"index.html");
  }finally{await app.stop();await app.cleanup();}
});

test("RC21A optimistic revision conflict rejects concurrent AI deployments and simultaneous editor saves",async()=>{
  const app=await startServer();
  try {
    const origin="<html><body>v1</body></html>";
    const created=await app.api("/api/projects",create({name:"Concurrent edits",html:origin}));
    const id=created.json.id,endpoint="/api/projects/"+id+"/html-editor";
    const first=(await app.api(endpoint)).json;
    const pair=await Promise.all([
      app.api(endpoint+"/publish",{method:"POST",...body({
        baseVersion:first.version,baseSha256:first.sha256,html:"<html><body>edit A</body></html>"
      })}),
      app.api(endpoint+"/publish",{method:"POST",...body({
        baseVersion:first.version,baseSha256:first.sha256,html:"<html><body>edit B</body></html>"
      })})
    ]);
    assert.deepEqual(pair.map(x=>x.status).sort(),[201,409]);
    assert.equal(pair.find(x=>x.status===409).json.code,"EDITOR_VERSION_CONFLICT");
    assert.equal((await app.api("/api/projects/"+id)).json.versionCount,2);
    const second=(await app.api(endpoint)).json;
    const deploy=await app.api("/api/projects/"+id+"/versions",create({
      html:"<html><body>AI agent update</body></html>"
    }));
    assert.equal(deploy.status,201);
    const stale=await app.api(endpoint+"/publish",{method:"POST",...body({
      baseVersion:second.version,baseSha256:second.sha256,
      html:"<html><body>stale human edit</body></html>"
    })});
    assert.equal(stale.status,409);
    assert.equal(stale.json.code,"EDITOR_VERSION_CONFLICT");
    assert.equal((await app.api(endpoint)).json.html,"<html><body>AI agent update</body></html>");
  }finally{await app.stop();await app.cleanup();}
});

test("RC21A never flattens multi-file ZIP or leaks metadata and supports legacy-root HTML",async()=>{
  const app=await startServer();
  try {
    const form=new FormData();
    form.set("name","Multi-file assets");
    form.set("file",new Blob([filesZip([
      {name:"index.html",data:"<html><link rel='stylesheet' href='site.css'><h1>One</h1></html>"},
      {name:"site.css",data:"body{color:blue}"}
    ])]),"multi.zip");
    const multi=await app.api("/api/projects",{method:"POST",body:form});
    assert.equal(multi.status,201,JSON.stringify(multi.json));
    const editor=await app.api("/api/projects/"+multi.json.id+"/html-editor");
    assert.equal(editor.status,409);
    assert.equal(editor.json.code,"EDITOR_MULTIFILE_UNSUPPORTED");
    assert.equal((await app.api("/api/projects/"+multi.json.id+"/versions")).json.versions.length,1);

    const id=crypto.randomUUID();
    const root=path.join(app.dataDir,id);
    await fs.mkdir(root,{recursive:true});
    const html="<html><body>Legacy</body></html>";
    await fs.writeFile(path.join(root,"index.html"),html);
    const meta={id,name:"Legacy",createdAt:new Date().toISOString(),secret:"never-copy"};
    await fs.writeFile(path.join(root,"meta.json"),JSON.stringify(meta));
    // Legacy metadata reports fileCount=1 even if assets exist on disk;
    // editor must inspect the actual tree instead of silently dropping CSS.
    await fs.writeFile(path.join(root,"additional.css"),"body{color:red}");
    const unsafeLegacy=await app.api("/api/projects/"+id+"/html-editor");
    assert.equal(unsafeLegacy.status,409);
    assert.equal(unsafeLegacy.json.code,"EDITOR_MULTIFILE_UNSUPPORTED");
    await fs.rm(path.join(root,"additional.css"));
    const first=await app.api("/api/projects/"+id+"/html-editor");
    assert.equal(first.status,200,JSON.stringify(first.json));
    assert.equal(first.json.html,html);
    assert.doesNotMatch(JSON.stringify(first.json),/never-copy/);
    const saved=await app.api("/api/projects/"+id+"/html-editor/publish",{
      method:"POST",...body({baseVersion:1,baseSha256:first.json.sha256,
        html:"<html><body>New</body></html>"})
    });
    assert.equal(saved.status,201);
    const v2=path.join(root,"versions","2");
    assert.deepEqual(await fs.readdir(v2),["index.html"]);
    assert.equal(await fs.readFile(path.join(root,"index.html"),"utf8"),html);
    assert.match(await fs.readFile(path.join(root,"meta.json"),"utf8"),/never-copy/);
  }finally{await app.stop();await app.cleanup();}
});

test("RC21A rejects invalid editor revision, invalid HTML, trashed projects and unauthorized users",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try{
    const p=await app.api("/api/projects",create({name:"Editor security",
      html:"<html><body>Private</body></html>"}));
    const id=p.json.id,endpoint="/api/projects/"+id+"/html-editor";
    assert.equal((await app.api(endpoint,{token:null})).status,401);
    assert.equal((await app.api(endpoint+"/publish",{
      method:"POST",token:null,...body({baseVersion:1,baseSha256:"0".repeat(64),html:"<html>x</html>"})
    })).status,401);
    const key=await app.api("/api/projects/"+id+"/deploy-keys",create({}));
    assert.equal(key.status,201);
    assert.equal((await app.api(endpoint,{token:key.json.token})).status,403);
    const member=await app.api("/api/users",create({name:"Reader",email:"rc21@example.net"}));
    assert.equal(member.status,201);
    const grantPath="/api/projects/"+id+"/members/"+member.json.id;
    assert.equal((await app.api(grantPath,{method:"PUT",...body({role:"viewer"})})).status,200);
    assert.equal((await app.api(endpoint,{token:member.json.token})).status,200);
    const first=(await app.api(endpoint)).json;
    assert.equal((await app.api(endpoint+"/publish",{
      token:member.json.token,method:"POST",...body({baseVersion:1,baseSha256:first.sha256,
        html:"<html><body>malicious</body></html>"})
    })).status,403);
    const invalid=[
      {baseVersion:0,baseSha256:first.sha256,html:"<html>x</html>"},
      {baseVersion:1,baseSha256:"invalid",html:"<html>x</html>"},
      {baseVersion:1,baseSha256:first.sha256,html:"not html"},
      {baseVersion:1,baseSha256:first.sha256,html:"<html>"+"汉".repeat(65000)+"</html>"}
    ];
    for(const payload of invalid){
      const res=await app.api(endpoint+"/publish",{method:"POST",...body(payload)});
      assert.ok([400,413].includes(res.status),JSON.stringify(res.json));
    }
    assert.equal((await app.api("/api/projects/"+id)).json.versionCount,1);
    await app.api(grantPath,{method:"PUT",...body({role:"editor"})});
    const saved=await app.api(endpoint+"/publish",{
      token:member.json.token,method:"POST",...body({
        baseVersion:1,baseSha256:first.sha256,html:"<html><p>New via editor member</p></html>"
      })
    });
    assert.equal(saved.status,201,JSON.stringify(saved.json));
    await app.api("/api/projects/"+id,{method:"PATCH",...body({lifecycleState:"trashed"})});
    assert.equal((await app.api(endpoint)).status,409);
    assert.equal((await app.api(endpoint,{token:member.json.token})).status,404);
  }finally{await app.stop();await app.cleanup();}
});

test("RC21A workbench offers inert HTML draft preview, unsaved guard, and clear no-overwrite messaging",async()=>{
  const app=await startServer();
  try{
    const html=await(await fetch(app.apiBase+"/console")).text();
    for(const id of ["openHtmlEditorBtn","htmlEditorDialog","htmlEditorSource",
      "htmlEditorPreview","htmlEditorPreviewBtn","htmlEditorStatus",
      "publishHtmlEditorBtn","htmlEditorByteCount"]) {
      assert.match(html,new RegExp('id="'+id+'"'),id);
    }
    assert.match(html,/sandbox=""/);
    assert.match(html,/script-src 'none'/);
    assert.match(html,/baseSha256:htmlEditorBase\.sha256/);
    assert.match(html,/EDITOR_VERSION_CONFLICT/);
    assert.match(html,/EDITOR_MULTIFILE_UNSUPPORTED/);
    assert.match(html,/window\.confirm\("存在未保存的 HTML 修改/);
    assert.match(html,/sessionPrincipal\.type==="member"&&selected\.role!=="editor"/);
    assert.doesNotMatch(html,/eval\(\s*htmlEditorSource/);
  }finally{await app.stop();await app.cleanup();}
});
