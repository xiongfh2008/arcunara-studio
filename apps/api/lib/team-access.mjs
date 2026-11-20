// RC20A: opt-in administrator-managed member identities and project RBAC.
// No self-registration, password login or public sessions. Issued bearer
// credentials are random, shown once and stored only as SHA-256 digests.
// All identity decisions re-read the on-disk registry; disabling/revoking
// a user or membership takes effect on the next request.
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ApiError } from "./httputil.mjs";

const REGISTRY = ".rc20-team.json";
const USER_ID = /^[0-9a-f]{16}$/;
const PROJECT_ID = /^[0-9a-f-]{36}$/;
const MEMBER_RE = /^Bearer uat_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const ROLES = new Set(["viewer","editor"]);
const EDITOR_ACTIONS = new Set(["POST versions","POST rollback","PATCH version-note"]);

export function parseMemberToken(value) {
  const match = MEMBER_RE.exec(value || "");
  return match ? {id:match[1],secret:match[2]} : null;
}

function digest(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}
function safeUser(user) {
  return {id:user.id,email:user.email,name:user.name,
    enabled:user.enabled !== false,passwordSet:Boolean(user.passwordHash),createdAt:user.createdAt,
    updatedAt:user.updatedAt};
}
function auditEvent(state,action,userId,projectId=null) {
  if(!Array.isArray(state.authAudit))state.authAudit=[];
  state.authAudit.push({at:new Date().toISOString(),action,userId,
    ...(projectId?{projectId}:{})});
  if(state.authAudit.length>200)state.authAudit=state.authAudit.slice(-200);
}
function newRegistry() {
  return {schema:"arcunara.team.v1",users:[],memberships:[]};
}
function validateRegistry(data) {
  if (!data || data.schema !== "arcunara.team.v1" ||
      !Array.isArray(data.users) || !Array.isArray(data.memberships)) {
    throw new ApiError(500,"Team registry is invalid","TEAM_REGISTRY_INVALID");
  }
  return data;
}
function newToken(id) {
  const secret = crypto.randomBytes(32).toString("base64url");
  return {token:"uat_"+id+"."+secret, tokenHash:digest(secret)};
}
function validEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s@<>]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(value);
}

