// RC20B — opt-in, administrator-invited password accounts and browser sessions.
// This is not open registration or verified email delivery. Existing RC20A
// bearer tokens, admin identity and deploy keys retain their exact semantics.
// Password and session decisions share the RC20A store lock and use fresh disk
// state on every request. Single-process storage only.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ApiError } from "./httputil.mjs";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "arcu_member_session";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const INVITE_TTL = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^inv_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const MAX_ACTIVE_SESSIONS = 5;
const SCRYPT_OPTIONS = {N:16384,r:8,p:1,maxmem:32*1024*1024};
const hash = str => crypto.createHash("sha256").update(str).digest("hex");
const equalHex = (a,b) => {
  if (typeof a!=="string" || !/^[0-9a-f]{64}$/.test(a))return false;
  const ab=Buffer.from(a,"hex"),bb=Buffer.from(b,"hex");
  return ab.length===bb.length && crypto.timingSafeEqual(ab,bb);
};
function passwordOk(value){
  return typeof value==="string" && value.length>=12 && value.length<=128 &&
    !value.includes("\0");
}
function normalizedEmail(email) {
  return typeof email==="string" ? email.trim().toLowerCase() : "";
}
function publicUser(user) {
  return {id:user.id,email:user.email,name:user.name,enabled:user.enabled!==false,
    passwordSet:Boolean(user.passwordHash),createdAt:user.createdAt,
    updatedAt:user.updatedAt};
}
async function hashPassword(password) {
  const salt=crypto.randomBytes(16).toString("hex");
  const key=await scrypt(password,Buffer.from(salt,"hex"),64,SCRYPT_OPTIONS);
  return "scrypt$"+salt+"$"+key.toString("hex");
}
async function verifyPassword(password,record) {
  const match=/^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/.exec(record||"");
  if(!match) return false;
  const actual=await scrypt(password,Buffer.from(match[1],"hex"),64,SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(actual,Buffer.from(match[2],"hex"));
}
function audit(data,type,userId) {
  if(!Array.isArray(data.authAudit))data.authAudit=[];
  data.authAudit.push({at:new Date().toISOString(),action:type,userId});
  if(data.authAudit.length>200)data.authAudit=data.authAudit.slice(-200);
}
function makeSecret(){return crypto.randomBytes(32).toString("base64url");}

export function createMemberPasswords(config,store) {
  const enabled=config.memberLoginEnabled===true;
  const filename=path.join(store.root,".rc20-team.json");
  const loginFailures=new Map();
  const activationFailures=new Map();
  const explicitOrigin=config.memberPublicOrigin||null;

  function requireEnabled(){
    if(!enabled)throw new ApiError(404,"Not Found","MEMBER_LOGIN_DISABLED");
  }
  function originFor(req){
    if(explicitOrigin) return explicitOrigin;
    // Development-only origin; the caller must be on loopback, not a
    // reverse proxy or public interface.
    if(req.socket.remoteAddress!=="127.0.0.1" ||
        req.socket.localAddress!=="127.0.0.1") return null;
    return "http://127.0.0.1:"+req.socket.localPort;
  }
  function trustedHost(req){
    if(!enabled)return false;
    const origin=originFor(req);
    if(!origin)return false;
    const url=new URL(origin);
    return req.headers.host===url.host &&
      (!explicitOrigin || (url.protocol==="https:" &&
        req.socket.localAddress==="127.0.0.1"));
  }
  function mutationAllowed(req){
    if(!trustedHost(req))return false;
    const s=req.headers["sec-fetch-site"];
    return req.headers.origin===originFor(req) &&
      req.headers["x-arcunara-member-request"]==="1" &&
      (!s||s==="same-origin");
  }
  function checkRequest(req) {
    requireEnabled();
    if(!mutationAllowed(req)) {
      throw new ApiError(403,"Origin or CSRF validation failed","MEMBER_CSRF_DENIED");
    }
  }
  async function load(){
    try{
      const state=JSON.parse(await fs.readFile(filename,"utf8"));
      if(state.schema!=="arcunara.team.v1"||!Array.isArray(state.users)||
          !Array.isArray(state.memberships)) throw Error("Invalid registry");
      return state;
    }catch(err){
      if(err.code==="ENOENT")return {schema:"arcunara.team.v1",users:[],memberships:[]};
      throw new ApiError(500,"Invalid member registry","TEAM_REGISTRY_INVALID");
    }
  }
  async function save(state){
    const tmp=path.join(store.root,".rc20-auth-"+crypto.randomBytes(8).toString("hex")+".tmp");
    try{
      await fs.writeFile(tmp,JSON.stringify(state),{flag:"wx",mode:0o600});
      await fs.rename(tmp,filename);
    }catch(err){
      await fs.rm(tmp,{force:true}).catch(()=>{});
      throw err;
    }
  }
  async function locked(fn){
    return store.withLock("__team_registry__",async()=>{
      const state=await load();
      const result=await fn(state);
      await save(state);
      return result;
    });
  }
  function sessionCookie(token,req){
    return COOKIE+"="+token+"; Path=/api; HttpOnly; SameSite=Strict; "+
      (originFor(req)?.startsWith("https:")?"Secure; ":"")+
      "Max-Age="+String(SESSION_TTL/1000);
  }
  function clearCookie(req){
    return COOKIE+"=; Path=/api; HttpOnly; SameSite=Strict; "+
      (originFor(req)?.startsWith("https:")?"Secure; ":"")+"Max-Age=0";
  }
  function cookieToken(req){
    if(!trustedHost(req)||req.headers.authorization)return null;
    const cookies=(req.headers.cookie||"").split(";")
      .map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+"="));
    if(cookies.length!==1)return null;
    const token=cookies[0].slice(COOKIE.length+1);
    return TOKEN_RE.test(token)?token:null;
  }
  async function authorizeSession(req){
    if(!enabled)return null;
    if(!["GET","HEAD","POST","PATCH","PUT","DELETE"].includes(req.method))return null;
    const token=cookieToken(req);
    if(!token)return null;
    if(!["GET","HEAD"].includes(req.method)&&!mutationAllowed(req))return null;
    const state=await load();
    const digest=hash(token);
    for(const user of state.users){
      if(user.enabled===false)continue;
      const session=(user.memberSessions||[]).find(s=>
        equalHex(s.digest,digest)&&s.expiresAt>Date.now());
      if(session)return {user:publicUser(user),sessionDigest:digest};
    }
    return null;
  }
  async function issueInvite(id){
    requireEnabled();
    if(!/^[0-9a-f]{16}$/.test(id))throw new ApiError(404,"User not found","TEAM_USER_NOT_FOUND");
    return locked(state=>{
      const user=state.users.find(u=>u.id===id);
      if(!user)throw new ApiError(404,"User not found","TEAM_USER_NOT_FOUND");
      if(user.enabled===false)throw new ApiError(409,"Account disabled","TEAM_USER_DISABLED");
      const secret=makeSecret(),expiresAt=Date.now()+INVITE_TTL;
      user.passwordInvite={hash:hash(secret),expiresAt};
      user.updatedAt=new Date().toISOString();
      audit(state,"invite-issued",id);
      return {userId:id,code:"inv_"+id+"."+secret,
        expiresAt:new Date(expiresAt).toISOString()};
    });
  }
  async function activate(value,req){
    requireEnabled();
    const {email,code,password}=value&&typeof value==="object"?value:{};
    const key=normalizedEmail(email)+"|"+String(req.socket.remoteAddress||"unknown");
    const time=Date.now();
    for(const [k,v] of activationFailures)if(v.until<=time)activationFailures.delete(k);
    const previous=activationFailures.get(key);
    if(previous?.count>=12&&previous.until>time) {
      throw new ApiError(429,"Too many activation attempts","MEMBER_ACTIVATE_RATE_LIMIT");
    }
    if(activationFailures.size>2000)activationFailures.delete(activationFailures.keys().next().value);
    activationFailures.set(key,{count:(previous?.count||0)+1,until:time+LOGIN_WINDOW});
    if(!passwordOk(password)) {
      throw new ApiError(400,"Password must be 12–128 characters","MEMBER_PASSWORD_POLICY");
    }
    const match=CODE_RE.exec(code||"");
    if(!match||!normalizedEmail(email)) {
      throw new ApiError(400,"Invalid or expired activation code","MEMBER_INVITE_INVALID");
    }
    const passwordHash=await hashPassword(password);
    return locked(state=>{
      const user=state.users.find(u=>u.id===match[1]);
      const invite=user?.passwordInvite;
      if(!user || user.enabled===false || user.email!==normalizedEmail(email) ||
          !invite || invite.expiresAt<=Date.now() ||
          !equalHex(invite.hash,hash(match[2]))) {
        throw new ApiError(400,"Invalid or expired activation code","MEMBER_INVITE_INVALID");
      }
      user.passwordHash=passwordHash;
      delete user.passwordInvite;
      user.memberSessions=[];
      // RC20A long-lived bearer tokens cannot silently remain valid after
      // password recovery or initial activation.
      user.tokenHash=null;
      user.updatedAt=new Date().toISOString();
      audit(state,"password-activated",user.id);
      activationFailures.delete(key);
      return {activated:true};
    });
  }
  async function login(value,req) {
    requireEnabled();
    const {email,password}=value&&typeof value==="object"?value:{};
    const key=normalizedEmail(email);
    if(!key || key.length>254||typeof password!=="string"||
        password.length>128)return {ok:false};
    const now=Date.now();
    for(const [k,v] of loginFailures) if(v.until<=now)loginFailures.delete(k);
    const clientKey=key+"|"+String(req.socket.remoteAddress||"unknown");
    if(loginFailures.size>2000)loginFailures.delete(loginFailures.keys().next().value);
    const attempt=loginFailures.get(clientKey);
    if(attempt?.count>=MAX_ATTEMPTS&&attempt.until>now){
      throw new ApiError(429,"Too many login attempts","MEMBER_LOGIN_RATE_LIMIT");
    }
    const state=await load();
    const user=state.users.find(x=>x.email===key&&x.enabled!==false);
    // Unknown user gets the same scrypt work to reduce email enumeration.
    const fallback="scrypt$"+"00".repeat(16)+"$"+"00".repeat(64);
    const verified=await verifyPassword(password,user?.passwordHash||fallback);
    if(!verified||!user){
      loginFailures.set(clientKey,{
        count:(attempt?.count||0)+1,until:now+LOGIN_WINDOW
      });
      return {ok:false};
    }
    loginFailures.delete(clientKey);
    const token=makeSecret();
    const sessionDigest=hash(token);
    const signedUser=await locked(data=>{
      const current=data.users.find(x=>x.id===user.id);
      if(!current||current.enabled===false ||
          current.passwordHash!==user.passwordHash){
        throw new ApiError(401,"Invalid login","MEMBER_LOGIN_INVALID");
      }
      const active=(current.memberSessions||[])
        .filter(s=>s.expiresAt>Date.now())
        .slice(-(MAX_ACTIVE_SESSIONS-1));
      current.memberSessions=[...active,{
        digest:sessionDigest,expiresAt:Date.now()+SESSION_TTL
      }];
      audit(data,"login",current.id);
      return publicUser(current);
    });
    return {ok:true,user:signedUser,cookie:sessionCookie(token,req)};
  }
  async function logout(req){
    requireEnabled();
    const token=cookieToken(req);
    if(!token)return;
    const digest=hash(token);
    await locked(data=>{
      for(const user of data.users){
        const before=(user.memberSessions||[]).length;
        user.memberSessions=(user.memberSessions||[])
          .filter(s=>!equalHex(s.digest,digest));
        if(user.memberSessions.length<before){
          audit(data,"logout",user.id);
          break;
        }
      }
    });
  }
  async function changePassword(userId,oldPassword,newPassword) {
    requireEnabled();
    if(!passwordOk(newPassword))throw new ApiError(400,
      "Password must be 12–128 characters","MEMBER_PASSWORD_POLICY");
    if(typeof oldPassword!=="string" || oldPassword.length>128)throw new ApiError(400,"Invalid password","MEMBER_PASSWORD_POLICY");
    const data=await load();
    const existing=data.users.find(x=>x.id===userId&&x.enabled!==false);
    if(!existing||!await verifyPassword(oldPassword,existing.passwordHash)){
      throw new ApiError(401,"Incorrect password","MEMBER_LOGIN_INVALID");
    }
    const newHash=await hashPassword(newPassword);
    await locked(state=>{
      const u=state.users.find(x=>x.id===userId);
      if(!u||u.enabled===false||u.passwordHash!==existing.passwordHash)
        throw new ApiError(401,"Session invalid","MEMBER_LOGIN_INVALID");
      u.passwordHash=newHash;
      u.memberSessions=[];
      u.tokenHash=null;
      u.updatedAt=new Date().toISOString();
      audit(state,"password-changed",u.id);
    });
    return {changed:true,requiresLogin:true};
  }
  async function logs(){
    requireEnabled();
    const data=await load();
    return (data.authAudit||[]).slice(-200).reverse();
  }
  return {enabled,checkRequest,trustedHost,mutationAllowed,authorizeSession,
    issueInvite,activate,login,logout,changePassword,logs,
    clearCookie,sessionCookie};
}
