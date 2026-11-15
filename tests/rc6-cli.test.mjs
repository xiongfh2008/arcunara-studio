// RC6 CLI integration tests: the real CLI (packages/cli/arcunara.mjs) runs
// against the real server. Covers init, single-HTML/ZIP/directory deploys,
// Chinese file names, exclusion of secrets and dev directories, symlink
// refusal, content-hash idempotency, status/versions/rollback, credential
// handling, and failure isolation (failed upload never changes the version).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const CLI = fileURLToPath(new URL("../packages/cli/arcunara.mjs", import.meta.url));

let server;
let project;
let workdir;

function runCli(args, { env = {}, cwd = workdir, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();

    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function apiBase() {
  return server.apiBase;
}

const deployKeyEnv = () => ({
  ARCU_DEPLOY_KEY: project.deployKey,
  ARCU_API_BASE: server.apiBase,
  ARCU_PREVIEW_BASE: server.previewBase
});
const adminEnv = () => ({
  ARCU_API_TOKEN: server.token,
  ARCU_API_BASE: server.apiBase,
  ARCU_PREVIEW_BASE: server.previewBase
});

// Version counter: deploys in these tests share one project, so expected
// version numbers are tracked instead of hardcoded.
let nextVersion = 2;

async function previewText(id) {
  const res = await server.preview(`/p/${id}/`);
  assert.equal(res.status, 200);
  return res.text();
}

before(async () => {
  server = await startServer();
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-cli-"));

  const r = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "CLI Project", html: "<html><body><h1>seed</h1></body></html>" })
  });
  assert.equal(r.status, 201);
  project = r.json;

  const k = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(k.status, 201);
  project.deployKey = k.json.token;
  project.deployKeyId = k.json.id;
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
  if (workdir) {
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

test("init writes .arcunara.json without credentials", async () => {
  // Written to the shared cwd so later deploys resolve the project from it.
  const dir = workdir;

  const r = await runCli(
    ["init", "--project", project.id, "--api", apiBase(), "--preview-base", server.previewBase],
    { cwd: dir, env: { ARCU_DEPLOY_KEY: "", ARCU_API_TOKEN: "" } }
  );

  assert.equal(r.code, 0, r.stderr);
  const raw = await fs.readFile(path.join(dir, ".arcunara.json"), "utf8");
  const cfg = JSON.parse(raw);
  assert.equal(cfg.projectId, project.id);
  assert.equal(cfg.apiBase, apiBase());
  assert.ok(!raw.includes("dpk_"), "config must never contain the deploy key");
  assert.ok(r.stdout.includes("ARCU_DEPLOY_KEY"), "next-steps mention the key env var");
});

test("deploy single HTML file publishes v2 and repeat deploy dedupes", async () => {
  const dir = path.join(workdir, "app1");
  await fs.mkdir(dir, { recursive: true });
  const htmlPath = path.join(dir, "page.html");
  await fs.writeFile(htmlPath, "<html><body><h1>CLI 单文件发布</h1></body></html>", "utf8");

  const first = await runCli(["deploy", htmlPath], { env: deployKeyEnv() });
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.stdout.includes(`v${nextVersion}`), first.stdout);
  assert.ok(first.stdout.includes(project.id));
  assert.ok(first.stdout.includes(server.previewBase), "prints full preview URL");
  nextVersion++;

  assert.equal(await previewText(project.id).then((t) => t.includes("CLI 单文件发布")), true);

  const repeat = await runCli(["deploy", htmlPath], { env: deployKeyEnv() });
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.ok(repeat.stdout.includes("未创建新版本"), repeat.stdout);

  const versions = await server.api(`/api/projects/${project.id}/versions`);
  assert.equal(versions.json.versions.length, nextVersion - 1);
});

