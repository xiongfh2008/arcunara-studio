import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {startServer} from "./helpers/harness.mjs";

const authEnv={ARCU_TEAM_ACCESS_ENABLED:"1",ARCU_MEMBER_LOGIN_ENABLED:"1"};
const json = data => ({method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify(data)});
function browser(app,pathname,{method="GET",cookie="",body,csrf=true,origin=true,
  authorization=null}={}){
  const headers={};
  if(cookie)headers.cookie=cookie;
  if(csrf&&method!=="GET"&&method!=="HEAD")
    headers["x-arcunara-member-request"]="1";
  if(origin&&method!=="GET"&&method!=="HEAD")headers.origin=app.apiBase;
  if(body!==undefined){
    headers["content-type"]="application/json";
  }
  if(authorization)headers.authorization=authorization;
  return fetch(app.apiBase+pathname,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body)
  });
}
async function getJson(res){
  let body;
  try{body=await res.json();}catch{body=null;}
  return {status:res.status,json:body,headers:res.headers};
}
const adminPost=(app,url,data)=>app.api(url,json(data));
async function setup(app){
  const project=await adminPost(app,"/api/projects",{name:"Private Project",
    html:"<html><body>Private</body></html>"});
  assert.equal(project.status,201);
  const member=await adminPost(app,"/api/users",{name:"X Team Member",email:"x@example.net"});
  assert.equal(member.status,201);
  const grant=await app.api("/api/projects/"+project.json.id+
    "/members/"+member.json.id,{
      method:"PUT",headers:{"content-type":"application/json"},
      body:JSON.stringify({role:"viewer"})
    });
  assert.equal(grant.status,200);
  return {id:project.json.id,user:member.json};
}
async function activate(app,user,password="BetterPassphrase-1234"){
  const invite=await app.api("/api/users/"+user.id+"/invite",{method:"POST"});
  assert.equal(invite.status,201,JSON.stringify(invite.json));
  const result=await getJson(await browser(app,"/api/auth/activate",{
    method:"POST",body:{email:user.email,code:invite.json.code,password}
  }));
  assert.equal(result.status,200,JSON.stringify(result.json));
  return invite.json;
}
async function login(app,email,password){
  return getJson(await browser(app,"/api/auth/login",{
    method:"POST",body:{email,password}
  }));
}
const sessionFrom=resp=>resp.headers.get("set-cookie").split(";")[0];

test("RC20B remains completely disabled by default; administrator and RC20A continue",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try{
    assert.equal((await getJson(await browser(app,"/api/auth/login",{
      method:"POST",body:{email:"a@b.com",password:"abcdefghijkl"}}))).status,404);
    assert.equal((await app.api("/api/users/0011223344556677/invite",{method:"POST"})).status,404);
    const me=(await app.api("/api/me")).json;
    assert.equal(me.memberLoginEnabled,false);
    assert.equal(me.teamEnabled,true);
  }finally{await app.stop();await app.cleanup();}
});

test("RC20B invitation activation is one-time and login sessions preserve project RBAC",async()=>{
  const app=await startServer(authEnv);
  try{
    const {id,user}=await setup(app);
    const before=await login(app,user.email,"BetterPassphrase-1234");
    assert.equal(before.status,401);
    const invite=await app.api("/api/users/"+user.id+"/invite",{method:"POST"});
    assert.equal(invite.status,201);
    assert.match(invite.json.code,/^inv_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    const wrongOrigin=await getJson(await browser(app,"/api/auth/activate",{
      method:"POST",origin:false,body:{
        email:user.email,code:invite.json.code,password:"BetterPassphrase-1234"
      }
    }));
    assert.equal(wrongOrigin.status,403);
    const shortPwd=await getJson(await browser(app,"/api/auth/activate",{
      method:"POST",body:{email:user.email,code:invite.json.code,password:"short"}
    }));
    assert.equal(shortPwd.status,400);
    const result=await getJson(await browser(app,"/api/auth/activate",{
      method:"POST",body:{
        email:user.email,code:invite.json.code,password:"BetterPassphrase-1234"
      }
    }));
    assert.equal(result.status,200,JSON.stringify(result.json));
    const reused=await getJson(await browser(app,"/api/auth/activate",{
      method:"POST",body:{
        email:user.email,code:invite.json.code,password:"BetterPassphrase-1234"
      }
    }));
    assert.equal(reused.status,400);
    const disk=await fs.readFile(path.join(app.dataDir,".rc20-team.json"),"utf8");
    assert.ok(!disk.includes("BetterPassphrase-1234"));
    assert.ok(!disk.includes(invite.json.code));
    assert.match(disk,/scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}/);
    // Initial invite invalidates old personal bearer member tokens.
    assert.equal((await app.api("/api/projects",{token:user.token})).status,401);
    const logged=await login(app,user.email,"BetterPassphrase-1234");
    assert.equal(logged.status,200,JSON.stringify(logged.json));
    assert.equal(logged.json.type,"member");
    assert.match(logged.headers.get("set-cookie")||"",/HttpOnly/);
    assert.match(logged.headers.get("set-cookie")||"",/SameSite=Strict/);
    assert.match(logged.headers.get("set-cookie")||"",/Path=\/api/);
    const cookie=sessionFrom(logged);
    const me=await getJson(await browser(app,"/api/me",{cookie}));
    assert.equal(me.status,200);
    assert.equal(me.json.type,"member");
    assert.equal(me.json.user.email,user.email);
    const projects=await getJson(await browser(app,"/api/projects",{cookie}));
    assert.equal(projects.status,200);
    assert.deepEqual(projects.json.projects.map(x=>x.id),[id]);
    assert.equal(projects.json.projects[0].role,"viewer");
    assert.equal((await browser(app,"/api/projects/"+id+"/versions",{cookie})).status,200);
    assert.equal((await browser(app,"/api/projects/"+id+"/shares",{cookie})).status,403);
    assert.equal((await browser(app,"/api/projects/"+id+"/versions",{
      method:"POST",cookie,body:{html:"<html>wrong</html>"}
    })).status,403);
    const wrongBearer=await browser(app,"/api/me",{
      cookie,authorization:"Bearer invalid-token"
    });
    assert.equal(wrongBearer.status,401);
    const outsider=await browser(app,"/api/users",{cookie});
    assert.equal(outsider.status,403);
    const audit=(await app.api("/api/audit/auth")).json;
    assert.ok(audit.events.some(e=>e.action==="invite-issued"&&e.userId===user.id));
    assert.ok(audit.events.some(e=>e.action==="password-activated"&&e.userId===user.id));
    assert.ok(!JSON.stringify(audit).includes(cookie));
  }finally{await app.stop();await app.cleanup();}
});

