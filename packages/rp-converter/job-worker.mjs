#!/usr/bin/env node
// RC23: isolated, no-network worker. This program is NEVER imported by the
// API or preview listeners. It compiles only API-created pinned RP/1 jobs.
// Caller must mount project data READ-ONLY and .rp-jobs READ-WRITE.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateNativeSource, inspectNativeAssets } from "./native-inputs.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const here=path.dirname(fileURLToPath(import.meta.url));
const CLI=path.join(here,"local-cli.mjs");
const MiB=1024*1024;
const MAX_SPEC=8*MiB;
const MAX_RP=256*MiB;

const safeJson=async f=>JSON.parse(await fs.readFile(f,"utf8"));
async function sha256(p) {
  const hasher=crypto.createHash("sha256");
  const stream=(await import("node:fs")).createReadStream(p);
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}
async function saveState(dir,state) {
  const file=path.join(dir,"state.json");
  const tmp=path.join(dir,".state-"+crypto.randomBytes(5).toString("hex"));
  await fs.writeFile(tmp,JSON.stringify(state,null,2)+"\n",{mode:0o600,flag:"wx"});
  await fs.rename(tmp,file);
}
function safeJobDirectories(dataDir,projectId,version,storage) {
  const project=path.join(dataDir,projectId);
  if(!UUID.test(projectId)||!Number.isSafeInteger(version)||version<1)
    throw Error("Invalid signed job project/version");
  if(storage==="legacy-root")return project;
  if(storage==="versioned")return path.join(project,"versions",String(version));
  throw Error("Invalid job storage");
}
function execNode(args,{cwd,timeoutMs=600000,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env,shell:false,
      windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let logs="",size=0,timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},timeoutMs);
    const take=b=>{
      size+=b.length;
      if(logs.length<5000)logs+=b.toString("utf8").slice(0,5000-logs.length);
      if(size>512*1024)child.kill("SIGKILL");
    };
    child.stdout.on("data",take);child.stderr.on("data",take);
    child.on("error",err=>{clearTimeout(timeout);reject(err);});
    child.on("close",code=>{
      clearTimeout(timeout);
      if(timedOut)reject(Error("Native compiler timed out"));
      else if(size>512*1024)reject(Error("Native compiler emitted too much output"));
      else if(code!==0)reject(Error("Native compiler failed: "+logs.slice(-900)));
      else resolve();
    });
  });
}

