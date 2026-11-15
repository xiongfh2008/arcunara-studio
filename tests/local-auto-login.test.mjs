// Local auto-login integration: opt-in, localhost-only, browser session
// cookie (not the admin token), and Origin/header protection on writes.
import assert from "node:assert/strict";
import http from "node:http";
import { before, after, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { loadConfig } from "../apps/api/lib/config.mjs";

let server;
let cookie;

before(async () => {
  server = await startServer({ ARCU_LOCAL_AUTO_LOGIN: "1" });
  const response = await fetch(server.apiBase + "/console");
  assert.equal(response.status, 200);
  const issued = response.headers.get("set-cookie");
  assert.ok(issued);
  cookie = issued.split(";")[0];
  const html = await response.text();
  assert.match(html, /window\.__ARCU_LOCAL_AUTO_LOGIN__ = true;/);
  assert.ok(!html.includes(server.token), "admin bearer token must not be embedded");
  assert.match(issued, /HttpOnly/);
  assert.match(issued, /SameSite=Strict/);
  assert.match(issued, /Path=\/api/);
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

test("browser session reads APIs without manually pasting a token", async () => {
  const anonymous = await server.api("/api/projects", { token: null });
  assert.equal(anonymous.status, 401);

  const loggedIn = await server.api("/api/projects", {
    token: null, headers: { cookie }
  });
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(loggedIn.json, { projects: [] });
});

test("forged cookie, invalid bearer token and wrong host remain unauthorized", async () => {
  const invalid = await server.api("/api/projects", {
    token: null, headers: { cookie: "arcu_local_session=invalid" }
  });
  assert.equal(invalid.status, 401);

  const explicitBadBearer = await server.api("/api/projects", {
    token: "wrong-token", headers: { cookie }
  });
  assert.equal(explicitBadBearer.status, 401);

  // Node fetch may rewrite the Host header: use the native HTTP client so
  // this test actually sends the untrusted Host value over the wire.
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(server.apiBase + "/api/projects", {
      headers: { Host: "evil.test:3100", Cookie: cookie }
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(wrongHostStatus, 401);
});

test("local writes require same-origin Origin and non-simple request header", async () => {
  const payload = JSON.stringify({ name: "Local cookie project", html: "<html><body>ok</body></html>" });
  const base = {
    token: null,
    method: "POST",
    body: payload
  };
  const validHeaders = {
    cookie,
    origin: server.apiBase,
    "x-arcunara-local-request": "1",
    "content-type": "application/json"
  };

  const withoutOrigin = await server.api("/api/projects", {
    ...base, headers: { ...validHeaders, origin: undefined }
  });
  assert.equal(withoutOrigin.status, 401);

  const withoutHeader = await server.api("/api/projects", {
    ...base, headers: {
      cookie, origin: server.apiBase, "content-type": "application/json"
    }
  });
  assert.equal(withoutHeader.status, 401);

  const crossSite = await server.api("/api/projects", {
    ...base, headers: { ...validHeaders, origin: "https://evil.example" }
  });
  assert.equal(crossSite.status, 401);

  const forgedFetchSite = await server.api("/api/projects", {
    ...base, headers: { ...validHeaders, "sec-fetch-site": "cross-site" }
  });
  assert.equal(forgedFetchSite.status, 401);

  const valid = await server.api("/api/projects", { ...base, headers: validHeaders });
  assert.equal(valid.status, 201);
  assert.equal(valid.json.name, "Local cookie project");
});

test("local cookie does not grant access on preview origin", async () => {
  const page = await server.preview("/console", { headers: { cookie } });
  assert.equal(page.status, 404);

  const api = await server.preview("/api/projects", { headers: { cookie } });
  assert.equal(api.status, 404);
});

test("default configuration never enables auto login and never issues session cookies", async () => {
  const defaultServer = await startServer();
  try {
    const response = await fetch(defaultServer.apiBase + "/console");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(await response.text(), /window\.__ARCU_LOCAL_AUTO_LOGIN__ = false;/);
    const api = await defaultServer.api("/api/projects", { token: null });
    assert.equal(api.status, 401);
  } finally {
    await defaultServer.stop();
    await defaultServer.cleanup();
  }
});

test("configuration refuses auto login on any non-loopback listener", () => {
  for (const [apiHost, previewHost] of [
    ["0.0.0.0", "127.0.0.1"],
    ["127.0.0.1", "0.0.0.0"],
    ["localhost", "127.0.0.1"]
  ]) {
    assert.throws(
      () => loadConfig({
        ARCU_TOKEN_FILE: server.tokenFile,
        ARCU_LOCAL_AUTO_LOGIN: "1",
        ARCU_API_HOST: apiHost,
        ARCU_PREVIEW_HOST: previewHost
      }),
      /ARCU_LOCAL_AUTO_LOGIN requires/
    );
  }
  assert.throws(
    () => loadConfig({
      ARCU_TOKEN_FILE: server.tokenFile,
      ARCU_LOCAL_AUTO_LOGIN: "yes"
    }),
    /ARCU_LOCAL_AUTO_LOGIN must be 0 or 1/
  );
});
