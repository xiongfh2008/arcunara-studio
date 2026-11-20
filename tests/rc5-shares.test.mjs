// RC5 Task B/C/E: share links — creation, token binding, expiry, revocation,
// enable/disable, full-resource access control, cross-project isolation,
// path safety, version/rollback coupling, CSP regression and access stats.

import crypto from "node:crypto";
import http from "node:http";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

let server;
let projectA; // HTML project with subresources
let projectB; // second project for isolation checks

const INDEX_V1 =
  '<html><head><link rel="stylesheet" href="css/app.css"><script src="js/app.js" defer></script></head><body><h1>Project A v1</h1><img src="img/logo.png"></body></html>';
const CSS = "body{color:#0af}";
const JS = "window.__loaded = true;";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

before(async () => {
  server = await startServer();

  const zip = filesZip([
    { name: "index.html", data: INDEX_V1 },
    { name: "css/app.css", data: CSS },
    { name: "js/app.js", data: JS },
    { name: "img/logo.png", data: PNG }
  ]);
  const fd = new FormData();
  fd.set("name", "ShareA");
  fd.set("file", new Blob([zip]), "a.zip");
  const ra = await server.api("/api/projects", { method: "POST", body: fd });
  assert.equal(ra.status, 201);
  projectA = ra.json;

  const rb = await server.api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ShareB", html: "<html><body><h1>Project B secret</h1></body></html>" })
  });
  assert.equal(rb.status, 201);
  projectB = rb.json;
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

async function createShare(id, body = {}) {
  const r = await server.api(`/api/projects/${id}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

function shareUrl(token, rest = "/") {
  return `/s/${token}${rest}`;
}

test("share creation returns a one-time token; only its hash is persisted", async () => {
  const s = await createShare(projectA.id);

  assert.match(s.token, /^[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/, "token is shareId.secret (32 bytes b64url)");
  assert.equal(s.status, "active");
  assert.equal(s.expiresAt, null);
  assert.equal(s.accessCount, 0);
  assert.equal(s.enabled, true);

  // Plaintext secret never lands in meta.json.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const meta = JSON.parse(
    await fs.default.readFile(path.default.join(server.dataDir, projectA.id, "meta.json"), "utf8")
  );
  const stored = meta.shares.find((x) => x.id === s.id);
  assert.ok(stored, "share record exists");
  assert.equal(stored.tokenHash.length, 64, "sha256 hex stored");
  assert.ok(!JSON.stringify(meta).includes(s.token.split(".")[1]), "plaintext secret absent from meta");
  assert.equal(stored.secret, undefined);

  globalThis.__shareA = s;
});

test("share serves the entry page and every subresource with the same token", async () => {
  const s = globalThis.__shareA;

  const entry = await server.preview(shareUrl(s.token));
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get("content-type"), /text\/html/);
  assert.match(await entry.text(), /Project A v1/);

  const css = await server.preview(shareUrl(s.token, "/css/app.css"));
  assert.equal(css.status, 200);
  assert.equal(await css.text(), CSS);

  const js = await server.preview(shareUrl(s.token, "/js/app.js"));
  assert.equal(js.status, 200);
  assert.equal(await js.text(), JS);

  const img = await server.preview(shareUrl(s.token, "/img/logo.png"));
  assert.equal(img.status, 200, "binary asset served under the same token");

  const bare = await server.preview(shareUrl(s.token, ""), { redirect: "manual" });
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get("location"), shareUrl(s.token));
});

test("wrong or forged secrets are rejected; share ids of other projects are isolated", async () => {
  const s = globalThis.__shareA;

  const bad = await server.preview(shareUrl(`${s.id}.${"A".repeat(43)}`));
  assert.equal(bad.status, 404, "wrong secret → 404");

  // Mutate one char of the valid secret — must fail.
  const chars = s.token.split(".")[1].split("");
  chars[0] = chars[0] === "A" ? "B" : "A";
  const forged = await server.preview(shareUrl(`${s.id}.${chars.join("")}`));
  assert.equal(forged.status, 404);

  // Unknown share id.
  const unknown = await server.preview(shareUrl(`${"0".repeat(16)}.${"A".repeat(43)}`));
  assert.equal(unknown.status, 404);

  // A token can never be used to reach another project's files: there is no
  // route that combines one project's token with another project's id.
  const sB = await createShare(projectB.id);
  const bViaA = await server.preview(shareUrl(globalThis.__shareA.token, "/index.html"));
  assert.match(await bViaA.text(), /Project A/, "A token serves A only");
  assert.ok(!JSON.stringify(bViaA).includes("Project B"));
});

test("a share token cannot be pointed at another project's UUID path", async () => {
  // The share route is bound to the token only — there is no way to express
  // "project B via token A". Verify the route never resolves /s/{token}/../p
  // style constructs and meta.json stays hidden.
  const s = globalThis.__shareA;

  const meta = await server.preview(shareUrl(s.token, "/meta.json"));
  assert.equal(meta.status, 404, "meta.json never served via share");

  // fetch() normalizes dot-segments client-side, so traversal must be probed
  // with a raw HTTP request (same technique as tests/preview.test.mjs).
  function rawRequest(path) {
    return new Promise((resolve, reject) => {
      const u = new URL(server.previewBase);
      const req = http.request(
        { host: u.hostname, port: u.port, path, method: "GET" },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  assert.equal(await rawRequest(`/s/../p/${projectB.id}/`), 404, "raw dot-segment rejected");
  assert.equal(
    await rawRequest(shareUrl(s.token, "/../..//meta.json")),
    404,
    "raw traversal under a valid token rejected"
  );

  const encoded = await server.preview(shareUrl(s.token, "/%2e%2e/index.html"));
  assert.equal(encoded.status, 404, "encoded traversal rejected");
});

test("expired shares are denied (404) after their expiry instant", async () => {
  const soon = new Date(Date.now() + 400).toISOString();
  const s = await createShare(projectA.id, { expiresAt: soon });

  const live = await server.preview(shareUrl(s.token));
  assert.equal(live.status, 200, "valid until expiry");

  await new Promise((r) => setTimeout(r, 700));

  const expired = await server.preview(shareUrl(s.token));
  assert.equal(expired.status, 404, "denied after expiry");

  const listed = await server.api(`/api/projects/${projectA.id}/shares`);
  const view = listed.json.shares.find((x) => x.id === s.id);
  assert.equal(view.status, "expired", "status derived as expired");
});

test("past expiresAt is rejected at creation", async () => {
  const r = await server.api(`/api/projects/${projectA.id}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresAt: "2001-01-01T00:00:00.000Z" })
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_EXPIRES_AT");
});

