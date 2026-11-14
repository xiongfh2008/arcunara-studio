// Black-box integration tests for the v0.2.0 API (apps/api/server.mjs).
//
// The server is started as a real child process against a throwaway data
// directory in the OS temp folder, mirroring how it runs under Docker.
// Tests bind to 127.0.0.1 on ephemeral ports and never touch VPS data,
// production ports, or any persisted state outside the temp directory.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const SERVER_PATH = fileURLToPath(
  new URL("../apps/api/server.mjs", import.meta.url)
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TOKEN = `test-${crypto.randomBytes(24).toString("hex")}`;

const HTML_A =
  "<!DOCTYPE html><html><head><title>Alpha</title></head><body><h1>Alpha page</h1></body></html>";
const HTML_B = "<html><body><p>Beta page</p></body></html>";

let workdir;
let dataDir;
let child;
let apiBase;
let previewBase;

let createdA;
let createdB;

before(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-test-"));
  dataDir = path.join(workdir, "data");

  const tokenFile = path.join(workdir, "api_token");
  await fs.writeFile(tokenFile, `${TOKEN}\n`, "utf8");

  child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      ARCU_DATA_DIR: dataDir,
      ARCU_TOKEN_FILE: tokenFile,
      ARCU_API_HOST: "127.0.0.1",
      ARCU_PREVIEW_HOST: "127.0.0.1",
      ARCU_API_PORT: "0",
      ARCU_PREVIEW_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    const api = stdout.match(/API v0\.2 started on port (\d+)/);
    const preview = stdout.match(/Preview v0\.2 started on port (\d+)/);

    if (api && preview) {
      apiBase = `http://127.0.0.1:${api[1]}`;
      previewBase = `http://127.0.0.1:${preview[1]}`;
      return;
    }

    await delay(50);
  }

  throw new Error(`server did not start in time. output:\n${stdout}`);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();

    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5000).then(() => child.kill("SIGKILL"))
    ]);
  }

  if (workdir) {
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

async function api(pathname, { method = "GET", token, contentType, body } = {}) {
  const headers = {};

  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  if (contentType !== undefined) {
    headers["content-type"] = contentType;
  }

  const res = await fetch(`${apiBase}${pathname}`, { method, headers, body });
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  return { status: res.status, headers: res.headers, text, json };
}

function post(token, payload, contentType = "application/json") {
  return api("/api/projects", {
    method: "POST",
    token,
    contentType,
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

test("GET /health is public and reports v0.2.0", async () => {
  const r = await api("/health");

  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    ok: true,
    service: "arcunara-studio-dev",
    version: "0.2.0"
  });
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("rejects /api/ requests without a bearer token", async () => {
  const r = await api("/api/projects");

  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "Unauthorized" });
});

test("rejects a wrong bearer token", async () => {
  const r = await api("/api/projects", { token: "wrong-token" });

  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "Unauthorized" });
});

test("non-API paths stay unauthorized even with a valid token", async () => {
  const r = await api("/", { token: TOKEN });

  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "Unauthorized" });
});

test("valid token reads the initially empty project list", async () => {
  const r = await api("/api/projects", { token: TOKEN });

  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { projects: [] });
});

test("creates a project and returns preview metadata", async () => {
  const r = await post(TOKEN, { name: "Alpha", html: HTML_A });

  assert.equal(r.status, 201);
  assert.match(r.json.id, UUID_RE);
  assert.equal(r.json.name, "Alpha");
  assert.equal(r.json.previewPath, `/p/${r.json.id}/`);
  assert.ok(!Number.isNaN(Date.parse(r.json.createdAt)));

  createdA = r.json;
});

test("creates a second project with a later timestamp", async () => {
  await delay(50);

  const r = await post(TOKEN, { name: "Beta", html: HTML_B });

  assert.equal(r.status, 201);
  assert.match(r.json.id, UUID_RE);
  assert.notEqual(r.json.id, createdA.id);

  createdB = r.json;
});

