import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { detectStaticOutput, localBuildCommand } from "../packages/cli/lib/publish.mjs";

const cli = fileURLToPath(new URL("../packages/cli/arcunara.mjs", import.meta.url));

async function runCli(cwd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", x=>output+=x);
    child.stderr.on("data", x=>errors+=x);
    child.once("close", code=>resolve({code,output,errors}));
  });
}

test("publish auto-detects and validates static outputs, never uploads SSR roots", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-publish-detect-"));
  try {
    await assert.rejects(() => detectStaticOutput(dir), /静态构建目录/);
    await fs.mkdir(path.join(dir,".next"));
    await assert.rejects(() => detectStaticOutput(dir), /不支持直接部署 Next.js SSR/);
    const dist = path.join(dir,"dist");
    await fs.mkdir(dist);
    await fs.writeFile(path.join(dist,"index.html"),"<html>ok</html>");
    assert.equal(await detectStaticOutput(dir),dist);
    assert.equal(await detectStaticOutput(dir,"dist"),dist);
    await fs.mkdir(path.join(dir,"build"));
    await fs.writeFile(path.join(dir,"build","index.html"),"<html>build</html>");
    await assert.rejects(() => detectStaticOutput(dir), /多个静态输出目录/);
    await assert.rejects(() => detectStaticOutput(dir,"nonexistent"), /没有常规 index.html/);
    assert.equal(await localBuildCommand(dir),null);
    await fs.writeFile(path.join(dir,"package.json"),JSON.stringify({scripts:{build:"echo hi"}}));
    assert.equal(await localBuildCommand(dir),"npm run build");
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test("publish builds locally and deploys an idempotent static site via scoped key", async () => {
  const server = await startServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-publish-e2e-"));
  try {
    const project = await server.api("/api/projects", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Static website",html:"<html>v1</html>"})
    });
    assert.equal(project.status,201);
    const id=project.json.id;
    const key=await server.api(`/api/projects/${id}/deploy-keys`,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal(key.status,201);
    await fs.writeFile(path.join(dir,"package.json"),JSON.stringify({
      scripts:{build:"node make-site.mjs"}
    }));
    await fs.writeFile(path.join(dir,"make-site.mjs"),
      'import fs from "node:fs"; fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/index.html","<html><body>AI Generated Website</body></html>");');
    const env={
      ARCU_DEPLOY_KEY:key.json.token,
      ARCU_API_BASE:server.apiBase,
      ARCU_PREVIEW_BASE:server.previewBase
    };
    const args=["publish","--api",server.apiBase,"--project",id];
    const first=await runCli(dir,args,env);
    assert.equal(first.code,0,first.errors);
    assert.match(first.output,/发布成功/);
    const preview=await server.preview(`/p/${id}/`);
    assert.equal(preview.status,200);
    assert.match(await preview.text(),/AI Generated Website/);
    const second=await runCli(dir,[...args,"--skip-build"],env);
    assert.equal(second.code,0,second.errors);
    assert.match(second.output,/未创建新版本/);
    const vers=await server.api(`/api/projects/${id}/versions`);
    assert.equal(vers.json.versions.length,2);

    // An output directory ambiguity never creates a version.
    await fs.mkdir(path.join(dir,"out"));
    await fs.writeFile(path.join(dir,"out","index.html"),"<html>out</html>");
    const invalid=await runCli(dir,[...args,"--skip-build"],env);
    assert.notEqual(invalid.code,0);
    assert.match(invalid.errors,/多个静态输出目录/);
    assert.equal((await server.api(`/api/projects/${id}/versions`)).json.versions.length,2);
  } finally {
    await server.stop();
    await server.cleanup();
    await fs.rm(dir,{recursive:true,force:true});
  }
});
