// RC23: honest, opt-in native RP9 compile queue. The API only writes a
// validated RP/1 source and serves VERIFIED .rp bytes; it NEVER runs Zee-RP.
// A separate no-network Docker worker compiles/checks/decompiles. Nothing
// in this module treats RP/1 JSON as an Axure .rp.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { ApiError } from "./httputil.mjs";
import { buildEditableIR } from "../../../packages/rp-converter/ir.mjs";
import { convertIRToRP1 } from "../../../packages/rp-converter/rp1-bridge.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = new Set(["queued", "running"]);
const MAX_QUEUED = 3;
const MAX_JOBS = 20;
const MAX_SPEC = 8 * 1024 * 1024;
const MAX_RP = 256 * 1024 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
const STALE_AGE = 20 * 60 * 1000;

function fail(status, message, code) { throw new ApiError(status,message,code); }
function rootOf(config) { return path.join(path.resolve(config.store),".rp-jobs"); }
function jobPath(root,id) {
  if (!UUID.test(id)) fail(404,"Not Found","RP_JOB_NOT_FOUND");
  return path.join(root,id);
}
async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p,"utf8")); }
  catch(err){if(err.code==="ENOENT")return null;throw err;}
}
async function atomicJson(file,data) {
  const tmp=file+"."+crypto.randomBytes(6).toString("hex")+".tmp";
  await fs.writeFile(tmp,JSON.stringify(data,null,2)+"\n",{flag:"wx",mode:0o600});
  await fs.rename(tmp,file);
}
function assertEnabled(config) {
  if(!config.nativeRpExportEnabled)
    fail(503,"Native .rp export worker is not configured","RP_EXPORT_DISABLED");
}
async function readOwned(config,projectId,id) {
  const dir=jobPath(rootOf(config),id);
  const request=await readJson(path.join(dir,"request.json"));
  if(!request||request.projectId!==projectId)
    fail(404,"Not Found","RP_JOB_NOT_FOUND");
  const state=await readJson(path.join(dir,"state.json"));
  if(!state)fail(503,"Native export job has no state","RP_JOB_STATE_MISSING");
  return {dir,request,state};
}
function view(id,request,state) {
  return {
    id,projectId:request.projectId,version:request.version,
    status:state.status,
    target:"Axure RP9 (RP11 compatibility not verified)",
    sourceMapping:"static-editable-candidates",
    hostValidated:false,
    createdAt:request.createdAt,
    ...(state.updatedAt?{updatedAt:state.updatedAt}:{}),
    ...(state.status==="failed"?{errorCode:state.errorCode||"RP_COMPILE_FAILED",
      error:state.message||"Native compilation failed"}:{}),
    ...(state.status==="completed"?{downloadReady:true,outputBytes:state.outputBytes,
      engineReadbackPassed:true}:{}),
    warnings:request.warnings?.slice(0,25)||[],
    warningCount:request.warningCount||0,
    mappedWidgets:request.mappedWidgets||0
  };
}
export function createNativeRpJobs(config,store) {
  const root=rootOf(config);
  let creating=Promise.resolve();

  async function enqueue(projectId,version) {
    assertEnabled(config);
    if(!UUID.test(projectId))fail(404,"Not Found","PROJECT_NOT_FOUND");
    if(version!==undefined && (!Number.isSafeInteger(version)||version<1))
      fail(400,"Invalid version","INVALID_VERSION");
    // Synchronous API creation is serialized for rate limiting; the worker
    // never runs inside the privileged API process.
    const next=creating.catch(()=>{}).then(async()=>{
      const project=await store.getProject(projectId);
      if(project.lifecycleState==="trashed")fail(409,"Project in trash","PROJECT_TRASHED");
      const actualVersion=version??project.currentVersion;
      const meta=await store.readRawMeta(projectId);
      const versions=Array.isArray(meta.versions)?meta.versions:[await store.currentVersionEntry(projectId,meta)];
      const entry=versions.find(e=>e.version===actualVersion);
      if(!entry)fail(404,"Version not found","VERSION_NOT_FOUND");
      const originalSource=store.versionSourceDir(projectId,entry);
      const sourceDir=path.resolve(originalSource);
      const base=path.resolve(config.store,projectId);
      if(sourceDir!==base && !sourceDir.startsWith(base+path.sep))
        fail(500,"Invalid source directory","RP_SOURCE_UNSAFE");
      // Check rate limit before expensive HTML scanning.
      await fs.mkdir(root,{recursive:true,mode:0o700});
      const entries=await fs.readdir(root,{withFileTypes:true});
      let queued=0,live=0;
      for(const item of entries){
        if(!item.isDirectory()||!UUID.test(item.name))continue;
        live++;
        const state=await readJson(path.join(root,item.name,"state.json"));
        if(state && ACTIVE.has(state.status)){
          const updated=Date.parse(state.updatedAt||state.createdAt||"");
          if(Date.now()-updated<STALE_AGE)queued++;
        }
      }
      if(queued>=MAX_QUEUED||live>=MAX_JOBS)
        fail(429,"Native export job queue is full","RP_EXPORT_QUOTA");
      // Read an immutable version, never execute uploaded HTML or JavaScript.
      const ir=await buildEditableIR(store,projectId,actualVersion);
      const rp1=convertIRToRP1(ir,{projectName:project.name});
      const {spec,report}=rp1;
      if(report.status!=="source-only"||report.hostValidated!==false||
         spec.language!=="rp/1"||spec.target!==9)
        fail(500,"Unsupported native compiler input","RP_SOURCE_INVALID");
      const text=JSON.stringify(spec);
      if(Buffer.byteLength(text)>MAX_SPEC)
        fail(413,"RP/1 source exceeds export limit","RP_SOURCE_TOO_LARGE");
      const id=crypto.randomUUID();
      const dir=jobPath(root,id);
      await fs.mkdir(dir,{mode:0o700});
      try {
        const createdAt=new Date().toISOString();
        await fs.writeFile(path.join(dir,"source.rp1.json"),text+"\n",{flag:"wx",mode:0o600});
        const request={schema:"arcunara.native-rp-job.v1",id,projectId,
          version:actualVersion,storage:entry.storage||"versions",
          createdAt,sourceDirectory:sourceDir,
          sourceSha256:crypto.createHash("sha256").update(text+"\n").digest("hex"),
          mappedWidgets:report.mapped,warningCount:report.warnings.length,
          warnings:report.warnings.slice(0,25)};
        await atomicJson(path.join(dir,"request.json"),request);
        const state={status:"queued",createdAt,updatedAt:createdAt};
        await atomicJson(path.join(dir,"state.json"),state);
        return view(id,request,state);
      }catch(err){await fs.rm(dir,{recursive:true,force:true});throw err;}
    });
    creating=next.catch(()=>{});
    return next;
  }

  async function get(projectId,id) {
    assertEnabled(config);
    if(!UUID.test(projectId))fail(404,"Not Found","PROJECT_NOT_FOUND");
    const {request,state}=await readOwned(config,projectId,id);
    if(Date.now()-Date.parse(request.createdAt)>MAX_AGE)
      fail(410,"Export has expired","RP_JOB_EXPIRED");
    return view(id,request,state);
  }

  async function download(res,projectId,id) {
    assertEnabled(config);
    const {dir,request,state}=await readOwned(config,projectId,id);
    if(Date.now()-Date.parse(request.createdAt)>MAX_AGE)
      fail(410,"Export has expired","RP_JOB_EXPIRED");
    if(state.status!=="completed")fail(409,"Export is not ready","RP_JOB_NOT_READY");
    if(!state.engineReadbackPassed||!state.outputSha256)
      fail(409,"Export has not passed compiler read-back","RP_NOT_VALIDATED");
    const file=path.join(dir,"output.rp");
    const stat=await fs.lstat(file).catch(()=>null);
    if(!stat||!stat.isFile()||stat.isSymbolicLink()||
       stat.size<128||stat.size>MAX_RP||stat.size!==state.outputBytes)
      fail(409,"Verified RP artifact missing or invalid","RP_ARTIFACT_INVALID");
    const hasher=crypto.createHash("sha256");
    for await (const chunk of createReadStream(file)) hasher.update(chunk);
    const hash=hasher.digest("hex");
    if(hash!==state.outputSha256)
      fail(409,"RP artifact checksum mismatch","RP_ARTIFACT_INVALID");
    const name=`arcunara-${projectId}-v${request.version}-rp9.rp`;
    res.writeHead(200,{"Content-Type":"application/octet-stream",
      "Content-Length":stat.size,
      "Content-Disposition":`attachment; filename="${name}"`,
      "Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer"});
    createReadStream(file).pipe(res);
  }
  return {enqueue,get,download};
}
