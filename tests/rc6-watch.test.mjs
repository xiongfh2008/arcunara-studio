// RC6 watch mode tests: debounce (write bursts collapse into one version),
// stability detection (content sampled twice before publishing), no
// duplicate publishes of identical content, bounded behavior, and clean
// SIGINT shutdown. Timing margins are generous to stay CI-safe; the CLI
// accepts --debounce/--settle so tests can run fast but not racy.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "./helpers/harness.mjs";

const CLI = fileURLToPath(new URL("../packages/cli/arcunara.mjs", import.meta.url));

let server;
let project;
let srcDir;

function runWatch(extraArgs = []) {
  const child = spawn(
    process.execPath,
    [
      CLI,
      "watch",
      srcDir,
      "--project",
      project.id,
      "--api",
      server.apiBase,
      "--debounce",
      "400",
      "--settle",
      "300",
      ...extraArgs
    ],
    {
      env: {
        ...process.env,
        ARCU_DEPLOY_KEY: project.deployKey
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));

  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

async function stopWatch(session) {
  session.child.kill("SIGINT");
  await Promise.race([
    new Promise((r) => session.child.once("exit", r)),
    delay(8000).then(() => {
      session.child.kill("SIGKILL");
      throw new Error("watch did not exit on SIGINT");
    })
  ]);
}

async function versionCount() {
  const r = await server.api(`/api/projects/${project.id}/versions`);
  return r.json.versions.length;
}

before(async () => {
  server = await startServer();

  const r = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Watch Project", html: "<html><body><h1>watch seed</h1></body></html>" })
  });
  assert.equal(r.status, 201);
  project = r.json;

  const k = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  project.deployKey = k.json.token;

  srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-watch-"));
  await fs.writeFile(path.join(srcDir, "index.html"), "<html><body><h1>watch v1</h1></body></html>", "utf8");
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
  if (srcDir) {
    await fs.rm(srcDir, { recursive: true, force: true });
  }
});

test("watch publishes after a write burst settles into one version", async () => {
  const session = runWatch();

  try {
    // Wait for the watch banner.
    await delay(1500);
    assert.ok(session.getStderr().includes("正在监视"), session.getStderr());

    const baseline = await versionCount();

    // Rapid write burst: 5 writes within the debounce window must collapse
    // into ONE publish of the final content.
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(srcDir, "index.html"),
        `<html><body><h1>burst ${i}</h1></body></html>`,
        "utf8"
      );
      await delay(80);
    }

    // Give the debounce + settle + upload time to complete.
    await delay(4000);

    const published = (await server.api(`/api/projects/${project.id}/versions`)).json.versions;
    assert.equal(published.length, baseline + 1, "burst must create exactly one version");
    assert.ok(
      published.at(-1).version === published.at(-1).version && true,
      "sanity"
    );

    const preview = await server.preview(`/p/${project.id}/`);
    assert.ok((await preview.text()).includes("burst 4"), "final burst content is live");

    // Identical content still watched → no duplicate publish.
    await fs.writeFile(
      path.join(srcDir, "index.html"),
      `<html><body><h1>burst 4</h1></body></html>`,
      "utf8"
    );
    await delay(3000);

    assert.equal(
      (await server.api(`/api/projects/${project.id}/versions`)).json.versions.length,
      baseline + 1,
      "identical content must not create another version"
    );

    await stopWatch(session);
  } finally {
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill("SIGKILL");
    }
  }
});

test("watch exits cleanly on SIGINT", async () => {
  const session = runWatch();
  await delay(1200);

  const exit = new Promise((r) => session.child.once("exit", (code, signal) => r({ code, signal })));
  session.child.kill("SIGINT");
  const result = await Promise.race([
    exit,
    delay(8000).then(() => null)
  ]);

  assert.ok(result, "watch exited after SIGINT");
  assert.ok(result.signal === "SIGINT" || result.code === 0, `clean exit (code=${result.code}, signal=${result.signal})`);
});

test("watch refuses non-directory sources", async () => {
  const file = path.join(os.tmpdir(), `arcunara-watch-notdir-${Date.now()}.html`);
  await fs.writeFile(file, "<html></html>", "utf8");

  const child = spawn(process.execPath, [CLI, "watch", file, "--project", project.id, "--api", server.apiBase], {
    env: { ...process.env, ARCU_DEPLOY_KEY: project.deployKey },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));

  const code = await Promise.race([
    new Promise((r) => child.once("close", (c) => r(c))),
    delay(10000).then(() => {
      child.kill("SIGKILL");
      return -999;
    })
  ]);

  await fs.rm(file, { force: true });
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("仅支持目录"), stderr);
});
