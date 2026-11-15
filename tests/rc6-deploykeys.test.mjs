// RC6 deploy keys: creation (secret shown once, only hash stored),
// project-scoped upload + status queries, denial of every admin operation,
// cross-project isolation, revoke/disable/expiry semantics, unchanged admin
// auth, and previewEnabled protection (a deploy-key upload must never
// silently re-enable a disabled preview).

import crypto from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const HTML = "<html><body><h1>Deploy Key Test</h1></body></html>";
const ZIP_V2 = () =>
  filesZip([
    { name: "index.html", data: "<html><body><h1>V2 via deploy key</h1></body></html>" },
    { name: "assets/style.css", data: "body{color:#0af}" }
  ]);

let server;
let project;
let otherProject;

before(async () => {
  server = await startServer();

  const a = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Keyed", html: HTML })
  });
  assert.equal(a.status, 201);
  project = a.json;

  const b = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Other", html: HTML })
  });
  assert.equal(b.status, 201);
  otherProject = b.json;
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

function keyHeader(token) {
  return { authorization: `Bearer ${token}` };
}

async function uploadWithKey(token, projectId, body) {
  const fd = new FormData();
  fd.set("file", new Blob([body ?? ZIP_V2()]), "deploy.zip");
  return server.api(`/api/projects/${projectId}/versions`, {
    method: "POST",
    token: null,
    headers: keyHeader(token),
    body: fd
  });
}

test("admin creates a deploy key; plaintext token is returned exactly once", async () => {
  const r = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 })
  });

  assert.equal(r.status, 201);
  assert.match(r.json.token, /^dpk_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.status, "active");
  assert.ok(r.json.expiresAt);

  project.deployKey = r.json.token;
  project.deployKeyId = r.json.id;

  // The listing must never contain the plaintext token or the hash.
  const list = await server.api(`/api/projects/${project.id}/deploy-keys`);
  assert.equal(list.status, 200);
  assert.equal(list.json.deployKeys.length, 1);
  const view = list.json.deployKeys[0];
  assert.equal(view.id, project.deployKeyId);
  assert.ok(!("token" in view));
  assert.ok(!("tokenHash" in view));
  assert.equal(view.lastDeployVersion, null);
});

test("malformed or wrong deploy tokens are rejected without leaking info", async () => {
  // Not a dpk token at all → treated as admin candidate → 401.
  const r1 = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: { authorization: "Bearer not-a-valid-admin-token" }
  });
  assert.equal(r1.status, 401);

  // Well-formed dpk token but wrong secret.
  const keyId = project.deployKeyId;
  const bad = `dpk_${keyId}.${"A".repeat(43)}`;
  const r2 = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(bad)
  });
  assert.equal(r2.status, 401);
  assert.equal(r2.json.code, "DEPLOY_KEY_INVALID");
});

test("deploy key uploads a new version to its own project", async () => {
  const r = await uploadWithKey(project.deployKey, project.id);
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 2);

  // Deploy-key usage recorded for the workbench.
  const list = await server.api(`/api/projects/${project.id}/deploy-keys`);
  const key = list.json.deployKeys.find((k) => k.id === project.deployKeyId);
  assert.equal(key.lastDeployVersion, 2);
  assert.equal(key.lastDeployResult, "ok");
  assert.ok(key.lastUsedAt);

  const preview = await server.preview(`/p/${project.id}/`);
  assert.equal(preview.status, 200);
  assert.ok((await preview.text()).includes("V2 via deploy key"));
});

test("deploy key may query its own project detail, versions and limits", async () => {
  const d = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(project.deployKey)
  });
  assert.equal(d.status, 200);
  assert.equal(d.json.id, project.id);
  assert.equal(d.json.currentVersion, 2);

  const v = await server.api(`/api/projects/${project.id}/versions`, {
    token: null,
    headers: keyHeader(project.deployKey)
  });
  assert.equal(v.status, 200);
  assert.equal(v.json.versions.length, 2);

  const l = await server.api("/api/limits", {
    token: null,
    headers: keyHeader(project.deployKey)
  });
  assert.equal(l.status, 200);
  assert.ok(l.json.limits.maxZipBytes > 0);
});

test("deploy key cannot upload to another project", async () => {
  const r = await uploadWithKey(project.deployKey, otherProject.id);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "DEPLOY_KEY_FORBIDDEN");

  // The other project is untouched.
  const d = await server.api(`/api/projects/${otherProject.id}`);
  assert.equal(d.json.currentVersion, 1);
});

test("deploy key cannot use rollback, share, deploy-key or PATCH endpoints", async () => {
  const cases = [
    [`/api/projects/${project.id}/rollback`, "POST", JSON.stringify({ version: 1 })],
    [`/api/projects/${project.id}/shares`, "POST", "{}"],
    [`/api/projects/${project.id}/shares`, "GET", undefined],
    [`/api/projects/${project.id}/deploy-keys`, "GET", undefined],
    [`/api/projects/${project.id}/deploy-keys`, "POST", "{}"],
    [`/api/projects/${project.id}/deploy-keys/${project.deployKeyId}/revoke`, "POST", undefined],
    [`/api/projects/${project.id}`, "PATCH", JSON.stringify({ previewEnabled: false })]
  ];

  for (const [path, method, body] of cases) {
    const r = await server.api(path, {
      method,
      token: null,
      headers: { ...keyHeader(project.deployKey), "content-type": "application/json" },
      body
    });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.code, "DEPLOY_KEY_FORBIDDEN", `${method} ${path}`);
  }
});

