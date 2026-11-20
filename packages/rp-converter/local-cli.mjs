#!/usr/bin/env node
// RC18C: local opt-in native RP9 pipeline. NEVER imported by API / Preview.
// Fixed Zee-RP commands only: check -> generate -> decompile/readback.
// No shell, no remote execution, no hosted native compiler or RP11 claims.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { convertIRToRP1 } from "./rp1-bridge.mjs";
import { inspectNativeAssets, stageNativeBundle, validateNativeSource } from "./native-inputs.mjs";

const USAGE = [
  "Usage:",
  "  node packages/rp-converter/local-cli.mjs convert <arcunara-ir.json> <new.rp1.json>",
  "  node packages/rp-converter/local-cli.mjs stage <source.rp1.json> <extracted-version-dir> <new-stage-dir>",
  "  node packages/rp-converter/local-cli.mjs compile <source.rp1.json> <zee-rp-dir> <new-output.rp>",
  "",
  "Compile is LOCAL, opt-in, RP9-targeted; it cannot certify Axure RP11.",
  "Source images must be present beside source.rp1.json (use stage first).",
  "Output is written only after Zee-RP check, generate, and decompile pass."
].join("\n");

async function exists(p) {
  try { await fs.lstat(p); return true; }
  catch (err) { if (err.code === "ENOENT") return false; throw err; }
}
function readJson(file) {
  return fs.readFile(file, "utf8").then(text => JSON.parse(text));
}
async function sha256(file) {
  const data = await fs.readFile(file);
  return crypto.createHash("sha256").update(data).digest("hex");
}
function runCommand(executable,args,{cwd,timeoutMs}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{
      cwd,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]
    });
    let logs="", bytes=0, timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},timeoutMs);
    const take=chunk=>{
      bytes+=chunk.length;
      if(logs.length<120000)logs+=chunk.toString("utf8").slice(0,120000-logs.length);
      if(bytes>1024*1024)child.kill("SIGKILL");
    };
    child.stdout.on("data",take);
    child.stderr.on("data",take);
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",code=>{
      clearTimeout(timer);
      if(timedOut)return reject(new Error("Zee-RP command timed out"));
      if(bytes>1024*1024)return reject(new Error("Zee-RP stdout/stderr exceeded 1 MiB"));
      if(code!==0)return reject(new Error("Zee-RP exited "+code+":\n"+logs.slice(-2500)));
      resolve(logs);
    });
  });
}

async function nativeCompile(sourceFile,zeeRoot,outputPath) {
  const input=path.resolve(sourceFile);
  const root=path.resolve(zeeRoot);
  const output=path.resolve(outputPath);
  const reportPath=output+".verification.json";
  if(input===output||!output.toLowerCase().endsWith(".rp")||
      await exists(output)||await exists(reportPath)){
    throw new Error("Destination must be a NEW .rp file with unused verification sidecar");
  }

  const spec=await readJson(input);
  validateNativeSource(spec);
  // Images are not implicitly fetched, and an exported .rp will never
  // knowingly refer to a missing/symlinked asset.
  const inventory=await inspectNativeAssets(spec,path.dirname(input));
  const pkg=await readJson(path.join(root,"package.json"));
  if(pkg.name!=="zee-rp")throw new Error("Invalid Zee-RP directory");
  const compiler=path.join(root,"scripts","proto.mjs");
  const st=await fs.lstat(compiler);
  if(!st.isFile()||st.isSymbolicLink())throw new Error("Unsafe Zee-RP compiler path");
  const compilerSha256=await sha256(compiler);

  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-native-"));
  const tempRp=path.join(temp,"compile.rp");
  const readback=path.join(temp,"readback.json");
  let createdOutput=false,createdReport=false;
  try {
    await runCommand(process.execPath,[compiler,"check","--spec",input],{
      cwd:root,timeoutMs:120000
    });
    await runCommand(process.execPath,[compiler,"generate","--spec",input,
      "--out-dir",path.join(temp,"bundle"),"--out-rp",tempRp,"--backend","native"],{
      cwd:root,timeoutMs:480000
    });
    const result=await fs.lstat(tempRp);
    if(!result.isFile()||result.isSymbolicLink()||result.size<128||
        result.size>256*1024*1024){
      throw new Error("Zee-RP output failed file-size and type checks");
    }

    // Zee-RP's own decompiler performs a structured read-back. This is
    // stronger than checking file size, but NOT an Axure GUI roundtrip.
    await runCommand(process.execPath,[compiler,"decompile","--rp",tempRp,
      "--out",readback],{cwd:root,timeoutMs:120000});
    const decoded=await readJson(readback);
    if(!decoded||decoded.language!=="rp/1"||!Array.isArray(decoded.pages)||
        decoded.pages.length!==spec.pages.length){
      throw new Error("Zee-RP readback mismatch: RP/1 page count or language");
    }

    // COPYFILE_EXCL protects a file created by another process after
    // preflight. Only delete files that THIS invocation actually created.
    await fs.copyFile(tempRp,output,fsConstants.COPYFILE_EXCL);
    createdOutput=true;
    const resultHash=await sha256(output);
    const verification={
      schema:"arcunara.native-verification.v1",
      sourceLanguage:"rp/1",sourceTarget:9,
      outputFile:path.basename(output),
      outputBytes:result.size,outputSha256:resultHash,
      compiler:{name:pkg.name,version:pkg.version||null,protoSha256:compilerSha256},
      structuralReadback:{passed:true,pages:decoded.pages.length,engine:"zee-rp-decompile"},
      assets:inventory.files.map(x=>({path:x.path,bytes:x.bytes,sha256:x.sha256})),
      hostValidation:{
        axureRP9:{opened:null,edited:null,saved:null,reopened:null},
        axureRP11:{opened:null,edited:null,saved:null,reopened:null}
      },
      status:"engine-readback-passed-host-validation-pending",
      nativeRp11Certified:false
    };
    await fs.writeFile(reportPath,JSON.stringify(verification,null,2)+"\n",{
      flag:"wx",mode:0o600
    });
    createdReport=true;
    process.stdout.write(JSON.stringify({output,reportPath,verification},null,2)+"\n");
  }catch(err){
    if(createdReport)await fs.rm(reportPath,{force:true});
    if(createdOutput)await fs.rm(output,{force:true});
    throw err;
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
}

async function main(args) {
  const [command,...parameters]=args;
  if(command==="convert"&&parameters.length===2) {
    const [input,output]=parameters.map(p=>path.resolve(p));
    if(input===output||!output.endsWith(".json")||await exists(output)){
      throw new Error("Destination must be a NEW .json file distinct from input");
    }
    const ir=await readJson(input);
    const {spec,report}=convertIRToRP1(ir);
    await fs.writeFile(output,JSON.stringify(spec,null,2)+"\n",{
      flag:"wx",mode:0o600
    });
    process.stdout.write(JSON.stringify({output,report},null,2)+"\n");
    return;
  }
  if(command==="stage"&&parameters.length===3){
    const [source,assetsRoot,newDirectory]=parameters.map(p=>path.resolve(p));
    const staged=await stageNativeBundle(source,assetsRoot,newDirectory);
    process.stdout.write(JSON.stringify(staged,null,2)+"\n");
    return;
  }
  if(command==="compile"&&parameters.length===3){
    await nativeCompile(...parameters);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch(err=>{
  process.stderr.write((err?.code?"["+err.code+"] ":"")+
    (err?.message||String(err))+"\n");
  process.exitCode=1;
});
