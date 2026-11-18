import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCloudflareAccessAuth } from "../apps/api/lib/cloudflare-access.mjs";
import { loadConfig } from "../apps/api/lib/config.mjs";
import { startServer } from "./helpers/harness.mjs";

const issuer = "https://alexxiong2025.cloudflareaccess.com";
const audience = "a".repeat(64);
const origin = "https://staging.arcunara.com";
const email = "admin@example.org";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "test-key-1";
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const settings = { issuer, audience, origin, host: "staging.arcunara.com", email };

function jwt(overrides = {}, headerOverrides = {}, signingKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid, ...headerOverrides };
  const payload = {
    iss: issuer, aud: [audience], email, iat: now - 10, nbf: now - 10,
    exp: now + 1800, ...overrides
  };
  const body = Buffer.from(JSON.stringify(header)).toString("base64url") + "." +
    Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + crypto.sign("RSA-SHA256", Buffer.from(body), signingKey).toString("base64url");
}

function req(token, method = "GET", options = {}) {
  return {
    method,
    headers: {
      host: settings.host,
      "cf-access-jwt-assertion": token,
      ...(method === "GET" ? {} : {
        origin,
        "x-arcunara-access-request": "1",
        "sec-fetch-site": "same-origin"
      }),
      ...options
    }
  };
}

test("valid signed Cloudflare assertion authorizes only the protected origin", async () => {
  const auth = createCloudflareAccessAuth({ cloudflareAccess: settings },
    { loadKeys: async () => [jwk] });
  assert.equal(auth.enabled, true);
  assert.equal(await auth.authorized(req(jwt())), true);
  assert.equal(await auth.authorized(req(jwt(), "POST")), true);
  assert.equal(await auth.authorized(req(jwt(), "PATCH")), true);
  assert.equal(await auth.authorized(req(jwt(), "POST", { origin: "https://evil.test" })), false);
  assert.equal(await auth.authorized(req(jwt(), "POST", { "x-arcunara-access-request": undefined })), false);
  assert.equal(await auth.authorized(req(jwt(), "POST", { "sec-fetch-site": "cross-site" })), false);
  assert.equal(await auth.authorized(req(jwt(), "GET", { host: "127.0.0.1:28088" })), false);
  assert.equal(await auth.authorized(req(jwt(), "GET", { authorization: "Bearer invalid" })), false);
});

test("forged, expired, misissued and wrong-audience assertions fail closed", async () => {
  const auth = createCloudflareAccessAuth({ cloudflareAccess: settings },
    { loadKeys: async () => [jwk] });
  const cases = [
    jwt({ aud: "other" }),
    jwt({ iss: "https://fake.cloudflareaccess.com" }),
    jwt({ email: "other@example.org" }),
    jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
    jwt({ nbf: Math.floor(Date.now() / 1000) + 120 }),
    jwt({}, { alg: "none" }),
    jwt({}, { kid: "unknown" }),
    jwt({ email: email + ".not-real" })
  ];
  const { privateKey: attacker } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  cases.push(jwt({}, {}, attacker), "broken.jwt", "", undefined);
  for (const value of cases) {
    assert.equal(await auth.authorized(req(value)), false,
      "Must reject invalid assertion: " + String(value).slice(0, 25));
  }
});

test("JWKS load errors never grant authentication", async () => {
  const auth = createCloudflareAccessAuth({ cloudflareAccess: settings },
    { loadKeys: async () => { throw new Error("network unavailable"); } });
  assert.equal(await auth.authorized(req(jwt())), false);
});

test("Cloudflare Access is disabled by default and configurations must be complete", async () => {
  const disabled = createCloudflareAccessAuth({ cloudflareAccess: null });
  assert.equal(disabled.enabled, false);
  assert.equal(await disabled.authorized(req(jwt())), false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-cf-config-"));
  const tokenFile = path.join(dir, "token");
  await fs.writeFile(tokenFile, "test-token", "utf8");
  const env = {
    ARCU_TOKEN_FILE: tokenFile,
    ARCU_ACCESS_ISSUER: issuer,
    ARCU_ACCESS_AUDIENCE: audience,
    ARCU_ACCESS_ADMIN_EMAIL: email,
    ARCU_ACCESS_ORIGIN: origin
  };
  try {
    const config = loadConfig(env);
    assert.deepEqual(config.cloudflareAccess, settings);
    assert.throws(() => loadConfig({ ...env, ARCU_ACCESS_AUDIENCE: "" }),
      /requires all four/);
    assert.throws(() => loadConfig({ ...env, ARCU_ACCESS_ORIGIN: "http://staging.arcunara.com" }),
      /Invalid Cloudflare Access/);
    assert.throws(() => loadConfig({ ...env, ARCU_ACCESS_ISSUER: "https://malicious.example" }),
      /Invalid Cloudflare Access/);
    assert.throws(() => loadConfig({ ...env, ARCU_LOCAL_AUTO_LOGIN: "1" }),
      /cannot both be enabled/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("no Access assertion remains 401 even when staging SSO is configured", async () => {
  const server = await startServer({
    ARCU_ACCESS_ISSUER: issuer,
    ARCU_ACCESS_AUDIENCE: audience,
    ARCU_ACCESS_ADMIN_EMAIL: email,
    ARCU_ACCESS_ORIGIN: origin
  });
  try {
    const page = await fetch(server.apiBase + "/console");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /window\.__ARCU_ACCESS_AUTO_LOGIN__ = true;/);
    assert.ok(!html.includes(server.token));

    const withoutJwt = await server.api("/api/projects", { token: null });
    assert.equal(withoutJwt.status, 401);
    const forged = await server.api("/api/projects", {
      token: null,
      headers: {
        host: settings.host,
        "cf-access-jwt-assertion": "forged.jwt.signature"
      }
    });
    assert.equal(forged.status, 401);
    const bearer = await server.api("/api/projects");
    assert.equal(bearer.status, 200, "existing administrator bearer remains functional");
  } finally {
    await server.stop();
    await server.cleanup();
  }
});
