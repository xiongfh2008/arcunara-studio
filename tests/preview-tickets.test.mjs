import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPreviewTickets } from "../apps/api/lib/preview-tickets.mjs";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const ACCESS = {
  ARCU_ACCESS_ISSUER: "https://alexxiong2025.cloudflareaccess.com",
  ARCU_ACCESS_AUDIENCE: "a".repeat(64),
  ARCU_ACCESS_ADMIN_EMAIL: "admin@example.org",
  ARCU_ACCESS_ORIGIN: "https://staging.arcunara.com",
  ARCU_PREVIEW_PUBLIC_BASE_URL: "https://staging.arcunara.com",
  ARCU_STAGING_PUBLIC_PREVIEW: "1"
};

test("short-lived preview tickets require admin, scope all assets, and do not create shares", async () => {
  const server = await startServer(ACCESS);
  try {
    const zip = filesZip([
      { name: "index.html", data: '<html><head><link rel="stylesheet" href="css/a.css"></head><body>Project A</body></html>' },
      { name: "css/a.css", data: "body{color:blue}" }
    ]);
    const form = new FormData();
    form.set("name", "Private");
    form.set("file", new Blob([zip]), "private.zip");
    const a = await server.api("/api/projects", { method: "POST", body: form });
    assert.equal(a.status, 201);
    const id = a.json.id;
    const consolePage = await server.api("/console", { token: null });
    assert.match(consolePage.text, /window\.__ARCU_STAGING_PUBLIC_PREVIEW__ = true;/);
    assert.match(consolePage.text, /usablePreviewUrl\(selected.id\)/);
    assert.equal((await server.api(`/api/projects/${id}/preview-ticket`, { method: "POST", token: null })).status, 401);
    assert.equal((await server.api(`/api/projects/${id}/preview-ticket`, { method: "GET" })).status, 404);
    assert.equal((await server.api(`/api/projects/00000000-0000-0000-0000-000000000000/preview-ticket`, { method: "POST" })).status, 404);

    const issued = await server.api(`/api/projects/${id}/preview-ticket`, { method: "POST" });
    assert.equal(issued.status, 201);
    assert.match(issued.json.token, /^ee[0-9a-f]{14}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(issued.json.expiresAt) > Date.now());

    // Every request on the sandboxed iframe uses /s and authenticates itself.
    const base = `/s/${issued.json.token}`;
    const entry = await server.preview(base + "/");
    assert.equal(entry.status, 200);
    assert.match(await entry.text(), /Project A/);
    const css = await server.preview(base + "/css/a.css");
    assert.equal(css.status, 200);
    assert.match(await css.text(), /color:blue/);
    const csp = entry.headers.get("content-security-policy");
    assert.match(csp, /sandbox allow-scripts allow-forms/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.equal((await server.preview(`/p/${id}/`)).status, 404, "UUID-only /p stays protected");
    assert.equal((await server.preview(base + "/meta.json")).status, 404);
    assert.equal((await server.preview(base + "/css/../meta.json")).status, 404);

    const [sid, secret] = issued.json.token.split(".");
    const wrongSecret = secret.slice(0, -1) + (secret.at(-1) === "A" ? "B" : "A");
    assert.equal((await server.preview(`/s/${sid}.${wrongSecret}/`)).status, 404);

    const shares = await server.api(`/api/projects/${id}/shares`);
    assert.equal(shares.json.shares.length, 0, "preview ticket must not pollute the shares list");
    const meta = await fs.readFile(path.join(server.dataDir, id, "meta.json"), "utf8");
    assert.ok(!meta.includes(issued.json.token));
    assert.ok(!meta.includes(sid));

    // Disabling preview invalidates already-issued short-lived tickets.
    const disabled = await server.api(`/api/projects/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewEnabled: false })
    });
    assert.equal(disabled.status, 200);
    assert.equal((await server.preview(base + "/")).status, 404);
    assert.equal((await server.api(`/api/projects/${id}/preview-ticket`, { method: "POST" })).status, 404);
  } finally {
    await server.stop();
    await server.cleanup();
  }
});

test("ephemeral tickets expire, reject tampering, and are evicted without persisting", () => {
  let clock = 1780000000000;
  const tickets = createPreviewTickets({ now: () => clock });
  const issued = tickets.issue("d934fc21-4f30-43d1-a524-a2dcfe0d00ba");
  const [id, secret] = issued.token.split(".");
  assert.ok(tickets.validate(id, secret));
  assert.equal(tickets.validate(id, "A".repeat(43)), null);
  assert.equal(tickets.validate("0000000000000000", secret), null);
  clock += 10 * 60 * 1000;
  assert.equal(tickets.validate(id, secret), null, "expired tickets cannot access resources");
  assert.equal(tickets.validate(id, secret), null, "no resurrection after expiry");
});

test("ticket endpoint remains disabled in local mode and legacy mode", async () => {
  const server = await startServer();
  try {
    const project = await server.api("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Legacy", html: "<html>safe</html>" })
    });
    const response = await server.api(`/api/projects/${project.json.id}/preview-ticket`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal((await server.preview(`/p/${project.json.id}/`)).status, 200);
  } finally {
    await server.stop();
    await server.cleanup();
  }
});
