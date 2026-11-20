import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";

const payload = (value) => ({
  headers: {"content-type":"application/json"},body:JSON.stringify(value)
});
const post = (value)=>({method:"POST",...payload(value)});
const patch = (value)=>({method:"PATCH",...payload(value)});
const put = (value)=>({method:"PUT",...payload(value)});
const userToken = token => token;

test("RC20A is off by default and preserves existing administrator and deploy-key behavior",async()=>{
  const app=await startServer();
  try {
    const c=await app.api("/api/projects",post({name:"Old admin",
      html:"<html><body>Old API</body></html>"}));
    assert.equal(c.status,201);
    const id=c.json.id;
    assert.deepEqual((await app.api("/api/me")).json,{type:"admin"});
    assert.equal((await app.api("/api/users")).status,404);
    assert.equal((await app.api("/api/users",post({name:"N",email:"n@example.com"}))).status,404);
    assert.equal((await app.api("/api/projects/"+id+"/members")).status,404);
    assert.equal((await app.api("/api/projects/"+id)).status,200);
    assert.equal((await app.api("/api/projects/"+id+"/versions")).status,200);
    const key=await app.api("/api/projects/"+id+"/deploy-keys",post({}));
    assert.equal(key.status,201);
    assert.equal((await app.api("/api/projects/"+id+"/versions",{
      token:key.json.token
    })).status,200);
    assert.equal((await app.api("/api/me",{token:key.json.token})).status,403);
    assert.equal((await app.api("/api/projects",{token:"uat_bad"})).status,401);
  }finally{await app.stop();await app.cleanup();}
});

test("RC20A creates once-only personal credentials and enforces viewer/editor project boundaries",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try {
    const first=await app.api("/api/projects",post({name:"Alpha",
      html:"<html><h1>alpha</h1></html>"}));
    const second=await app.api("/api/projects",post({name:"Beta",
      html:"<html><h1>beta</h1></html>"}));
    assert.equal(first.status,201);
    assert.equal(second.status,201);
    const alpha=first.json.id, beta=second.json.id;
    const created=await app.api("/api/users",post({email:"Test.User@example.com",name:"Test User"}));
    assert.equal(created.status,201,JSON.stringify(created.json));
    const user=created.json;
    assert.match(user.token,/^uat_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(user.email,"test.user@example.com");
    const registry=await fs.readFile(path.join(app.dataDir,".rc20-team.json"),"utf8");
    assert.ok(!registry.includes(user.token));
    assert.ok(!registry.includes(user.token.split(".")[1]));
    assert.match(registry,/tokenHash/);
    const list=await app.api("/api/users");
    assert.equal(list.status,200);
    assert.equal(list.json.users.length,1);
    assert.ok(!("token" in list.json.users[0]));
    const assigned=await app.api("/api/projects/"+alpha+"/members/"+user.id,
      put({role:"viewer"}));
    assert.equal(assigned.status,200);
    assert.equal(assigned.json.role,"viewer");
    assert.equal((await app.api("/api/projects/"+alpha+"/members")).json.members[0].role,"viewer");

    const projects=await app.api("/api/projects",{token:user.token});
    assert.deepEqual(projects.json.projects.map(p=>p.id),[alpha]);
    assert.equal(projects.json.projects[0].role,"viewer");
    assert.equal((await app.api("/api/me",{token:user.token})).json.type,"member");
    assert.equal((await app.api("/api/projects/"+alpha,{token:user.token})).json.role,"viewer");
    assert.equal((await app.api("/api/projects/"+alpha+"/versions",{token:user.token})).status,200);
    assert.equal((await app.api("/api/projects/"+alpha+"/export?version=1",{token:user.token})).status,200);
    assert.equal((await app.api("/api/projects/"+alpha+"/axure-readiness",{token:user.token})).status,200);
    assert.equal((await app.api("/api/projects/"+alpha+"/axure-ir",{token:user.token})).status,200);

    for(const url of [
      "/api/projects/"+beta,
      "/api/projects/"+beta+"/versions",
      "/api/projects/"+beta+"/export",
      "/api/projects/"+beta+"/rollback",
      "/api/projects/"+beta+"/deploy-keys"
    ]) {
      const r=await app.api(url,{token:user.token});
      assert.equal(r.status,404,url);
    }
    for(const [method,url,body] of [
      ["POST","/api/projects",post({name:"Bad",html:"<html>bad</html>"})],
      ["POST","/api/projects/"+alpha+"/versions",post({html:"<html>new</html>"})],
      ["POST","/api/projects/"+alpha+"/rollback",post({version:1})],
      ["PATCH","/api/projects/"+alpha+"/versions/1",patch({note:"no"})],
      ["PATCH","/api/projects/"+alpha,patch({name:"hacked"})],
      ["DELETE","/api/projects/"+alpha,{}],
      ["POST","/api/projects/"+alpha+"/preview-ticket",{}],
      ["GET","/api/projects/"+alpha+"/shares",{}],
      ["GET","/api/projects/"+alpha+"/deploy-keys",{}],
      ["GET","/api/projects/"+alpha+"/github-workflow",{}],
      ["GET","/api/users",{}],
      ["GET","/api/projects/"+alpha+"/members",{}]
    ]) {
      const r=await app.api(url,{method,token:user.token,...body});
      assert.equal(r.status,403,method+" "+url);
    }
    assert.equal((await app.api("/api/projects/"+alpha)).json.name,"Alpha");
    assert.equal((await app.api("/api/projects")).json.projects.length,2);

    const elevated=await app.api("/api/projects/"+alpha+"/members/"+user.id,
      put({role:"editor"}));
    assert.equal(elevated.status,200);
    const memberV2=await app.api("/api/projects/"+alpha+"/versions",{
      token:user.token,...post({html:"<html><p>v2 by editor</p></html>"})
    });
    assert.equal(memberV2.status,201,JSON.stringify(memberV2.json));
    assert.equal(memberV2.json.version,2);
    const note=await app.api("/api/projects/"+alpha+"/versions/2",{
      token:user.token,...patch({note:"test edited"})});
    assert.equal(note.status,200);
    const rollback=await app.api("/api/projects/"+alpha+"/rollback",{
      token:user.token,...post({version:1})});
    assert.equal(rollback.status,200);
    assert.equal(rollback.json.currentVersion,1);
    assert.equal((await app.api("/api/projects/"+alpha+"/shares",{
      token:user.token,...post({})})).status,403);
    assert.equal((await app.api("/api/projects/"+alpha+"/deploy-keys",{
      token:user.token,...post({})})).status,403);
    assert.equal((await app.api("/api/projects/"+alpha,{
      token:user.token,...patch({siteEnabled:true})})).status,403);
  } finally {await app.stop();await app.cleanup();}
});

