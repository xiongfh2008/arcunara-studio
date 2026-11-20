import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {startServer} from "./helpers/harness.mjs";
import {filesZip} from "./helpers/zipbuilder.mjs";

const json=value=>({headers:{"content-type":"application/json"},body:JSON.stringify(value)});
const post=value=>({method:"POST",...json(value)});
async function createMulti(app){
  const form=new FormData();
  form.set("name","Multi-file RC21");
  form.set("file",new Blob([filesZip([
    {name:"index.html",data:"<html><head><link rel='stylesheet' href='assets/style.css'></head><body><h1>v1</h1><script src='assets/app.js'></script></body></html>"},
    {name:"assets/style.css",data:"body{color:blue}"},
    {name:"assets/app.js",data:"console.log('old')"},
    {name:"assets/logo.png",data:Buffer.from([137,80,78,71,0,4,99])}
  ])]),"website.zip");
  const r=await app.api("/api/projects",{method:"POST",body:form});
  assert.equal(r.status,201,JSON.stringify(r.json));
  return r.json.id;
}
const source=id=>"/api/projects/"+id+"/source";

test("RC21B edits HTML/CSS/JS independently, creates/deletes files and preserves binary assets and v1",async()=>{
  const app=await startServer();
  try{
    const id=await createMulti(app),base=source(id);
    const list=await app.api(base+"/files");
    assert.equal(list.status,200,JSON.stringify(list.json));
    assert.equal(list.json.baseVersion,1);
    assert.equal(list.json.files.length,4);
    const image=list.json.files.find(f=>f.path==="assets/logo.png");
    assert.equal(image.editable,false);
    assert.match(list.json.baseRevision,/^[0-9a-f]{64}$/);
    const code=await app.api(base+"/file?path=assets%2Fapp.js");
    assert.equal(code.status,200);
    assert.equal(code.json.content,"console.log('old')");
    const html=await app.api(base+"/file?path=index.html");
    assert.match(html.json.content,/v1/);
    const save=await app.api(base+"/publish",post({
      baseVersion:list.json.baseVersion,baseRevision:list.json.baseRevision,
      changes:[
        {path:"index.html",content:"<html><body><h1>new prototype</h1></body></html>"},
        {path:"assets/app.js",content:"console.log('new')"},
        {path:"assets/style.css",remove:true},
        {path:"assets/theme.css",content:"body{color:green}"}
      ]
    }));
    assert.equal(save.status,201,JSON.stringify(save.json));
    assert.equal(save.json.version,2);
    const oldPath=path.join(app.dataDir,id,"versions","1");
    const newPath=path.join(app.dataDir,id,"versions","2");
    assert.match(await fs.readFile(path.join(oldPath,"index.html"),"utf8"),/v1/);
    assert.equal(await fs.readFile(path.join(oldPath,"assets","app.js"),"utf8"),"console.log('old')");
    assert.equal(await fs.readFile(path.join(newPath,"assets","app.js"),"utf8"),"console.log('new')");
    assert.equal(await fs.readFile(path.join(newPath,"assets","theme.css"),"utf8"),"body{color:green}");
    assert.deepEqual(await fs.readFile(path.join(newPath,"assets","logo.png")),
      await fs.readFile(path.join(oldPath,"assets","logo.png")));
    await assert.rejects(fs.stat(path.join(newPath,"assets","style.css")));
    assert.equal((await app.api("/api/projects/"+id+"/versions")).json.versions.length,2);
    const list2=await app.api(base+"/files");
    const noChange=await app.api(base+"/publish",post({
      baseVersion:list2.json.baseVersion,baseRevision:list2.json.baseRevision,
      changes:[{path:"assets/theme.css",content:"body{color:green}"}]
    }));
    assert.equal(noChange.status,200);
    assert.equal(noChange.json.unchanged,true);
  }finally{await app.stop();await app.cleanup();}
});

