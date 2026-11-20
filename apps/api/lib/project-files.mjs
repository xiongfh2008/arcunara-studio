// RC21B: source-tree inventory, content read, immutable multi-file editor.
// Only the independent project version tree is read. Uploaded code is never
// executed on the API host. A version CAS is checked inside store.addVersion.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ApiError } from "./httputil.mjs";
import { collisionKey, isValidSegment } from "./pathsafety.mjs";

const MAX_FILES=3000, MAX_BYTES=128*1024*1024, MAX_DEPTH=20;
const MAX_EDIT_BYTES=180000, MAX_CHANGES=16;
const REVISION=/^[0-9a-f]{64}$/;
const TEXT_EXT=new Set([".html",".htm",".css",".js",".mjs",".json",".txt",".md",".svg"]);
const sha=buffer=>crypto.createHash("sha256").update(buffer).digest("hex");
function validPath(value) {
  return typeof value==="string" && value.length>0 &&
    Buffer.byteLength(value,"utf8")<=256 &&
    value.split("/").length<=MAX_DEPTH &&
    value.split("/").every(x=>isValidSegment(x,{allowDotfiles:false})&&
      x.toLowerCase()!=="meta.json");
}
function editable(name){return TEXT_EXT.has(path.posix.extname(name).toLowerCase());}
function ensureCleanMeta(meta) {
  if(!meta)throw new ApiError(404,"Not Found","PROJECT_NOT_FOUND");
  if(meta.lifecycleState==="trashed")
    throw new ApiError(409,"Project is in trash","PROJECT_TRASHED");
}
async function readSafeFile(root,rel) {
  let dir=root;
  for(const [i,segment] of rel.split("/").entries()){
    dir=path.join(dir,segment);
    const st=await fs.lstat(dir);
    if(st.isSymbolicLink()||
      (i===rel.split("/").length-1?!st.isFile():!st.isDirectory()))
      throw new ApiError(409,"Unsafe project file","EDITOR_UNSAFE_ENTRY");
  }
  return fs.readFile(dir);
}
export async function scanVersionTree(root,{legacy=false}={}) {
  const files=[],directories=[],keys=new Set();
  let totalSize=0;
  async function walk(dir,prefix) {
    const entries=await fs.readdir(dir,{withFileTypes:true});
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries) {
      if(legacy&&!prefix &&
        ((entry.name==="meta.json"&&entry.isFile()) ||
         (entry.name==="versions"&&entry.isDirectory())))continue;
      const rel=prefix?prefix+"/"+entry.name:entry.name;
      if(!validPath(rel)||entry.isSymbolicLink() ||
         (!entry.isFile()&&!entry.isDirectory())) {
        throw new ApiError(409,"Unsafe source tree","EDITOR_UNSAFE_ENTRY");
      }
      const key=collisionKey(rel);
      if(keys.has(key))throw new ApiError(409,"Case-folding path collision","EDITOR_UNSAFE_ENTRY");
      keys.add(key);
      if(entry.isDirectory()) {
        directories.push(rel);
        await walk(path.join(dir,entry.name),rel);
      } else {
        if(files.length>=MAX_FILES)throw new ApiError(413,"Source has too many files","EDITOR_FILE_LIMIT");
        const actual=path.join(dir,entry.name);
        const buf=await fs.readFile(actual);
        totalSize+=buf.byteLength;
        if(totalSize>MAX_BYTES)throw new ApiError(413,"Source tree too large","EDITOR_SIZE_LIMIT");
        files.push({path:rel,bytes:buf.byteLength,sha256:sha(buf),
          editable:editable(rel)&&buf.byteLength<=MAX_EDIT_BYTES&&
            !buf.includes(0)&&buf.toString("utf8").includes("\uFFFD")===false});
      }
    }
  }
  const stat=await fs.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw new ApiError(409,"Unsafe version directory","EDITOR_UNSAFE_ENTRY");
  await walk(root,"");
  files.sort((a,b)=>a.path.localeCompare(b.path));
  directories.sort((a,b)=>a.localeCompare(b));
  const revision=sha(Buffer.from(JSON.stringify({files:files.map(x=>[
    x.path,x.bytes,x.sha256]),directories}),"utf8"));
  return {files,directories,totalSize,revision};
}
async function inspect(store,id) {
  const meta=await store.readRawMeta(id);
  ensureCleanMeta(meta);
  const entry=await store.currentVersionEntry(id,meta);
  const root=store.versionSourceDir(id,entry);
  const tree=await scanVersionTree(root,{legacy:entry.storage==="legacy-root"});
  return {entry,root,tree};
}
export async function listSourceFiles(store,id) {
  return store.withLock(id,async()=>{
    const {entry,tree}=await inspect(store,id);
    return {projectId:id,baseVersion:entry.version,baseRevision:tree.revision,
      entryPoint:entry.entryPoint,files:tree.files,directories:tree.directories,
      maxTextBytes:MAX_EDIT_BYTES,maxChanges:MAX_CHANGES,totalSize:tree.totalSize};
  });
}
export async function readSourceFile(store,id,requestedPath) {
  if(!validPath(requestedPath))
    throw new ApiError(400,"Invalid source path","EDITOR_PATH_INVALID");
  return store.withLock(id,async()=>{
    const {entry,root,tree}=await inspect(store,id);
    const file=tree.files.find(x=>x.path===requestedPath);
    if(!file)throw new ApiError(404,"Source file not found","EDITOR_FILE_NOT_FOUND");
    if(!file.editable)
      throw new ApiError(409,"File is binary or too large for editor","EDITOR_FILE_NOT_TEXT");
    const buf=await readSafeFile(root,file.path);
    if(sha(buf)!==file.sha256)
      throw new ApiError(409,"Source changed unexpectedly","EDITOR_VERSION_CONFLICT");
    return {projectId:id,version:entry.version,path:file.path,
      content:buf.toString("utf8"),sha256:file.sha256,baseRevision:tree.revision};
  });
}
function validateChanges(data) {
  const {baseVersion,baseRevision,changes}=data&&typeof data==="object"?data:{};
  if(!Number.isSafeInteger(baseVersion)||baseVersion<1 ||
     !REVISION.test(baseRevision||""))
    throw new ApiError(400,"Invalid base version","EDITOR_BASE_INVALID");
  if(!Array.isArray(changes)||changes.length<1||changes.length>MAX_CHANGES)
    throw new ApiError(400,"Expect 1–16 source changes","EDITOR_CHANGES_INVALID");
  const seen=new Set();
  for(const change of changes){
    if(!change||!validPath(change.path)||!editable(change.path))
      throw new ApiError(400,"Invalid editable path","EDITOR_PATH_INVALID");
    const key=collisionKey(change.path);
    if(seen.has(key))throw new ApiError(400,"Repeated file path","EDITOR_PATH_DUPLICATE");
    seen.add(key);
    if(change.remove===true) {
      if("content" in change)throw new ApiError(400,"Invalid remove operation","EDITOR_CHANGES_INVALID");
    } else if (typeof change.content!=="string" ||
        Buffer.byteLength(change.content,"utf8")>MAX_EDIT_BYTES ||
        change.content.includes("\0")){
      throw new ApiError(400,"Invalid text source or oversized file","EDITOR_CONTENT_INVALID");
    }
  }
  return {baseVersion,baseRevision,changes};
}
export async function publishSourceChanges(store,id,data) {
  const {baseVersion,baseRevision,changes}=validateChanges(data);
  const snapshot=await store.withLock(id,()=>inspect(store,id));
  if(snapshot.entry.version!==baseVersion||snapshot.tree.revision!==baseRevision)
    throw new ApiError(409,"Current version changed","EDITOR_VERSION_CONFLICT");
  const original=new Map(snapshot.tree.files.map(f=>[f.path,f]));
  const dirNames=new Set(snapshot.tree.directories.map(collisionKey));
  const fileKeys=new Set(snapshot.tree.files.map(f=>collisionKey(f.path)));
  const existingKeys=new Map(snapshot.tree.files.map(f=>[collisionKey(f.path),f.path]));
  for(const c of changes){
    if(c.path===snapshot.entry.entryPoint&&c.remove)
      throw new ApiError(400,"Cannot delete HTML entry point","EDITOR_ENTRY_REQUIRED");
    if(c.path===snapshot.entry.entryPoint &&
        (!/<html(?:\s|>)/i.test(c.content)||!/<\/html\s*>/i.test(c.content)))
      throw new ApiError(400,"Entry point must be complete HTML","EDITOR_HTML_INVALID");
    const parts=c.path.split("/");
    if(dirNames.has(collisionKey(c.path)) ||
       parts.slice(0,-1).some((_,i)=>fileKeys.has(
         collisionKey(parts.slice(0,i+1).join("/"))))) {
      throw new ApiError(409,"File and directory path conflict","EDITOR_PATH_COLLISION");
    }
    if(c.remove&&!original.has(c.path))
      throw new ApiError(404,"Cannot remove missing file","EDITOR_FILE_NOT_FOUND");
    const conflict=existingKeys.get(collisionKey(c.path));
    if(conflict && conflict!==c.path)
      throw new ApiError(409,"Case folding file collision","EDITOR_PATH_DUPLICATE");
    if(original.has(c.path)&&!original.get(c.path).editable)
      throw new ApiError(409,"Cannot overwrite binary file","EDITOR_FILE_NOT_TEXT");
  }
  const staged=store.stagingDir("source");
  await fs.mkdir(staged,{recursive:true,mode:0o700});
  try{
    for(const dir of snapshot.tree.directories)
      await fs.mkdir(path.join(staged,...dir.split("/")),{recursive:true});
    for(const file of snapshot.tree.files) {
      const data=await readSafeFile(snapshot.root,file.path);
      if(sha(data)!==file.sha256)
        throw new ApiError(409,"Source changed","EDITOR_VERSION_CONFLICT");
      const destination=path.join(staged,...file.path.split("/"));
      await fs.mkdir(path.dirname(destination),{recursive:true});
      await fs.writeFile(destination,data,{flag:"wx",mode:0o600});
    }
    for(const c of changes){
      const destination=path.join(staged,...c.path.split("/"));
      if(c.remove) {
        await fs.rm(destination);
      }else{
        await fs.mkdir(path.dirname(destination),{recursive:true});
        await fs.writeFile(destination,c.content,{mode:0o600});
      }
    }
    const manifest=await scanVersionTree(staged);
    if(!manifest.files.some(f=>f.path===snapshot.entry.entryPoint))
      throw new ApiError(400,"Missing entry HTML file","EDITOR_ENTRY_REQUIRED");
    if(manifest.revision===baseRevision){
      const fresh=await store.withLock(id,()=>inspect(store,id));
      if(fresh.entry.version!==baseVersion||fresh.tree.revision!==baseRevision)
        throw new ApiError(409,"Current version changed","EDITOR_VERSION_CONFLICT");
      return {projectId:id,version:baseVersion,currentVersion:baseVersion,unchanged:true};
    }
    return await store.addVersion(id,{
      stagedDir:staged,
      stats:{fileCount:manifest.files.length,totalSize:manifest.totalSize,
        entryPoint:snapshot.entry.entryPoint},
      expectedCurrentVersion:baseVersion,expectedManifestHash:baseRevision
    });
  }finally{
    await fs.rm(staged,{recursive:true,force:true}).catch(()=>{});
  }
}