test("RC20B logout, password change and administrative reset immediately revoke sessions",async()=>{
  const app=await startServer(authEnv);
  try{
    const {id,user}=await setup(app);
    await activate(app,user);
    const one=await login(app,user.email,"BetterPassphrase-1234");
    const two=await login(app,user.email,"BetterPassphrase-1234");
    assert.equal(one.status,200);
    assert.equal(two.status,200);
    const c1=sessionFrom(one),c2=sessionFrom(two);
    assert.equal((await browser(app,"/api/auth/session",{cookie:c1})).status,200);
    const noCsrf=await browser(app,"/api/auth/logout",{
      method:"POST",cookie:c1,csrf:false
    });
    assert.equal(noCsrf.status,403);
    assert.equal((await browser(app,"/api/auth/session",{cookie:c1})).status,200);
    const out=await browser(app,"/api/auth/logout",{method:"POST",cookie:c1});
    assert.equal(out.status,200);
    assert.match(out.headers.get("set-cookie")||"",/Max-Age=0/);
    assert.equal((await browser(app,"/api/auth/session",{cookie:c1})).status,401);
    assert.equal((await browser(app,"/api/auth/session",{cookie:c2})).status,200);
    const badOld=await browser(app,"/api/auth/change-password",{
      method:"POST",cookie:c2,body:{
        oldPassword:"wrong",newPassword:"SecondPassphrase#1"
      }
    });
    assert.equal(badOld.status,401);
    const change=await browser(app,"/api/auth/change-password",{
      method:"POST",cookie:c2,body:{
        oldPassword:"BetterPassphrase-1234",newPassword:"SecondPassphrase#1"
      }
    });
    assert.equal(change.status,200);
    assert.equal((await browser(app,"/api/auth/session",{cookie:c2})).status,401);
    assert.equal((await login(app,user.email,"BetterPassphrase-1234")).status,401);
    const third=await login(app,user.email,"SecondPassphrase#1");
    assert.equal(third.status,200);
    const c3=sessionFrom(third);
    // Admin recovery revokes existing sessions only when the reset code is consumed.
    const recovery=await app.api("/api/users/"+user.id+"/invite",{method:"POST"});
    assert.equal(recovery.status,201);
    assert.equal((await browser(app,"/api/me",{cookie:c3})).status,200);
    const reset=await browser(app,"/api/auth/activate",{
      method:"POST",body:{
        email:user.email,code:recovery.json.code,password:"FinalPassphrase#2"
      }
    });
    assert.equal(reset.status,200);
    assert.equal((await browser(app,"/api/me",{cookie:c3})).status,401);
    assert.equal((await login(app,user.email,"SecondPassphrase#1")).status,401);
    assert.equal((await login(app,user.email,"FinalPassphrase#2")).status,200);
    // Existing project ACL retained after recovery.
    assert.equal((await app.api("/api/projects/"+id)).status,200);
  }finally{await app.stop();await app.cleanup();}
});

test("RC20B rate limits repeated incorrect passwords and disabled accounts fail closed",async()=>{
  const app=await startServer(authEnv);
  try{
    const {user}=await setup(app);
    await activate(app,user);
    const active=await login(app,user.email,"BetterPassphrase-1234");
    assert.equal(active.status,200);
    const stillCookie=sessionFrom(active);
    for(let i=0;i<8;i++){
      const failed=await login(app,user.email,"BadPassword-012345");
      assert.equal(failed.status,401);
    }
    assert.equal((await login(app,user.email,"BetterPassphrase-1234")).status,429);
    const other=await app.api("/api/users/"+user.id,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({enabled:false})
    });
    assert.equal(other.status,200);
    // Disabled member sessions are not revived on re-enable.
    assert.equal((await browser(app,"/api/auth/session",{cookie:stillCookie})).status,401);
    const again=await app.api("/api/users/"+user.id,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({enabled:true})
    });
    assert.equal(again.status,200);
    assert.equal((await browser(app,"/api/auth/session",{cookie:stillCookie})).status,401);
  }finally{await app.stop();await app.cleanup();}
});
