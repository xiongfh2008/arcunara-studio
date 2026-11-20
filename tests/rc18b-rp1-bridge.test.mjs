import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";
import { convertIRToRP1 } from "../packages/rp-converter/rp1-bridge.mjs";

const CLI = fileURLToPath(new URL("../packages/rp-converter/local-cli.mjs",import.meta.url));
const json = value => ({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});

test("RC18B maps static widgets, links, geometry, and historical versions into RP/1 target 9",async()=>{
  const server=await startServer();
  try{
    const files=[
      ["index.html",'<html><head><title>项目概览</title></head><body><h1 style="position:absolute;left:30px;top:36px;width:260px;font-size:22px;color:#123456">Hello 世界</h1><p>Longer description</p><button style="width:180px;height:44px;background-color:#336699">提交</button><input placeholder="输入名称"><img src="assets/logo.png" alt="logo"><a href="details.html">Details</a><script>throw new Error("DO_NOT_EXECUTE")</script></body></html>'],
      ["details.html",'<html><head><title>详情页</title></head><body><h2>Detail</h2><a href="index.html">Back</a></body></html>'],
      ["assets/logo.png",Buffer.from([137,80,78,71,0])]
    ];
    const form=new FormData();
    form.set("name","RP1 fixture");
    form.set("file",new Blob([filesZip(files.map(([name,data])=>({name,data})))]),"prototype.zip");
    const created=await server.api("/api/projects",{method:"POST",body:form});
    assert.equal(created.status,201,JSON.stringify(created.json));
    const id=created.json.id;
    const url="/api/projects/"+id+"/axure-rp1";
    const response=await server.api(url+"?version=1");
    assert.equal(response.status,200,JSON.stringify(response.json));
    const {spec,report}=response.json;
    assert.equal(spec.language,"rp/1");
    assert.equal(spec.target,9);
    assert.equal(spec.name,"RP1 fixture");
    assert.equal(spec.pages.length,2);
    assert.equal(report.status,"source-only");
    assert.equal(report.nativeRpExportReady,false);
    assert.equal(report.hostValidated,false);
    assert.ok(report.warnings.some(x=>x.includes("SOURCE_IR:SCRIPT_INTERACTIONS_UNMAPPED")));
    const widgets=spec.pages[0].root.children;
    const heading=widgets.find(x=>x.text==="Hello 世界");
    assert.equal(heading.type,"label");
    assert.deepEqual([heading.x,heading.y,heading.w,heading.fontSize],[30,36,260,22]);
    assert.equal(heading.color,"#123456");
    assert.deepEqual(widgets.find(x=>x.text==="Details").on,{click:[{type:"link",page:"p002"}]});
    assert.equal(widgets.find(x=>x.type==="image").src,"assets/logo.png");
    assert.equal(widgets.find(x=>x.type==="input").placeholder,"输入名称");
    assert.doesNotMatch(JSON.stringify(response.json),/DO_NOT_EXECUTE/);
    assert.deepEqual((await server.api(url+"?version=1")).json,response.json);
    const v2=await server.api("/api/projects/"+id+"/versions",json({html:"<html><body><button>v2</button></body></html>"}));
    assert.equal(v2.status,201);
    assert.equal((await server.api(url)).json.spec.pages[0].root.children[0].text,"v2");
    assert.equal((await server.api(url+"?version=1")).json.spec.pages.length,2);
    assert.equal((await server.api("/api/projects/"+id)).json.currentVersion,2);
  }finally{await server.stop();await server.cleanup();}
});

