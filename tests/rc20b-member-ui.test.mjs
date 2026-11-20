import assert from "node:assert/strict";
import {test} from "node:test";
import {startServer} from "./helpers/harness.mjs";

test("RC20B console exposes invited login, activation, password change and safe account audit UX",async()=>{
  const app=await startServer({
    ARCU_TEAM_ACCESS_ENABLED:"1",ARCU_MEMBER_LOGIN_ENABLED:"1"
  });
  try{
    const resp=await fetch(app.apiBase+"/console");
    assert.equal(resp.status,200);
    const html=await resp.text();
    assert.match(html,/window\.__ARCU_MEMBER_LOGIN_ENABLED__ = true/);
    for(const id of [
      "headerMemberLoginBtn","headerMemberChangeBtn","headerMemberLogoutBtn",
      "openMemberLoginBtn","memberAccountDialog","memberLoginEmail",
      "memberLoginPassword","memberInviteEmail","memberInviteCode",
      "memberSetPassword","submitMemberLogin","submitMemberActivate",
      "memberOldPassword","memberNextPassword",
      "submitMemberChangePassword","memberAuthStatus","authAuditList"
    ])assert.match(html,new RegExp('id="'+id+'"'),id);
    assert.match(html,/X-Arcunara-Member-Request/);
    assert.match(html,/memberCookieConnected/);
    assert.match(html,/api\("\/api\/auth\/session"\)/);
    assert.match(html,/api\("\/api\/auth\/login"/);
    assert.match(html,/api\("\/api\/auth\/activate"/);
    assert.match(html,/api\("\/api\/auth\/logout"/);
    assert.match(html,/api\("\/api\/auth\/change-password"/);
    assert.match(html,/\/api\/users\/"\+u\.id\+"\/invite"/);
    assert.match(html,/copyTeamCredential/);
    assert.match(html,/memberAuthStatus/);
    assert.doesNotMatch(html,/localStorage\.setItem/);
    assert.doesNotMatch(html,/sessionStorage\.setItem/);
    assert.doesNotMatch(html,/document\.cookie\s*=/);
    assert.match(resp.headers.get("cache-control")||"",/no-store/);
  }finally{await app.stop();await app.cleanup();}
});

test("RC20B default-disabled workbench injects false and does not invite anonymous registration",async()=>{
  const app=await startServer();
  try{
    const page=await fetch(app.apiBase+"/console");
    const html=await page.text();
    assert.match(html,/window\.__ARCU_MEMBER_LOGIN_ENABLED__ = false/);
    assert.doesNotMatch(html,/<form[^>]*action=["']\/api\/auth\/register/);
    const resp=await fetch(app.apiBase+"/api/auth/session");
    assert.equal(resp.status,404);
  }finally{await app.stop();await app.cleanup();}
});