test("revoked shares are permanently denied; disabled can be re-enabled", async () => {
  const s = await createShare(projectA.id);

  // Disable → 404 → enable → 200 again.
  const off = await server.api(`/api/projects/${projectA.id}/shares/${s.id}/disable`, { method: "POST" });
  assert.equal(off.status, 200);
  assert.equal(off.json.status, "disabled");
  assert.equal((await server.preview(shareUrl(s.token))).status, 404);

  const on = await server.api(`/api/projects/${projectA.id}/shares/${s.id}/enable`, { method: "POST" });
  assert.equal(on.status, 200);
  assert.equal(on.json.status, "active");
  assert.equal((await server.preview(shareUrl(s.token))).status, 200);

  // Revoke → permanent 404, re-enable refused.
  const rev = await server.api(`/api/projects/${projectA.id}/shares/${s.id}/revoke`, { method: "POST" });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.status, "revoked");
  assert.equal(rev.json.revoked, true);
  assert.equal((await server.preview(shareUrl(s.token))).status, 404);

  const reEnable = await server.api(`/api/projects/${projectA.id}/shares/${s.id}/enable`, { method: "POST" });
  assert.equal(reEnable.status, 400);
  assert.equal(reEnable.json.code, "SHARE_REVOKED");
  assert.equal((await server.preview(shareUrl(s.token))).status, 404);
});

test("share access requires no API token and never leaks the admin token", async () => {
  const s = globalThis.__shareA;
  const res = await server.preview(shareUrl(s.token));
  assert.equal(res.status, 200);
  assert.ok(!res.headers.get("content-security-policy").includes(server.token));
  assert.ok(!(await res.text()).includes(server.token));
});

