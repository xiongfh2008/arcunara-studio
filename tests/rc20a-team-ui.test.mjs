import assert from "node:assert/strict";
import {test} from "node:test";
import {startServer} from "./helpers/harness.mjs";

test("RC20A workbench presents real admin team management and safe member-only layout",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try{
    const page=await fetch(app.apiBase+"/console");
    assert.equal(page.status,200);
    const html=await page.text();
    for(const id of ["openTeamDialog","teamUsersDialog","newMemberName",
      "newMemberEmail","createTeamUserBtn","teamCredentialBox","teamCredential",
      "copyTeamCredential","teamUsersList","membersTab","memberPicker",
      "memberRole","assignMemberBtn","memberList","memberAccessInfo"]) {
      assert.match(html,new RegExp('id="'+id+'"'),id);
    }
    assert.match(html,/\.member-mode #openCreateDialog/);
    assert.match(html,/\.member-mode #openSharesPanel/);
    assert.match(html,/\.member-mode #openDeployPanel/);
    assert.match(html,/\.member-mode #siteHostingToggle/);
    assert.match(html,/\.viewer-mode #rollbackBtn/);
    assert.match(html,/\.viewer-mode #openUploadDialog/);
    assert.match(html,/member\?Promise\.resolve\(\{shares:\[\]\}\)/);
    assert.match(html,/member\?Promise\.resolve\(\{deployKeys:\[\]\}\)/);
    assert.match(html,/applyPrincipal\(await api\("\/api\/me"\)\)/);
    assert.match(html,/sessionPrincipal\.type==="member"/);
    assert.match(html,/teamCredential"\)\.textContent=""/);
    assert.match(html,/navigator\.clipboard\.writeText\(value\)/);
    assert.match(html,/data-tab="members"/);
    assert.match(html,/activeTab==="members"\) refreshProjectMembers/);
    assert.doesNotMatch(html,/localStorage\.setItem\(/);
    assert.doesNotMatch(html,/sessionStorage\.setItem\(/);
  }finally{await app.stop();await app.cleanup();}
});

test("RC20A accounts are not exposed in HTML and default-off mode still serves console",async()=>{
  const app=await startServer();
  try{
    const resp=await fetch(app.apiBase+"/console");
    assert.equal(resp.status,200);
    const html=await resp.text();
    assert.ok(html.includes('id="openTeamDialog"'));
    assert.ok(html.includes('class="ghost hidden" id="openTeamDialog"'));
    assert.ok(!html.includes("uat_"+app.token));
    assert.match(resp.headers.get("cache-control")||"",/no-store/);
  }finally{await app.stop();await app.cleanup();}
});