test("RC20A token rotation, disable and project membership revoke take effect immediately",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try {
    const c=await app.api("/api/projects",post({name:"Gamma",
      html:"<html><p>Gamma</p></html>"}));
    const id=c.json.id;
    const m=await app.api("/api/users",post({email:"member@example.org",name:"One"}));
    assert.equal(m.status,201);
    const uid=m.json.id;
    assert.equal((await app.api("/api/users",post({email:"member@example.org",name:"Other"}))).status,409);
    assert.equal((await app.api("/api/projects/"+id+"/members/"+uid,put({role:"owner"}))).status,400);
    assert.equal((await app.api("/api/projects/"+id+"/members/"+uid,put({role:"editor"}))).status,200);
    assert.equal((await app.api("/api/projects",{token:m.json.token})).status,200);
    const rotated=await app.api("/api/users/"+uid+"/rotate-token",{method:"POST"});
    assert.equal(rotated.status,200);
    assert.notEqual(rotated.json.token,m.json.token);
    assert.equal((await app.api("/api/projects",{token:m.json.token})).status,401);
    assert.equal((await app.api("/api/projects",{token:rotated.json.token})).status,200);
    assert.equal((await app.api("/api/projects/"+id+"/members/"+uid,{
      method:"DELETE"})).status,200);
    assert.equal((await app.api("/api/projects",{token:rotated.json.token})).json.projects.length,0);
    assert.equal((await app.api("/api/projects/"+id,{token:rotated.json.token})).status,404);
    assert.equal((await app.api("/api/projects/"+id+"/members/"+uid,put({role:"viewer"}))).status,200);
    const disabled=await app.api("/api/users/"+uid,patch({enabled:false}));
    assert.equal(disabled.status,200);
    assert.equal(disabled.json.enabled,false);
    assert.equal((await app.api("/api/me",{token:rotated.json.token})).status,401);
    assert.equal((await app.api("/api/projects/"+id+"/members/"+uid,put({role:"editor"}))).status,409);
    assert.equal((await app.api("/api/users/"+uid,patch({enabled:true}))).status,200);
    assert.equal((await app.api("/api/projects",{token:rotated.json.token})).status,200);
    await app.api("/api/projects/"+id,patch({lifecycleState:"trashed"}));
    assert.equal((await app.api("/api/projects",{token:rotated.json.token})).json.projects.length,0);
    assert.equal((await app.api("/api/projects/"+id,{token:rotated.json.token})).status,404);
  }finally{await app.stop();await app.cleanup();}
});

test("RC20A member cannot use malformed credentials, admin endpoints or unrelated project ID",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try{
    const project=(await app.api("/api/projects",post({
      name:"Private",html:"<html>Private</html>"
    }))).json.id;
    const account=(await app.api("/api/users",post({
      email:"safe@example.net",name:"Safety"
    }))).json;
    await app.api("/api/projects/"+project+"/members/"+account.id,put({role:"viewer"}));
    for(const token of [
      "uat_"+account.id+"."+"A".repeat(43),
      "uat_"+account.id+"."+"a".repeat(42),
      "uat_"+account.id+"."+"a".repeat(44),
      "uat_"+account.id+".",
      "dpk_"+account.id+"."+"A".repeat(43)
    ]) {
      const r=await app.api("/api/projects",{token});
      assert.equal(r.status,401,token.slice(0,25));
    }
    const projectId=project;
    for(const url of [
      "/api/projects/"+projectId+"/shares/1234567890123456/disable",
      "/api/projects/"+projectId+"/deploy-keys/1234567890123456/revoke",
      "/api/projects/"+projectId+"/members/"+account.id,
      "/api/projects/"+projectId+"/preview-ticket",
      "/api/projects/"+projectId+"/export/..",
      "/api/projects/"+projectId+"/versions/1/export"
    ]) {
      const r=await app.api(url,{token:account.token});
      assert.equal(r.status,403,url);
    }
    const postToMembers=await app.api("/api/projects/"+project+"/members/"+account.id,{
      token:account.token,...put({role:"editor"})});
    assert.equal(postToMembers.status,403);
    assert.equal((await app.api("/api/users",{token:account.token,...post({
      email:"attacker@example.net",name:"No"})})).status,403);
  }finally{await app.stop();await app.cleanup();}
});