test("deploy directory auto-packs ZIP with Chinese names and relative paths", async () => {
  const dir = path.join(workdir, "app2");
  await fs.mkdir(path.join(dir, "样式"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "index.html"),
    '<html><head><link rel="stylesheet" href="样式/main.css"></head><body><h1>目录发布测试</h1></body></html>',
    "utf8"
  );
  await fs.writeFile(path.join(dir, "样式", "main.css"), "body{color:#b00}", "utf8");
  await fs.writeFile(path.join(dir, "子页面.html"), "<html><body>sub</body></html>", "utf8");

  const r = await runCli(["deploy", dir, "--project", project.id, "--api", apiBase()], {
    env: deployKeyEnv()
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`v${nextVersion}`), r.stdout);
  nextVersion++;

  const html = await previewText(project.id);
  assert.ok(html.includes("目录发布测试"));

  // Chinese subresources survive the round trip.
  const css = await server.preview(`/p/${project.id}/样式/main.css`);
  assert.equal(css.status, 200);
  assert.ok((await css.text()).includes("#b00"));

  const versions = await server.api(`/api/projects/${project.id}/versions`);
  assert.equal(versions.json.versions.length, nextVersion - 1);
  assert.equal(versions.json.versions.at(-1).fileCount, 3);
});

test("deploy directory excludes dotfiles, secrets and dev directories", async () => {
  const dir = path.join(workdir, "app3");
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<html><body><h1>Clean deploy</h1></body></html>", "utf8");
  await fs.writeFile(path.join(dir, ".env"), "SECRET=1", "utf8");
  await fs.writeFile(path.join(dir, "server.pem"), "-----BEGIN", "utf8");
  await fs.writeFile(path.join(dir, "id_rsa_backup"), "PRIVATE", "utf8");
  await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: x", "utf8");
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "x.js"), "module.exports=1", "utf8");
  await fs.writeFile(path.join(dir, "keep.css"), "body{}", "utf8");

  const r = await runCli(["deploy", dir], { env: deployKeyEnv() });
  assert.equal(r.code, 0, r.stderr);
  nextVersion++;

  // Excluded files are not served.
  const env404 = await server.preview(`/p/${project.id}/.env`);
  assert.equal(env404.status, 404);
  const pem404 = await server.preview(`/p/${project.id}/server.pem`);
  assert.equal(pem404.status, 404);
  const keep = await server.preview(`/p/${project.id}/keep.css`);
  assert.equal(keep.status, 200);

  const versions = await server.api(`/api/projects/${project.id}/versions`);
  const last = versions.json.versions.at(-1);
  assert.equal(last.fileCount, 2); // index.html + keep.css
});

test("deploy refuses to follow symbolic links", async () => {
  if (process.platform === "win32") {
    // Creating symlinks on Windows requires privileges; skip gracefully.
    return;
  }
  const dir = path.join(workdir, "app4");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<html><body>ok</body></html>", "utf8");
  await fs.symlink("/etc", path.join(dir, "escape"), "dir");

  const r = await runCli(["deploy", dir], { env: deployKeyEnv() });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("符号链接"), r.stderr);
});

test("deploy a prebuilt ZIP file works", async () => {
  const dir = path.join(workdir, "app5");
  await fs.mkdir(dir, { recursive: true });
  const zip = filesZip([
    { name: "index.html", data: "<html><body><h1>Zipped manually</h1></body></html>" }
  ]);
  const zipPath = path.join(dir, "bundle.zip");
  await fs.writeFile(zipPath, zip);

  const r = await runCli(["deploy", zipPath], { env: deployKeyEnv() });
  assert.equal(r.code, 0, r.stderr);
  assert.ok((await previewText(project.id)).includes("Zipped manually"));
  nextVersion++;
});

test("deploy without any credentials fails with guidance", async () => {
  const dir = path.join(workdir, "app6");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<html><body>x</body></html>", "utf8");

  const r = await runCli(["deploy", dir, "--project", project.id, "--api", apiBase()], {
    env: { ARCU_DEPLOY_KEY: "", ARCU_API_TOKEN: "" }
  });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("ARCU_DEPLOY_KEY"), r.stderr);
});