test("RC18B RP/1 endpoint denies nonadmin access, invalid versions and trashed projects",async()=>{
  const server=await startServer();
  try{
    const created=await server.api("/api/projects",json({name:"Permissions",html:"<html><p>text</p></html>"}));
    const id=created.json.id,url="/api/projects/"+id+"/axure-rp1";
    assert.equal((await server.api(url,{token:null})).status,401);
    const key=await server.api("/api/projects/"+id+"/deploy-keys",json({}));
    assert.equal((await server.api(url,{token:key.json.token})).status,403);
    for(const q of ["?version=0","?version=-1","?version=1.1","?version=foo",
      "?version=1&version=1","?version=9007199254740993123"]) {
      const r=await server.api(url+q);
      assert.equal(r.status,400,q);
      assert.equal(r.json.code,"INVALID_VERSION");
    }
    assert.equal((await server.api(url+"?version=8")).status,404);
    await server.api("/api/projects/"+id,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    const blocked=await server.api(url);
    assert.equal(blocked.status,409);
    assert.equal(blocked.json.code,"PROJECT_TRASHED");
  }finally{await server.stop();await server.cleanup();}
});

test("RC18B downgrades missing image, external link, unsafe colors without pretending native output",()=>{
  const ir={schema:"arcunara.editable-ir.v1",status:"mapping-only",nativeRpExportReady:false,
    pages:[{id:"p001",sourcePath:"index.html",title:"Demo",warnings:["CSS_UNRESOLVED"],nodes:[
      {id:"w0001",type:"image",assetPath:"../secret"},
      {id:"w0002",type:"link",text:"External link"},
      {id:"w0003",type:"text",text:"ABC",style:{color:"url(javascript:alert(1))",backgroundColor:"#334455"}},
      {id:"w0004",type:"input",input:{kind:"date",placeholder:"Pick"}}
    ]}]};
  const {spec,report}=convertIRToRP1(ir);
  const widgets=spec.pages[0].root.children;
  assert.equal(widgets[0].type,"label");
  assert.match(widgets[0].text,/未映射/);
  assert.equal(widgets[1].type,"button");
  assert.ok(!("on" in widgets[1]));
  assert.ok(!("fill" in widgets[2]));
  assert.ok(!("color" in widgets[2]));
  assert.ok(widgets.every(x=>typeof x.x==="number"&&typeof x.y==="number"));
  assert.ok(report.downgraded>=3);
  assert.ok(report.warnings.some(x=>x.startsWith("IMAGE_REPLACED_WITH_LABEL:")));
  assert.ok(report.warnings.some(x=>x.startsWith("LINK_ACTION_DROPPED:")));
  assert.ok(report.warnings.some(x=>x.startsWith("LAYOUT_SYNTHESIZED:")));
  assert.equal(report.nativeRpExportReady,false);
  assert.equal(report.hostValidated,false);
});

test("RC18B rejects spoofed or duplicate intermediate model objects",()=>{
  const base={schema:"arcunara.editable-ir.v1",status:"mapping-only",nativeRpExportReady:false,
    pages:[{id:"p001",sourcePath:"index.html",title:"Demo",nodes:[{id:"w0001",type:"text",text:"Text"}]}]};
  assert.throws(()=>convertIRToRP1({...base,nativeRpExportReady:true}),/Expected Arcunara/);
  assert.throws(()=>convertIRToRP1({...base,pages:[base.pages[0],base.pages[0]]}),/duplicate IR page/);
  assert.throws(()=>convertIRToRP1({...base,pages:[{...base.pages[0],
    nodes:[base.pages[0].nodes[0],base.pages[0].nodes[0]]}]}),/duplicate IR widget/);
  assert.throws(()=>convertIRToRP1({...base,pages:[{...base.pages[0],
    nodes:Array.from({length:351},(_,i)=>({id:"w"+i,type:"text",text:"line"}))}]}),/element count/);
});

test("RC18B local CLI converts to RP/1 but refuses nonexistent Zee-RP native compiler",async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-rp1-test-"));
  try{
    const input=path.join(tmp,"ir.json"),output=path.join(tmp,"source.rp1.json");
    const ir={schema:"arcunara.editable-ir.v1",status:"mapping-only",nativeRpExportReady:false,
      pages:[{id:"p001",sourcePath:"index.html",title:"CLI",nodes:[{id:"w0001",type:"text",text:"Editable"}]}]};
    await fs.writeFile(input,JSON.stringify(ir));
    const result=spawnSync(process.execPath,[CLI,"convert",input,output],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    const spec=JSON.parse(await fs.readFile(output,"utf8"));
    assert.equal(spec.language,"rp/1");
    assert.equal(spec.target,9);
    assert.equal(spec.pages[0].root.children[0].text,"Editable");
    assert.notEqual(spawnSync(process.execPath,[CLI,"convert",input,output],{encoding:"utf8"}).status,0);
    const native=path.join(tmp,"fake.rp");
    const failure=spawnSync(process.execPath,[CLI,"compile",output,tmp,native],{encoding:"utf8"});
    assert.notEqual(failure.status,0);
    await assert.rejects(fs.stat(native),{code:"ENOENT"});
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test("RC18B console exposes RP/1 download and RP9/RP11 limitations",async()=>{
  const server=await startServer();
  try{
    const html=await(await fetch(server.apiBase+"/console")).text();
    assert.match(html,/id="downloadRp1SourceBtn"/);
    assert.match(html,/\/axure-rp1\?version=/);
    assert.match(html,/hostValidated !== false/);
    assert.match(html,/RP9/);
    assert.match(html,/RP11/);
  }finally{await server.stop();await server.cleanup();}
});