export function createTeamAccess(config, store) {
  const enabled = config.teamAccessEnabled === true;
  const file = path.join(store.root,REGISTRY);

  function requireEnabled() {
    if (!enabled) throw new ApiError(404,"Not Found","TEAM_DISABLED");
  }
  async function load() {
    try {
      return validateRegistry(JSON.parse(await fs.readFile(file,"utf8")));
    } catch (err) {
      if (err.code === "ENOENT") return newRegistry();
      if (err instanceof ApiError) throw err;
      throw new ApiError(500,"Unable to read team registry","TEAM_REGISTRY_INVALID");
    }
  }
  async function save(data) {
    const tmp = path.join(store.root,
      ".rc20-team-"+crypto.randomBytes(8).toString("hex")+".tmp");
    try {
      await fs.writeFile(tmp,JSON.stringify(data),{flag:"wx",mode:0o600});
      await fs.rename(tmp,file);
    } catch (err) {
      await fs.rm(tmp,{force:true}).catch(()=>{});
      throw err;
    }
  }
  function locked(fn) {
    return store.withLock("__team_registry__",async()=>{
      const data=await load();
      const result=await fn(data);
      await save(data);
      return result;
    });
  }
  async function createUser({email,name}) {
    requireEnabled();
    if (!validEmail(email) || typeof name !== "string" ||
        !name.trim() || name.trim().length>100) {
      throw new ApiError(400,"Invalid name or email","TEAM_USER_INVALID");
    }
    const normalized=email.trim().toLowerCase();
    return locked(data=>{
      if (data.users.some(u=>u.email===normalized)) {
        throw new ApiError(409,"Member email already exists","TEAM_EMAIL_EXISTS");
      }
      let id=crypto.randomBytes(8).toString("hex");
      while(data.users.some(u=>u.id===id))id=crypto.randomBytes(8).toString("hex");
      const {token,tokenHash}=newToken(id);
      const now=new Date().toISOString();
      const user={id,email:normalized,name:name.trim(),enabled:true,
        tokenHash,createdAt:now,updatedAt:now};
      data.users.push(user);
      auditEvent(data,"member-created",id);
      return {...safeUser(user),token};
    });
  }
  async function listUsers() {
    requireEnabled();
    const data=await load();
    return data.users.map(safeUser).sort((a,b)=>a.email.localeCompare(b.email));
  }
  async function editUser(id,{enabled:next}) {
    requireEnabled();
    if (!USER_ID.test(id)||typeof next!=="boolean") {
      throw new ApiError(400,"Invalid user update","TEAM_USER_INVALID");
    }
    return locked(data=>{
      const user=data.users.find(u=>u.id===id);
      if(!user)throw new ApiError(404,"User not found","TEAM_USER_NOT_FOUND");
      user.enabled=next;
      if(next===false) {
        user.memberSessions=[];
        delete user.passwordInvite;
      }
      auditEvent(data,next?"member-enabled":"member-disabled",id);
      user.updatedAt=new Date().toISOString();
      return safeUser(user);
    });
  }
  async function rotateToken(id) {
    requireEnabled();
    if (!USER_ID.test(id)) throw new ApiError(404,"User not found","TEAM_USER_NOT_FOUND");
    return locked(data=>{
      const user=data.users.find(u=>u.id===id);
      if(!user)throw new ApiError(404,"User not found","TEAM_USER_NOT_FOUND");
      const {token,tokenHash}=newToken(id);
      user.tokenHash=tokenHash;
      user.memberSessions=[];
      auditEvent(data,"member-token-rotated",id);
      user.updatedAt=new Date().toISOString();
      return {...safeUser(user),token};
    });
  }
  async function authorize(id,secret) {
    if (!enabled || !USER_ID.test(id) || typeof secret !== "string") return null;
    const data=await load();
    const user=data.users.find(u=>u.id===id);
    if (!user || user.enabled===false || typeof user.tokenHash!=="string") return null;
    const expected=Buffer.from(user.tokenHash,"hex");
    const actual=Buffer.from(digest(secret),"hex");
    if (expected.length!==32 || !crypto.timingSafeEqual(expected,actual)) return null;
    return safeUser(user);
  }
  async function members(projectId) {
    requireEnabled();
    if (!PROJECT_ID.test(projectId)) throw new ApiError(404,"Not Found","PROJECT_NOT_FOUND");
    const project=await store.getProject(projectId);
    if (project.lifecycleState==="trashed") {
      throw new ApiError(409,"Project is in trash","PROJECT_TRASHED");
    }
    const data=await load();
    return data.memberships.filter(m=>m.projectId===projectId)
      .map(m=>{
        const u=data.users.find(x=>x.id===m.userId);
        return u?{...safeUser(u),role:m.role}:null;
      }).filter(Boolean);
  }
  async function setMember(projectId,userId,role) {
    requireEnabled();
    if(!PROJECT_ID.test(projectId)||!USER_ID.test(userId)) {
      throw new ApiError(404,"Not Found","PROJECT_OR_USER_NOT_FOUND");
    }
    if(!ROLES.has(role))throw new ApiError(400,"Invalid member role","TEAM_ROLE_INVALID");
    const project=await store.getProject(projectId);
    if (project.lifecycleState==="trashed") {
      throw new ApiError(409,"Project is in trash","PROJECT_TRASHED");
    }
    return locked(data=>{
      const user=data.users.find(u=>u.id===userId);
      if(!user)throw new ApiError(404,"User not found","TEAM_USER_NOT_FOUND");
      if(user.enabled===false)throw new ApiError(409,"User is disabled","TEAM_USER_DISABLED");
      const found=data.memberships.find(m=>m.projectId===projectId&&m.userId===userId);
      if(found)found.role=role;
      else data.memberships.push({projectId,userId,role});
      auditEvent(data,"project-role-"+role,userId,projectId);
      return {projectId,userId,role};
    });
  }
  async function removeMember(projectId,userId) {
    requireEnabled();
    if(!PROJECT_ID.test(projectId)||!USER_ID.test(userId)) {
      throw new ApiError(404,"Not Found","PROJECT_OR_USER_NOT_FOUND");
    }
    await store.getProject(projectId);
    return locked(data=>{
      const before=data.memberships.length;
      data.memberships=data.memberships.filter(m=>
        !(m.projectId===projectId&&m.userId===userId));
      if(data.memberships.length<before)
        auditEvent(data,"project-role-removed",userId,projectId);
      return {projectId,userId,removed:data.memberships.length<before};
    });
  }
  async function role(projectId,userId) {
    if(!enabled) return null;
    const data=await load();
    return data.memberships.find(m=>m.projectId===projectId&&m.userId===userId)?.role??null;
  }
  async function projectsForUser(userId) {
    requireEnabled();
    const data=await load();
    const roles=new Map(data.memberships.filter(m=>m.userId===userId)
      .map(m=>[m.projectId,m.role]));
    return (await store.listProjects())
      .filter(p=>roles.has(p.id)&&p.lifecycleState!=="trashed")
      .map(p=>({...p,role:roles.get(p.id)}));
  }
  async function membershipsForUser(userId) {
    requireEnabled();
    const data=await load();
    return data.memberships.filter(m=>m.userId===userId)
      .map(m=>({projectId:m.projectId,role:m.role}));
  }
  return {enabled,authorize,createUser,listUsers,editUser,rotateToken,
    members,setMember,removeMember,role,projectsForUser,membershipsForUser};
}

// Explicit allowlist. Nothing else is exposed to a member, including shares,
// team administration, deployment secrets, publishing, project lifecycle,
// project creation/deletion, preview-ticket minting or GitHub workflows.
export function memberAction(method,pathname,role) {
  if (!ROLES.has(role)) return false;
  const id="[0-9a-f-]{36}";
  const base=new RegExp("^/api/projects/"+id);
  const read=[
    new RegExp("^/api/projects/"+id+"$"),
    new RegExp("^/api/projects/"+id+"/versions$"),
    new RegExp("^/api/projects/"+id+"/html-editor$"),
    new RegExp("^/api/projects/"+id+"/source/files$"),
    new RegExp("^/api/projects/"+id+"/source/file$"),
    new RegExp("^/api/projects/"+id+"/compare-versions$"),
    new RegExp("^/api/projects/"+id+"/export$"),
    new RegExp("^/api/projects/"+id+"/axure-readiness$"),
    new RegExp("^/api/projects/"+id+"/axure-ir$"),
    new RegExp("^/api/projects/"+id+"/axure-rp1$")
  ];
  if (method==="GET" && read.some(re=>re.test(pathname))) return true;
  if (role!=="editor") return false;
  return (method==="POST" && (
    new RegExp("^/api/projects/"+id+"/versions$").test(pathname) ||
    new RegExp("^/api/projects/"+id+"/rollback$").test(pathname) ||
    new RegExp("^/api/projects/"+id+"/html-editor/publish$").test(pathname) ||
    new RegExp("^/api/projects/"+id+"/source/publish$").test(pathname)
  )) || (method==="PATCH" &&
    new RegExp("^/api/projects/"+id+"/versions/[0-9]+$").test(pathname));
}
