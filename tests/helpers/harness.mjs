// Test harness: starts the real server (apps/api/server.mjs) as a child
// process against a throwaway store directory in the OS temp folder, bound
// to 127.0.0.1 on ephemeral ports. Mirrors the Docker runtime; never touches
// VPS data, production ports, or any persisted state outside the temp dir.

import { spawn } from "node:child_process";
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

    if (apiMatch && previewMatch) {
      const apiBase = `http://127.0.0.1:${apiMatch[1]}`;
      const previewBase = `http://127.0.0.1:${previewMatch[1]}`;

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
        api,
        preview(pathname, options = {}) {
          return fetch(`${previewBase}${pathname}`, options);
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