test("deploy key cannot access another project's endpoints even for reads", async () => {
  const r = await server.api(`/api/projects/${otherProject.id}`, {
    token: null,
    headers: keyHeader(project.deployKey)
  });
  assert.equal(r.status, 403);
});

test("deploy key upload never re-enables a disabled preview", async () => {
  // Admin disables preview.
  const p = await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: false })
  });
  assert.equal(p.status, 200);
  assert.equal(p.json.previewEnabled, false);

  const before404 = await server.preview(`/p/${project.id}/`);
  assert.equal(before404.status, 404);

  // Deploy-key upload with NEW content must succeed but keep preview off.
  const zip3 = () =>
    filesZip([
      { name: "index.html", data: "<html><body><h1>V3 stays disabled</h1></body></html>" }
    ]);
  const r = await uploadWithKey(project.deployKey, project.id, zip3());
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 3);

  const after404 = await server.preview(`/p/${project.id}/`);
  assert.equal(after404.status, 404);

  const d = await server.api(`/api/projects/${project.id}`);
  assert.equal(d.json.previewEnabled, false);

  // Restore for later tests.
  await server.api(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: true })
  });
});

test("disabled deploy keys are rejected immediately", async () => {
  const c = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(c.status, 201);
  const key = c.json;

  const d = await server.api(`/api/projects/${project.id}/deploy-keys/${key.id}/disable`, {
    method: "POST"
  });
  assert.equal(d.status, 200);
  assert.equal(d.json.status, "disabled");

  const r = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(key.token)
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "DEPLOY_KEY_DISABLED");

  // Re-enable works again.
  const e = await server.api(`/api/projects/${project.id}/deploy-keys/${key.id}/enable`, {
    method: "POST"
  });
  assert.equal(e.status, 200);
  const ok = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(key.token)
  });
  assert.equal(ok.status, 200);
});

test("expired deploy keys are rejected immediately", async () => {
  const c = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresAt: new Date(Date.now() + 300).toISOString() })
  });
  assert.equal(c.status, 201);
  const key = c.json;

  const before = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(key.token)
  });
  assert.equal(before.status, 200);

  await new Promise((r) => setTimeout(r, 400));

  const after = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(key.token)
  });
  assert.equal(after.status, 401);
  assert.equal(after.json.code, "DEPLOY_KEY_EXPIRED");

  const list = await server.api(`/api/projects/${project.id}/deploy-keys`);
  const view = list.json.deployKeys.find((k) => k.id === key.id);
  assert.equal(view.status, "expired");
});

test("revoked deploy keys are rejected immediately and cannot be re-enabled", async () => {
  const c = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(c.status, 201);
  const key = c.json;

  const rv = await server.api(`/api/projects/${project.id}/deploy-keys/${key.id}/revoke`, {
    method: "POST"
  });
  assert.equal(rv.status, 200);
  assert.equal(rv.json.status, "revoked");

  const r = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(key.token)
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "DEPLOY_KEY_REVOKED");

  const en = await server.api(`/api/projects/${project.id}/deploy-keys/${key.id}/enable`, {
    method: "POST"
  });
  assert.equal(en.status, 400);
  assert.equal(en.json.code, "DEPLOY_KEY_REVOKED");
});

test("failed deploy-key upload records lastDeployResult=failed", async () => {
  const c = await server.api(`/api/projects/${project.id}/deploy-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(c.status, 201);
  const key = c.json;

  // Invalid HTML payload (JSON path) → 400 → failure recorded.
  const r = await server.api(`/api/projects/${project.id}/versions`, {
    method: "POST",
    token: null,
    headers: { ...keyHeader(key.token), "content-type": "application/json" },
    body: JSON.stringify({ html: "not html" })
  });
  assert.equal(r.status, 400);

  const list = await server.api(`/api/projects/${project.id}/deploy-keys`);
  const view = list.json.deployKeys.find((k) => k.id === key.id);
  assert.equal(view.lastDeployResult, "failed");
  assert.equal(view.lastDeployVersion, null); // never succeeded
});

test("admin token semantics are unchanged by RC6", async () => {
  // Admin token still works everywhere.
  const ok = await server.api(`/api/projects/${project.id}`);
  assert.equal(ok.status, 200);

  // Admin can still do everything a deploy key cannot.
  const rb = await server.api(`/api/projects/${otherProject.id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1 })
  });
  assert.equal(rb.status, 200);
});

test("deploy key tokens never collide with the admin token space", async () => {
  // A dpk_ token cannot authenticate as admin even if the admin token were
  // literally a dpk string — admin auth compares the full secret.
  const forged = `dpk_${"0".repeat(16)}.${"A".repeat(43)}`;
  const r = await server.api(`/api/projects/${project.id}`, {
    token: null,
    headers: keyHeader(forged)
  });
  assert.equal(r.status, 401);
});
