// RC21A: read-only source inspection and safe staging for a single-file
// HTML prototype editor. Drafts are edited in-browser, never executed by
// the API; publishing creates a new immutable project version.
// Multi-file/ZIP projects are intentionally NOT flattened.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ApiError } from "./httputil.mjs";
import { isValidSegment } from "./pathsafety.mjs";

export const EDITOR_HTML_LIMIT = 180000; // matches legacy JSON upload
const MAX_SOURCE_BYTES = 180000;
const SHA256 = /^[0-9a-f]{64}$/;

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

function safeEntryPoint(entry) {
  const name=entry?.entryPoint;
  if(typeof name!=="string" || !/\.html?$/i.test(name) ||
      name.split("/").some(segment=>!isValidSegment(segment,{allowDotfiles:false})||
        segment.toLowerCase()==="meta.json")) {
    throw new ApiError(409,"Project entry is not safely editable","EDITOR_UNSAFE_ENTRY");
  }
  return name;
}

async function assertRegularFile(base,rel) {
  let position=base;
  const components=rel.split("/");
  for(let i=0;i<components.length;i++) {
    position=path.join(position,components[i]);
    const stat=await fs.lstat(position);
    if(stat.isSymbolicLink() || (i<components.length-1&&!stat.isDirectory()) ||
        (i===components.length-1&&!stat.isFile())) {
      throw new ApiError(409,"Unsafe project file","EDITOR_UNSAFE_ENTRY");
    }
  }
  return position;
}

async function assertSingleHtmlTree(root,expected,legacyRoot) {
  const rootInfo=await fs.lstat(root);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()) {
    throw new ApiError(409,"Unsafe version directory","EDITOR_UNSAFE_ENTRY");
  }
  const files=[];
  async function walk(dir,prefix) {
    const entries=await fs.readdir(dir,{withFileTypes:true});
    for(const item of entries) {
      // Legacy root keeps project administration files adjacent to index.html.
      // They are metadata, not editable HTML assets, and must never be copied.
      if(!prefix && legacyRoot && (
          (item.name==="meta.json"&&item.isFile()) ||
          (item.name==="versions"&&item.isDirectory())))continue;
      if(!isValidSegment(item.name,{allowDotfiles:false})) {
        throw new ApiError(409,"Unsafe project directory entry","EDITOR_UNSAFE_ENTRY");
      }
      if(item.isSymbolicLink()||(!item.isFile()&&!item.isDirectory())) {
        throw new ApiError(409,"Unsafe project directory entry","EDITOR_UNSAFE_ENTRY");
      }
      const relative=prefix?prefix+"/"+item.name:item.name;
      if(item.isDirectory()){
        const before=files.length;
        await walk(path.join(dir,item.name),relative);
        if(files.length===before) {
          throw new ApiError(409,"Project contains additional directories","EDITOR_MULTIFILE_UNSUPPORTED");
        }
      } else {
        files.push(relative);
        if(files.length>1) {
          throw new ApiError(409,"Project has additional assets","EDITOR_MULTIFILE_UNSUPPORTED");
        }
      }
    }
  }
  await walk(root,"");
  if(files.length!==1||files[0]!==expected) {
    throw new ApiError(409,"Project is not a single HTML file","EDITOR_MULTIFILE_UNSUPPORTED");
  }
}

export async function readEditableHtml(store,id) {
  return store.withLock(id,async()=>{
    const meta=await store.readRawMeta(id);
    if(!meta)throw new ApiError(404,"Not Found","PROJECT_NOT_FOUND");
    if(meta.lifecycleState==="trashed") {
      throw new ApiError(409,"Project is in trash","PROJECT_TRASHED");
    }
    const current=await store.currentVersionEntry(id,meta);
    if(current.fileCount!==1) {
      throw new ApiError(409,
        "Only single-file HTML versions can be edited here. Use ZIP upload for multi-file projects.",
        "EDITOR_MULTIFILE_UNSUPPORTED");
    }
    const filename=safeEntryPoint(current);
    const root=store.versionSourceDir(id,current);
    await assertSingleHtmlTree(root,filename,current.storage==="legacy-root");
    let full;
    try { full=await assertRegularFile(root,filename); }
    catch(err) {
      if(err instanceof ApiError)throw err;
      throw new ApiError(409,"Project entry is missing","EDITOR_UNSAFE_ENTRY");
    }
    const stat=await fs.lstat(full);
    if(stat.size<1||stat.size>MAX_SOURCE_BYTES) {
      throw new ApiError(413,"HTML source is too large for the editor","EDITOR_HTML_LIMIT");
    }
    const bytes=await fs.readFile(full);
    if(bytes.length>MAX_SOURCE_BYTES||bytes.includes(0)) {
      throw new ApiError(413,"HTML source is not supported","EDITOR_HTML_LIMIT");
    }
    const html=bytes.toString("utf8");
    if(!html.toLowerCase().includes("<html")||
        !Buffer.from(html,"utf8").equals(bytes)) {
      throw new ApiError(409,"Source is not valid UTF-8 HTML","EDITOR_INVALID_HTML");
    }
    return {
      projectId:id,version:current.version,entryPoint:filename,
      sha256:sha256(bytes),html,maxHtmlBytes:EDITOR_HTML_LIMIT,
      singleFile:true,scriptExecution:false
    };
  });
}

export async function publishEditedHtml(store,id,data) {
  const {baseVersion,baseSha256,html}=data&&typeof data==="object"?data:{};
  if(!Number.isSafeInteger(baseVersion)||baseVersion<1||
      typeof baseSha256!=="string"||!SHA256.test(baseSha256)) {
    throw new ApiError(400,"Invalid editor base version","EDITOR_BASE_INVALID");
  }
  if(typeof html!=="string" || Buffer.byteLength(html,"utf8")>EDITOR_HTML_LIMIT ||
      !html.toLowerCase().includes("<html")) {
    throw new ApiError(400,"Editor requires valid HTML under 180000 bytes","EDITOR_HTML_INVALID");
  }
  const original=await readEditableHtml(store,id);
  if(original.version!==baseVersion||original.sha256!==baseSha256){
    throw new ApiError(409,
      "Source changed since opening the editor; reload before saving",
      "EDITOR_VERSION_CONFLICT");
  }
  // No content change should not mint a pointless new project version.
  if(sha256(Buffer.from(html,"utf8"))===baseSha256) {
    return {projectId:id,version:baseVersion,currentVersion:baseVersion,
      unchanged:true,entryPoint:original.entryPoint};
  }
  const stagedDir=store.stagingDir("editor");
  await fs.mkdir(stagedDir,{recursive:true,mode:0o700});
  try{
    const destination=path.join(stagedDir,...original.entryPoint.split("/"));
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,html,{flag:"wx",mode:0o600});
    return await store.addVersion(id,{
      stagedDir,
      stats:{fileCount:1,totalSize:Buffer.byteLength(html,"utf8"),
        entryPoint:original.entryPoint},
      expectedCurrentVersion:baseVersion,
      expectedSourceSha256:baseSha256
    });
  }catch(err){
    await fs.rm(stagedDir,{recursive:true,force:true}).catch(()=>{});
    throw err;
  }
}