test("share responses keep the sandbox CSP boundary (no relaxation)", async () => {
  const s = globalThis.__shareA;
  const res = await server.preview(shareUrl(s.token));
  const csp = res.headers.get("content-security-policy");

  assert.match(csp, /sandbox allow-scripts/);
  assert.ok(!csp.includes("allow-same-origin"), "same-origin must stay off");
  assert.ok(!csp.includes("unsafe-eval"), "eval must stay off");
  assert.match(csp, /default-src 'none'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("new versions and rollbacks flow through the same share link", async () => {
  const s = await createShare(projectA.id, { expiresInHours: 24 });

  const fd = new FormData();
  fd.set("file", new Blob(["<html><body><h1>Project A v2</h1></body></html>"]), "v2.html");
  const v2 = await server.api(`/api/projects/${projectA.id}/versions`, { method: "POST", body: fd });
  assert.equal(v2.status, 201);

  const after = await server.preview(shareUrl(s.token));
  assert.match(await after.text(), /Project A v2/, "share follows the new current version");
  assert.equal((await server.api(`/api/projects/${projectA.id}/shares`)).json.shares.find((x) => x.id === s.id).status, "active");

  const rb = await server.api(`/api/projects/${projectA.id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1 })
  });
  assert.equal(rb.status, 200);
  assert.equal(rb.json.rolledBack, true);

  const rolled = await server.preview(shareUrl(s.token));
  assert.match(await rolled.text(), /Project A v1/, "share follows the rolled-back version");
});

test("project preview disable does not affect its share links", async () => {
  const s = await createShare(projectA.id);
  const off = await server.api(`/api/projects/${projectA.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: false })
  });
  assert.equal(off.status, 200);

  assert.equal((await server.preview(`/p/${projectA.id}/`)).status, 404, "/p denied");
  assert.equal((await server.preview(`/p/${projectA.id}/css/app.css`)).status, 404, "/p resources denied");
  assert.equal((await server.preview(shareUrl(s.token))).status, 200, "share still works");
  assert.equal((await server.preview(shareUrl(s.token, "/css/app.css"))).status, 200, "share resources still work");

  await server.api(`/api/projects/${projectA.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewEnabled: true })
  });
});

test("access stats: root document counts one visit, assets do not; denials record status", async () => {
  const s = await createShare(projectA.id);

  await server.preview(shareUrl(s.token));
  await server.preview(shareUrl(s.token, "/css/app.css"));
  await server.preview(shareUrl(s.token, "/js/app.js"));
  await server.preview(shareUrl(s.token, "/img/logo.png"));
  await server.preview(shareUrl(s.token));

  let listed = await server.api(`/api/projects/${projectA.id}/shares`);
  let view = listed.json.shares.find((x) => x.id === s.id);
  assert.equal(view.accessCount, 2, "two root requests = two visits; assets not counted");
  assert.ok(view.lastAccessAt);
  assert.equal(view.lastAccessStatus, "ok");

  // A denied request records its status without counting a visit.
  await server.api(`/api/projects/${projectA.id}/shares/${s.id}/disable`, { method: "POST" });
  await server.preview(shareUrl(s.token));

  listed = await server.api(`/api/projects/${projectA.id}/shares`);
  view = listed.json.shares.find((x) => x.id === s.id);
  assert.equal(view.accessCount, 2, "denied attempts are not counted as visits");
  assert.equal(view.lastAccessStatus, "disabled", "denial outcome recorded");
});

test("HEAD on a share root does not count as a visit", async () => {
  const s = await createShare(projectA.id);
  const head = await server.preview(shareUrl(s.token), { method: "HEAD" });
  assert.equal(head.status, 200);

  const listed = await server.api(`/api/projects/${projectA.id}/shares`);
  const view = listed.json.shares.find((x) => x.id === s.id);
  assert.equal(view.accessCount, 0);
});

test("Axure project share renders the nav page with share-scoped links only", async () => {
  const axureZip = filesZip([
    { name: "index.html", data: "<html><body>Axure player shell</body></html>" },
    { name: "data/document.js", data: "window.sitemap={};"},
    { name: "resources/scripts/axure/player.js", data: "//player" },
    { name: "首页.html", data: "<html><body><h1>首页</h1></body></html>" },
    { name: "配置管理.html", data: "<html><body><h1>配置</h1></body></html>" }
  ]);
  const fd = new FormData();
  fd.set("name", "AxureShare");
  fd.set("file", new Blob([axureZip]), "axure.zip");
  const created = await server.api("/api/projects", { method: "POST", body: fd });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const s = await createShare(created.json.id);
  const nav = await server.preview(shareUrl(s.token));
  assert.equal(nav.status, 200);
  const html = await nav.text();

  assert.match(html, /安全预览/, "nav page rendered for share");
  const homeHref = `/s/${s.token}/${encodeURIComponent("首页.html")}`;
  assert.ok(html.includes(homeHref), "page links are share-scoped (per-segment encoded)");
  assert.ok(!html.includes(`/p/${created.json.id}/`), "no open-preview URL leakage");
  assert.ok(!html.includes('id="rawEntry"'), "the broken Axure player entry is not shown");
  const native = await server.preview(shareUrl(s.token, "/index.html?p=首页"), { redirect: "manual" });
  assert.equal(native.status, 302);
  assert.equal(native.headers.get("location"), `/s/${s.token}/#/s/${s.token}/${encodeURIComponent("首页.html")}`);

  const page = await server.preview(shareUrl(s.token, `/${encodeURIComponent("首页.html")}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /首页/);
});

test("shares API requires auth and 404s unknown projects", async () => {
  const noAuth = await fetch(`${server.apiBase}/api/projects/${projectA.id}/shares`);
  assert.equal(noAuth.status, 401);

  const missing = await server.api(`/api/projects/${crypto.randomUUID()}/shares`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "PROJECT_NOT_FOUND");

  const unknownShare = await server.api(`/api/projects/${projectA.id}/shares/${"f".repeat(16)}/revoke`, { method: "POST" });
  assert.equal(unknownShare.status, 404);
  assert.equal(unknownShare.json.code, "SHARE_NOT_FOUND");
});
