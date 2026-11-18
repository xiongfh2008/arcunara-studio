// Staging single-host preview gateway: opt-in, fail-closed /p, token-scoped /s.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../apps/api/lib/config.mjs";
import { startServer } from "./helpers/harness.mjs";

const settings = {
  ARCU_ACCESS_ISSUER: "https://alexxiong2025.cloudflareaccess.com",
  ARCU_ACCESS_AUDIENCE: "a".repeat(64),
  ARCU_ACCESS_ADMIN_EMAIL: "admin@example.org",
  ARCU_ACCESS_ORIGIN: "https://staging.arcunara.com",
  ARCU_PREVIEW_PUBLIC_BASE_URL: "https://staging.arcunara.com",
  ARCU_STAGING_PUBLIC_PREVIEW: "1"
};

test("public gateway opts in only with complete Access and exact HTTPS preview origin", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-public-config-"));
  const tokenFile = path.join(dir, "admin_token");
  await fs.writeFile(tokenFile, "secret");
  const env = { ARCU_TOKEN_FILE: tokenFile, ...settings };
  try {
    const config = loadConfig(env);
    assert.equal(config.stagingPublicPreview, true);
    assert.equal(config.previewPublicBaseUrl, config.cloudflareAccess.origin);
    assert.throws(() => loadConfig({ ...env, ARCU_ACCESS_ADMIN_EMAIL: "" }),
      /requires all four/);
    assert.throws(() => loadConfig({ ...env, ARCU_STAGING_PUBLIC_PREVIEW: "yes" }),
      /must be 0 or 1/);
    assert.throws(() => loadConfig({ ...env, ARCU_PREVIEW_PUBLIC_BASE_URL: "http:\/\/127.0.0.1:28089" }),
      /requires Cloudflare Access/);
    assert.throws(() => loadConfig({ ...env, ARCU_PREVIEW_PUBLIC_BASE_URL: "https:\/\/staging.arcunara.com\/p" }),
      /requires Cloudflare Access/);
    assert.throws(() => loadConfig({ ARCU_TOKEN_FILE: tokenFile, ARCU_STAGING_PUBLIC_PREVIEW: "1" }),
      /requires Cloudflare Access/);
    assert.equal(loadConfig({ ARCU_TOKEN_FILE: tokenFile }).stagingPublicPreview, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("gateway denies every private /p request without a valid signed Access assertion; /s tokens remain usable", async () => {
  const server = await startServer(settings);
  try {
    const created = await server.api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Private", html: "<html><body>Private project</body></html>" })
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    for (const url of [
      `/p/${id}`,
      `/p/${id}/`,
      `/p/${id}/index.html`
    ]) {
      const result = await server.preview(url, { redirect: "manual" });
      assert.equal(result.status, 404, url);
    }
    const head = await server.preview(`/p/${id}/index.html`, { method: "HEAD" });
    assert.equal(head.status, 404);

    const forged = await server.preview(`/p/${id}/`, {
      headers: {
        Host: "staging.arcunara.com",
        "cf-access-jwt-assertion": "forged.header.payload",
        "cf-access-authenticated-user-email": "admin@example.org"
      }
    });
    assert.equal(forged.status, 404, "email headers / forged assertions never grant access");

    const share = await server.api(`/api/projects/${id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresInHours: 1 })
    });
    assert.equal(share.status, 201);

    const sharePage = await server.preview(`/s/${share.json.token}/`);
    assert.equal(sharePage.status, 200);
    assert.match(await sharePage.text(), /Private project/);
    const csp = sharePage.headers.get("content-security-policy");
    assert.match(csp, /sandbox allow-scripts allow-forms/);
    assert.doesNotMatch(csp, /allow-same-origin/);

    const bad = await server.preview(`/s/${share.json.id}.${"A".repeat(43)}/`);
    assert.equal(bad.status, 404);
  } finally {
    await server.stop();
    await server.cleanup();
  }
});

test("Access SSO without the explicit public gateway keeps SSH-only preview working", async () => {
  const server = await startServer({
    ...settings,
    ARCU_STAGING_PUBLIC_PREVIEW: "0",
    ARCU_PREVIEW_PUBLIC_BASE_URL: "http://127.0.0.1:28089"
  });
  try {
    const created = await server.api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", html: "<html>local</html>" })
    });
    assert.equal(created.status, 201);
    const result = await server.preview(`/p/${created.json.id}/`);
    assert.equal(result.status, 200);
  } finally {
    await server.stop();
    await server.cleanup();
  }
});