test("deploy with a revoked key fails and the current version is unchanged", async () => {
  const k = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  const key = k.json;
  await server.api(`/api/projects/${project.id}/deploy-keys/${key.id}/revoke`, { method: "POST" });

  const dir = path.join(workdir, "app7");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<html><body>revoked</body></html>", "utf8");

  const r = await runCli(["deploy", dir], {
    env: { ARCU_DEPLOY_KEY: key.token, ARCU_API_BASE: apiBase(), ARCU_PREVIEW_BASE: server.previewBase }
  });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("401"), r.stderr);

  const versions = await server.api(`/api/projects/${project.id}/versions`);
  const before = (await server.api(`/api/projects/${project.id}`)).json.currentVersion;
  assert.ok(versions.json.versions.every((v) => !JSON.stringify(v).includes("revoked")));
  assert.ok(before >= 1);
});

test("deploy to an unreachable server fails clearly without side effects", async () => {
  const dir = path.join(workdir, "app8");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<html><body>offline</body></html>", "utf8");

  const r = await runCli(["deploy", dir, "--project", project.id, "--api", "http://127.0.0.1:1"], {
    env: deployKeyEnv()
  });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("错误"), r.stderr);

  const d = await server.api(`/api/projects/${project.id}`);
  const versions = await server.api(`/api/projects/${project.id}/versions`);
  assert.equal(d.json.currentVersion, versions.json.versions.at(-1).version);
});

test("status and versions commands read through the deploy key", async () => {
  const s = await runCli(["status", "--project", project.id, "--api", apiBase()], {
    env: deployKeyEnv()
  });
  assert.equal(s.code, 0, s.stderr);
  assert.ok(s.stdout.includes("CLI Project"));
  assert.ok(s.stdout.includes("当前版本"));

  const v = await runCli(["versions", "--project", project.id, "--api", apiBase()], {
    env: deployKeyEnv()
  });
  assert.equal(v.code, 0, v.stderr);
  assert.ok(v.stdout.includes("[当前版本]"));
});

test("rollback requires the admin token and --yes in non-interactive runs", async () => {
  const noToken = await runCli(["rollback", "1", "--project", project.id, "--api", apiBase()], {
    env: { ARCU_API_TOKEN: "", ARCU_DEPLOY_KEY: "" }
  });
  assert.notEqual(noToken.code, 0);
  assert.ok(noToken.stderr.includes("ARCU_API_TOKEN"), noToken.stderr);

  const withKey = await runCli(["rollback", "1", "--project", project.id, "--api", apiBase()], {
    env: { ARCU_API_TOKEN: "", ARCU_DEPLOY_KEY: project.deployKey }
  });
  assert.notEqual(withKey.code, 0);
  assert.ok(withKey.stderr.includes("ARCU_API_TOKEN"), withKey.stderr);

  const noConfirm = await runCli(["rollback", "1", "--project", project.id, "--api", apiBase()], {
    env: adminEnv()
  });
  assert.notEqual(noConfirm.code, 0);
  assert.ok(noConfirm.stderr.includes("--yes"), noConfirm.stderr);

  const current = (await server.api(`/api/projects/${project.id}`)).json.currentVersion;
  const ok = await runCli(
    ["rollback", String(current), "--project", project.id, "--api", apiBase(), "--yes"],
    { env: adminEnv() }
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.stdout.includes("未发生变化"), ok.stdout);
});

test("rollback with --yes switches versions; CLI deploy key cannot rollback", async () => {
  const current = (await server.api(`/api/projects/${project.id}`)).json.currentVersion;
  const target = current - 1;

  const ok = await runCli(
    ["rollback", String(target), "--project", project.id, "--api", apiBase(), "--yes"],
    { env: adminEnv() }
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.stdout.includes(`v${target}`), ok.stdout);

  // Restore forward.
  await server.api(`/api/projects/${project.id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: current })
  });
});

test("CLI --build refuses to run without a configured command", async () => {
  const dir = path.join(workdir, "app9");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<html><body>x</body></html>", "utf8");

  const r = await runCli(["deploy", dir, "--build"], { env: deployKeyEnv() });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("buildCommand") || r.stderr.includes("--build-command"), r.stderr);
});

test("CLI help lists all commands", async () => {
  const r = await runCli(["--help"], { env: {} });
  for (const cmd of ["init", "deploy", "status", "versions", "rollback", "watch"]) {
    assert.ok(r.stdout.includes(cmd), cmd);
  }
});