test("rejects invalid project payloads with 400", async () => {
  const cases = [
    ["missing name", { html: HTML_A }],
    ["blank name", { name: "   ", html: HTML_A }],
    ["name over 100 chars", { name: "x".repeat(101), html: HTML_A }],
    ["non-string name", { name: 42, html: HTML_A }],
    ["html without <html tag", { name: "NoTag", html: "<body>hello</body>" }],
    ["non-string html", { name: "NoHtml", html: 123 }],
    ["html over 180000 bytes", { name: "TooBig", html: `<html>${"x".repeat(180000)}` }]
  ];

  for (const [label, payload] of cases) {
    const r = await post(TOKEN, payload);

    assert.equal(r.status, 400, label);
    assert.deepEqual(r.json, { error: "Invalid name or HTML" }, label);
  }
});

test("accepts HTML of exactly 180000 bytes (boundary)", async () => {
  const html = `<html>${"x".repeat(179994)}`;
  assert.equal(Buffer.byteLength(html), 180000);

  const r = await post(TOKEN, { name: "BoundaryHtml", html });

  assert.equal(r.status, 201);
});

test("accepts application/json with a charset suffix", async () => {
  const r = await post(
    TOKEN,
    { name: "Charset", html: HTML_B },
    "application/json; charset=utf-8"
  );

  assert.equal(r.status, 201);
});

test("rejects malformed JSON bodies with 400", async () => {
  const r = await post(TOKEN, "{not-json");

  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "Invalid JSON" });
});

test("rejects non-JSON content types with 415", async () => {
  const r = await post(
    TOKEN,
    JSON.stringify({ name: "X", html: HTML_A }),
    "text/plain"
  );

  assert.equal(r.status, 415);
  assert.deepEqual(r.json, { error: "Use application/json" });
});

test("rejects bodies over the 256 KiB limit with 413", async () => {
  const payload = JSON.stringify({
    name: "TooLarge",
    html: `<html>${"a".repeat(300 * 1024)}`
  });

  const r = await post(TOKEN, payload);

  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: "Request too large" });
});

test("accepts a request body of exactly 256 KiB (boundary)", async () => {
  const payload = JSON.stringify({ name: "BoundaryBody", html: HTML_A });
  const padded = payload + " ".repeat(256 * 1024 - Buffer.byteLength(payload));
  assert.equal(Buffer.byteLength(padded), 256 * 1024);

  const r = await post(TOKEN, padded);

  assert.equal(r.status, 201);
});

test("lists projects newest first with meta fields only", async () => {
  assert.ok(createdB.createdAt > createdA.createdAt, "timestamps differ");

  const r = await api("/api/projects", { token: TOKEN });

  assert.equal(r.status, 200);

  const projects = r.json.projects;
  const first = projects.findIndex((p) => p.id === createdB.id);
  const second = projects.findIndex((p) => p.id === createdA.id);

  assert.ok(first !== -1 && second !== -1, "both projects listed");
  assert.ok(first < second, "newest project first");

  for (const p of projects) {
    assert.deepEqual(Object.keys(p).sort(), ["createdAt", "id", "name"]);
  }
});

test("preview serves the stored HTML with sandbox headers", async () => {
  const res = await fetch(`${previewBase}/p/${createdA.id}/`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");

  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /sandbox allow-scripts allow-forms/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src data:/);

  assert.equal(await res.text(), HTML_A);
});

test("persisted files match the created project", async () => {
  const storedHtml = await fs.readFile(
    path.join(dataDir, createdA.id, "index.html"),
    "utf8"
  );
  assert.equal(storedHtml, HTML_A);

  const meta = JSON.parse(
    await fs.readFile(path.join(dataDir, createdA.id, "meta.json"), "utf8")
  );
  assert.deepEqual(meta, {
    id: createdA.id,
    name: "Alpha",
    createdAt: createdA.createdAt
  });
});

test("preview returns 404 for unknown or malformed targets", async () => {
  const cases = [
    `/p/${crypto.randomUUID()}/`,
    `/p/${createdA.id}`,
    "/p/not-a-uuid/",
    "/p/"
  ];

  for (const target of cases) {
    const res = await fetch(`${previewBase}${target}`);

    assert.equal(res.status, 404, target);
    assert.equal(await res.text(), "Not Found", target);
  }

  const postRes = await fetch(`${previewBase}/p/${createdA.id}/`, {
    method: "POST"
  });
  assert.equal(postRes.status, 404);
});

test("unknown /api/ routes return 404 with a valid token", async () => {
  const r = await api("/api/unknown", { token: TOKEN });

  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Not Found" });
});
