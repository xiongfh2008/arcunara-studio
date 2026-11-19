// Test harness: starts the real server (apps/api/server.mjs) as a child
// process against a throwaway store directory in the OS temp folder, bound
// to 127.0.0.1 on ephemeral ports. Mirrors the Docker runtime; never touches
// VPS data, production ports, or any persisted state outside the temp dir.

import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const SERVER_PATH = fileURLToPath(
  new URL("../../apps/api/server.mjs", import.meta.url)
);

export async function startServer(envOverrides = {}) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "arcunara-test-"));
  const dataDir = path.join(workdir, "data");
  const tokenFile = path.join(workdir, "api_token");
  const token = `test-${crypto.randomBytes(24).toString("hex")}`;
  await fs.writeFile(tokenFile, `${token}\n`, "utf8");

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      ARCU_DATA_DIR: dataDir,
      ARCU_TOKEN_FILE: tokenFile,
      ARCU_API_HOST: "127.0.0.1",
      ARCU_PREVIEW_HOST: "127.0.0.1",
      ARCU_API_PORT: "0",
      ARCU_PREVIEW_PORT: "0",
      // Never inherit a developer's opt-in localhost browser session during tests.
      ARCU_LOCAL_AUTO_LOGIN: "0",
      ARCU_SITE_HOSTING_ENABLED: "0",
      ARCU_SITE_DOMAIN: "",
      // Keep Cloudflare staging SSO out of unrelated integration tests.
      ARCU_ACCESS_ISSUER: "",
      ARCU_ACCESS_AUDIENCE: "",
      ARCU_ACCESS_ADMIN_EMAIL: "",
      ARCU_ACCESS_ORIGIN: "",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    const apiMatch = stdout.match(/API v0\.\d+ started on port (\d+)/);
    const previewMatch = stdout.match(/Preview v0\.\d+ started on port (\d+)/);
    const siteMatch = stdout.match(/Arcunara Sites v0\.3 started on port (\d+)/);

    if (apiMatch && previewMatch &&
        (envOverrides.ARCU_SITE_HOSTING_ENABLED !== "1" || siteMatch)) {
      const apiBase = `http://127.0.0.1:${apiMatch[1]}`;
      const previewBase = `http://127.0.0.1:${previewMatch[1]}`;
      const siteBase = siteMatch ? `http://127.0.0.1:${siteMatch[1]}` : null;

      // JSON API helper. token: null sends no Authorization header.
      async function api(pathname, { method = "GET", token: tok = token, headers = {}, body } = {}) {
        const h = { ...headers };
        if (tok !== null) {
          h.authorization = `Bearer ${tok}`;
        }
        const res = await fetch(`${apiBase}${pathname}`, {
          method,
          headers: h,
          body
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return { status: res.status, headers: res.headers, text, json };
      }

      return {
        child,
        workdir,
        dataDir,
        token,
        tokenFile,
        apiBase,
        previewBase,
        siteBase,
        api,
        preview(pathname, options = {}) {
          return fetch(`${previewBase}${pathname}`, options);
        },
        site(projectId, pathname, options = {}) {
          if (!siteBase) throw new Error("Static site listener is disabled");
          // Node's fetch() forcibly rewrites Host to 127.0.0.1 (Undici).
          // Use a raw HTTP client to exercise production virtual-host routing.
          return new Promise((resolve, reject) => {
            const req = httpRequest(siteBase + pathname, {
              method: options.method || "GET",
              headers: {
                ...options.headers,
                Host: `${projectId}.${envOverrides.ARCU_SITE_DOMAIN}`
              }
            }, (res) => {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("end", () => {
                resolve(new Response(Buffer.concat(chunks), {
                  status: res.statusCode,
                  headers: res.headers
                }));
              });
              res.on("error", reject);
            });
            req.on("error", reject);
            req.end(options.body);
          });
        },
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill();
          await Promise.race([
            new Promise((resolve) => child.once("exit", resolve)),
            delay(5000).then(() => child.kill("SIGKILL"))
          ]);
        },
        async cleanup() {
          await fs.rm(workdir, { recursive: true, force: true });
        }
      };
    }

    await delay(50);
  }

  child.kill();
  throw new Error(
    `server did not start in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}