export async function compileQueuedJob({
  dataDir,jobsDir,zeeRoot,jobId,run=execNode
}) {
  if(!UUID.test(jobId))throw Error("Invalid job id");
  const dir=path.join(jobsDir,jobId);
  const initial=await safeJson(path.join(dir,"state.json"));
  if(initial.status!=="queued")return false;
  const lock=path.join(dir,".worker.lock");
  let acquired=false;
  try {
    await fs.writeFile(lock,String(process.pid),{flag:"wx",mode:0o600});
    acquired=true;
  } catch(err) {
    if(err.code==="EEXIST")return false;
    throw err;
  }
  let request;
  try {
    request=await safeJson(path.join(dir,"request.json"));
    if(request.schema!=="arcunara.native-rp-job.v1"||
       request.id!==jobId)throw Error("Invalid job request");
    const expected=safeJobDirectories(
      path.resolve(dataDir),request.projectId,request.version,request.storage
    );
    if(path.resolve(request.sourceDirectory)!==expected)
      throw Error("Native job source path is not pinned");
    const source=path.join(dir,"source.rp1.json");
    const sourceStat=await fs.lstat(source);
    if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||
       sourceStat.size>MAX_SPEC||sourceStat.size<10)
      throw Error("Invalid native export spec file");
    if(await sha256(source)!==request.sourceSha256)
      throw Error("RP/1 source changed after job creation");
    const spec=await safeJson(source);
    validateNativeSource(spec);
    await inspectNativeAssets(spec,expected);
    await saveState(dir,{status:"running",updatedAt:new Date().toISOString()});
    const stage=path.join(dir,"stage");
    await run([CLI,"stage",source,expected,stage],{cwd:path.dirname(CLI),
      timeoutMs:120000});
    const staged=path.join(stage,"source.rp1.json");
    const output=path.join(dir,"output.rp");
    await run([CLI,"compile",staged,zeeRoot,output],{cwd:path.dirname(CLI),
      timeoutMs:780000});
    const stat=await fs.lstat(output);
    if(!stat.isFile()||stat.isSymbolicLink()||
       stat.size<128||stat.size>MAX_RP)
      throw Error("Invalid native RP compiler output");
    const verification=await safeJson(output+".verification.json");
    const hash=await sha256(output);
    if(verification.sourceTarget!==9||
       verification.status!=="engine-readback-passed-host-validation-pending"||
       verification.nativeRp11Certified!==false||
       verification.structuralReadback?.passed!==true||
       verification.structuralReadback.pages!==spec.pages.length||
       verification.outputSha256!==hash||
       verification.outputBytes!==stat.size)
      throw Error("Native RP compiler read-back verification failed");
    await saveState(dir,{status:"completed",updatedAt:new Date().toISOString(),
      outputBytes:stat.size,outputSha256:hash,engineReadbackPassed:true});
    console.log("Native export complete",jobId,"bytes",stat.size);
    return true;
  }catch(err){
    // Reject any partial/broken output. Never let the API return it.
    await fs.rm(path.join(dir,"output.rp"),{force:true}).catch(()=>{});
    await fs.rm(path.join(dir,"output.rp.verification.json"),{force:true}).catch(()=>{});
    await saveState(dir,{status:"failed",updatedAt:new Date().toISOString(),
      errorCode:"RP_COMPILE_FAILED",
      message:String(err.message||"Compilation failed").slice(0,180)});
    console.error("Native export failed",jobId);
    return true;
  } finally {
    if(acquired)await fs.rm(lock,{force:true}).catch(()=>{});
    // Temporary staged files, incl. source copies, are not downloadable.
    await fs.rm(path.join(dir,"stage"),{recursive:true,force:true}).catch(()=>{});
  }
}

async function main(){
  const dataDir=path.resolve(process.env.ARCU_DATA_DIR||"/app/data");
  const jobsDir=path.resolve(process.env.ARCU_RP_JOBS_DIR||"/app/rp-jobs");
  const zeeRoot=path.resolve(process.env.ARCU_ZEE_RP_ROOT||"/opt/zee-rp");
  const template=process.env.AXURE_BLANK_TEMPLATE_RP9;
  if(!template)throw Error("AXURE_BLANK_TEMPLATE_RP9 not configured");
  const st=await fs.lstat(template);
  if(!st.isFile()||st.isSymbolicLink()||st.size<128)
    throw Error("Blank Axure RP9 template is missing or unsafe");
  const pkg=await safeJson(path.join(zeeRoot,"package.json"));
  if(pkg.name!=="zee-rp")throw Error("Invalid pinned Zee-RP installation");
  await fs.mkdir(jobsDir,{recursive:true,mode:0o700});
  console.log("Native RP worker started: offline RP9 compiler");
  for(;;) {
    const entries=(await fs.readdir(jobsDir,{withFileTypes:true}))
      .filter(x=>x.isDirectory()&&UUID.test(x.name)).map(x=>x.name).sort();
    for(const id of entries){
      const state=await safeJson(path.join(jobsDir,id,"state.json")).catch(()=>null);
      if(state?.status==="queued"){
        await compileQueuedJob({dataDir,jobsDir,zeeRoot,jobId:id});
        break; // one compilation at a time
      }
      const request=await safeJson(path.join(jobsDir,id,"request.json")).catch(()=>null);
      if(request?.createdAt && Date.now()-Date.parse(request.createdAt)>24*3600*1000 &&
         (state?.status==="completed"||state?.status==="failed")){
        await fs.rm(path.join(jobsDir,id),{recursive:true,force:true});
      }
    }
    await delay(2000);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(err=>{console.error("Native worker startup failed:",err.message);process.exitCode=1;});
}