test("RC21B stale editor changes cannot overwrite another save or upload",async()=>{
  const app=await startServer();
  try{
    const id=await createMulti(app),base=source(id);
    const manifest=(await app.api(base+"/files")).json;
    const data=content=>({baseVersion:manifest.baseVersion,baseRevision:manifest.baseRevision,
      changes:[{path:"assets/app.js",content}]});
    const results=await Promise.all([
      app.api(base+"/publish",post(data("console.log('Alice')"))),
      app.api(base+"/publish",post(data("console.log('Bob')")))
    ]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    assert.equal(results.find(r=>r.status===409).json.code,"EDITOR_VERSION_CONFLICT");
    assert.equal((await app.api("/api/projects/"+id)).json.versionCount,2);
    const manifest2=(await app.api(base+"/files")).json;
    const external=await app.api("/api/projects/"+id+"/versions",post({
      html:"<html><body>Separate AI upload</body></html>"
    }));
    assert.equal(external.status,201);
    const stale=await app.api(base+"/publish",post({
      baseVersion:manifest2.baseVersion,baseRevision:manifest2.baseRevision,
      changes:[{path:"assets/app.js",content:"conflicted"}]
    }));
    assert.equal(stale.status,409);
    assert.equal(stale.json.code,"EDITOR_VERSION_CONFLICT");
  }finally{await app.stop();await app.cleanup();}
});

test("RC21B never permits path traversal, unsafe extensions, source spoofing, RBAC bypass or binary overwrite",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try{
    const id=await createMulti(app),base=source(id),manifest=(await app.api(base+"/files")).json;
    const token=(await app.api("/api/users",post({name:"Member",email:"rc21b@example.org"}))).json;
    await app.api("/api/projects/"+id+"/members/"+token.id,{
      method:"PUT",...json({role:"viewer"})});
    assert.equal((await app.api(base+"/files",{token:token.token})).status,200);
    assert.equal((await app.api(base+"/file?path=index.html",{token:token.token})).status,200);
    assert.equal((await app.api(base+"/publish",{method:"POST",token:token.token,
      ...json({baseVersion:1,baseRevision:manifest.baseRevision,
        changes:[{path:"assets/app.js",content:"hacked"}]})})).status,403);
    const key=await app.api("/api/projects/"+id+"/deploy-keys",post({}));
    assert.equal((await app.api(base+"/files",{token:key.json.token})).status,403);
    assert.equal((await app.api(base+"/files",{token:null})).status,401);
    for(const loc of ["../meta.json","assets/%2e%2e%2fmeta.json","assets%5capp.js"]){
      const res=await app.api(base+"/file?path="+loc);
      assert.ok([400,404].includes(res.status),loc+" "+res.status);
    }
    const bad=[
      {path:"../meta.json",content:"hi"},
      {path:"assets/logo.png",content:"hacked"},
      {path:"meta.json",content:"secret"},
      {path:"new.exe",content:"bad"},
      {path:"assets/app.js",content:"a".repeat(180100)},
      {path:"index.html",remove:true}
    ];
    for(const change of bad){
      const res=await app.api(base+"/publish",post({
        baseVersion:1,baseRevision:manifest.baseRevision,changes:[change]
      }));
      assert.ok(res.status>=400&&res.status<500,change.path+" "+res.status);
    }
    await app.api("/api/projects/"+id+"/members/"+token.id,{
      method:"PUT",...json({role:"editor"})});
    const success=await app.api(base+"/publish",{
      token:token.token,method:"POST",...json({
        baseVersion:1,baseRevision:manifest.baseRevision,
        changes:[{path:"assets/app.js",content:"console.log('editor')"}]
      })
    });
    assert.equal(success.status,201,JSON.stringify(success.json));
    assert.equal((await app.api("/api/projects/"+id)).json.versionCount,2);
  }finally{await app.stop();await app.cleanup();}
});

test("RC21 publish-current explicitly pins the public site; editing and rollback are never implicit publication",async()=>{
  const app=await startServer({
    ARCU_SITE_HOSTING_ENABLED:"1",ARCU_SITE_DOMAIN:"sites.arcunara.test",
    ARCU_SITE_PORT:"0",ARCU_SITE_HOST:"127.0.0.1"
  });
  try{
    const id=await createMulti(app),base=source(id);
    const patch=val=>app.api("/api/projects/"+id,{method:"PATCH",...json(val)});
    assert.equal((await app.site(id,"/")).status,404);
    let r=await patch({siteEnabled:true});
    assert.equal(r.status,200);
    assert.equal(r.json.siteVersion,1);
    assert.equal((await app.site(id,"/")).status,200);
    const manifest=(await app.api(base+"/files")).json;
    const save=await app.api(base+"/publish",post({
      baseVersion:1,baseRevision:manifest.baseRevision,
      changes:[{path:"index.html",content:"<html><body>new unpublished page</body></html>"}]
    }));
    assert.equal(save.status,201);
    const detail=(await app.api("/api/projects/"+id)).json;
    assert.equal(detail.currentVersion,2);
    assert.equal(detail.siteVersion,1);
    assert.equal(detail.hasUnpublishedChanges,true);
    assert.match(await(await app.site(id,"/")).text(),/v1/);
    assert.match(await(await app.preview("/p/"+id+"/")).text(),/new unpublished page/);
    await patch({siteEnabled:true});
    assert.match(await(await app.site(id,"/")).text(),/new unpublished page/);
    await app.api("/api/projects/"+id+"/rollback",post({version:1}));
    assert.match(await(await app.site(id,"/")).text(),/new unpublished page/);
    await patch({siteEnabled:true});
    assert.match(await(await app.site(id,"/")).text(),/v1/);
    await patch({siteEnabled:false});
    assert.equal((await app.site(id,"/")).status,404);
  }finally{await app.stop();await app.cleanup();}
});

test("RC21B workbench has source tree, safe sandbox preview, explicit publish and AI draft review UI",async()=>{
  const app=await startServer();
  try{
    const html=await(await fetch(app.apiBase+"/console")).text();
    for(const id of ["openProjectFilesBtn","projectFilesDialog","projectFilesTree",
      "projectFilesSource","projectFilesDiff","projectFilesPreview",
      "saveProjectFilesBtn","projectFilesCreateBtn","projectFilesDeleteBtn",
      "republishCurrentBtn","openAiGenerateBtn","aiGenerateDialog",
      "aiGenerateActionBtn","aiGeneratedHtml","aiGeneratedPreview",
      "aiCreateProjectBtn"]){
      assert.match(html,new RegExp('id="'+id+'"'),id);
    }
    assert.match(html,/sandbox=""/);
    assert.match(html,/draftFrameCsp/);
    assert.match(html,/EDITOR_VERSION_CONFLICT/);
    assert.match(html,/source\/publish/);
    assert.match(html,/siteEnabled:true/);
    assert.doesNotMatch(html,/localStorage\.setItem\(/);
  }finally{await app.stop();await app.cleanup();}
});
