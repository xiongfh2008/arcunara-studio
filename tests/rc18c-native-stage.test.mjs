import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspectNativeAssets, stageNativeBundle, validateNativeSource } from "../packages/rp-converter/native-inputs.mjs";

const CLI=fileURLToPath(new URL("../packages/rp-converter/local-cli.mjs",import.meta.url));
const source=(imageName="assets/picture.png")=>({
  language:"rp/1",target:9,name:"Conversion test",pages:[{
    id:"home",name:"主页",canvas:{w:1200,h:900},
    root:{type:"box",id:"root",layout:"stack",children:[
      {type:"label",id:"heading",text:"Hello",x:20,y:20,w:220,h:34},
      {type:"image",id:"picture",src:imageName,x:50,y:80,w:240,h:130}
    ]}
  }]
});
const invoke=(...args)=>spawnSync(process.execPath,[CLI,...args],{encoding:"utf8"});

test("RC18C stage copies referenced image assets, fingerprints and never overwrites",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-rc18c-stage-"));
  try{
    const inputs=path.join(dir,"original"),out=path.join(dir,"stage");
    await fs.mkdir(path.join(inputs,"assets"),{recursive:true});
    await fs.writeFile(path.join(inputs,"assets","picture.png"),"fake-image-test-bytes");
    await fs.writeFile(path.join(inputs,"private.js"),"SENSITIVE_SCRIPT");
    await fs.writeFile(path.join(inputs,".secret"),"PRIVATE_TOKEN");
    const specPath=path.join(dir,"origin.rp1.json");
    await fs.writeFile(specPath,JSON.stringify(source()));
    const response=invoke("stage",specPath,inputs,out);
    assert.equal(response.status,0,response.stderr);
    const staged=JSON.parse(response.stdout);
    assert.equal(staged.manifest.schema,"arcunara.native-stage.v1");
    assert.equal(staged.manifest.assets.length,1);
    assert.equal(staged.manifest.assets[0].path,"assets/picture.png");
    assert.match(staged.manifest.assets[0].sha256,/^[a-f0-9]{64}$/);
    assert.equal(staged.manifest.hostValidation.axureRP11,"not-run");
    assert.equal((await fs.readFile(path.join(out,"assets","picture.png"),"utf8")),"fake-image-test-bytes");
    assert.equal(JSON.parse(await fs.readFile(path.join(out,"source.rp1.json"),"utf8")).target,9);
    await assert.rejects(fs.stat(path.join(out,"private.js")),{code:"ENOENT"});
    await assert.rejects(fs.stat(path.join(out,".secret")),{code:"ENOENT"});
    assert.notEqual(invoke("stage",specPath,inputs,out).status,0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test("RC18C asset checks reject missing images, symlinks, traversal and nested destinations",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-rc18c-unsafe-"));
  try{
    const sourceDir=path.join(dir,"source"),root=path.join(sourceDir,"assets");
    await fs.mkdir(root,{recursive:true});
    const img=path.join(root,"inside.png");
    await fs.writeFile(img,"fine");
    const spec=source("assets/inside.png");
    const specPath=path.join(dir,"prototype.json");
    await fs.writeFile(specPath,JSON.stringify(spec));
    assert.equal((await inspectNativeAssets(spec,sourceDir)).files.length,1);
    await assert.rejects(stageNativeBundle(specPath,sourceDir,path.join(sourceDir,"nested-stage")),
      e=>e.code==="NATIVE_OUTPUT_LOCATION");
    await assert.rejects(inspectNativeAssets(source("assets/missing.png"),sourceDir),
      e=>e.code==="NATIVE_ASSET_MISSING");
    for(const name of ["../secret.png","/etc/passwd.png","https://site/file.png",
      "assets/../../escape.png","assets/.hidden.png","assets\\unsafe.png"]) {
      await assert.rejects(inspectNativeAssets(source(name),sourceDir),
        e=>e.code==="NATIVE_ASSET_PATH",name);
    }
    await fs.symlink(img,path.join(root,"linked.png"));
    await assert.rejects(inspectNativeAssets(source("assets/linked.png"),sourceDir),
      e=>e.code==="NATIVE_ASSET_UNSAFE");
    assert.throws(()=>validateNativeSource({
      ...spec,pages:[spec.pages[0],spec.pages[0]]
    }),/duplicate RP\/1 page/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// Deliberately MOCK Zee-RP: verifies subprocess wiring/cleanup/report status,
// NOT actual Axure .rp format or GUI interoperability.
async function mockZeeRp(dir) {
  const root=path.join(dir,"zee");
  await fs.mkdir(path.join(root,"scripts"),{recursive:true});
  await fs.writeFile(path.join(root,"package.json"),JSON.stringify({name:"zee-rp",version:"mock-rc18c"}));
  const lines=[
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const args=process.argv.slice(2),cmd=args[0];',
    'const arg=f=>args[args.indexOf(f)+1];',
    'if(cmd==="check"){ const s=JSON.parse(fs.readFileSync(arg("--spec"),"utf8")); process.exit(s.target===9?0:9); }',
    'if(cmd==="generate"){ const output=arg("--out-rp");fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.alloc(400,65));process.exit(0); }',
    'if(cmd==="decompile"){ if(process.env.MOCK_DECOMPILE_FAIL==="1")process.exit(6); fs.writeFileSync(arg("--out"),process.env.MOCK_RP1_SOURCE);process.exit(0); }',
    'process.exit(2);'
  ];
  await fs.writeFile(path.join(root,"scripts","proto.mjs"),lines.join("\n"));
  return root;
}
const noImages=()=>({
  ...source(),
  pages:[{...source().pages[0],root:{
    type:"box",id:"root",children:[{type:"label",id:"heading",text:"Hello"}]
  }}]
});

test("RC18C native compile verifies readback, writes sidecar and preserves no-host claim",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-rc18c-mock-"));
  try{
    const root=await mockZeeRp(dir),spec=noImages();
    const input=path.join(dir,"spec.rp1.json"),dest=path.join(dir,"native.rp");
    await fs.writeFile(input,JSON.stringify(spec));
    const env={...process.env,MOCK_RP1_SOURCE:JSON.stringify(spec)};
    const run=spawnSync(process.execPath,[CLI,"compile",input,root,dest],{encoding:"utf8",env});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(run.stdout).verification;
    assert.equal(result.sourceTarget,9);
    assert.equal(result.compiler.version,"mock-rc18c");
    assert.equal(result.structuralReadback.passed,true);
    assert.equal(result.structuralReadback.pages,1);
    assert.equal(result.status,"engine-readback-passed-host-validation-pending");
    assert.equal(result.nativeRp11Certified,false);
    assert.deepEqual(result.hostValidation.axureRP11,
      {opened:null,edited:null,saved:null,reopened:null});
    assert.match(result.outputSha256,/^[0-9a-f]{64}$/);
    assert.equal((await fs.stat(dest)).size,400);
    assert.equal(JSON.parse(await fs.readFile(dest+".verification.json","utf8")).nativeRp11Certified,false);
    assert.notEqual(spawnSync(process.execPath,[CLI,"compile",input,root,dest],{encoding:"utf8",env}).status,0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test("RC18C native compile fails closed when decompile fails or assets are missing",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-rc18c-fail-"));
  try{
    const root=await mockZeeRp(dir),spec=noImages();
    const input=path.join(dir,"spec.rp1.json"),dest=path.join(dir,"native.rp");
    await fs.writeFile(input,JSON.stringify(spec));
    const fail=spawnSync(process.execPath,[CLI,"compile",input,root,dest],{
      encoding:"utf8",env:{...process.env,MOCK_RP1_SOURCE:JSON.stringify(spec),MOCK_DECOMPILE_FAIL:"1"}
    });
    assert.notEqual(fail.status,0);
    await assert.rejects(fs.stat(dest),{code:"ENOENT"});
    await assert.rejects(fs.stat(dest+".verification.json"),{code:"ENOENT"});
    await fs.writeFile(input,JSON.stringify(source("assets/does-not-exist.png")));
    const absent=invoke("compile",input,root,dest);
    assert.notEqual(absent.status,0);
    assert.match(absent.stderr,/NATIVE_ASSET_MISSING/);
    await assert.rejects(fs.stat(dest),{code:"ENOENT"});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
