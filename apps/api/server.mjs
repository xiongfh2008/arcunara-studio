// Arcunara Studio API — v0.2.0 baseline migrated from legacy-v02/server.mjs.
//
// HTTP behavior is kept byte-compatible with the validated VPS v0.2.0
// deployment. Only the data directory, token file, listen ports and bind
// addresses are configurable via environment variables; all defaults match
// the legacy setup, so the container behavior on the VPS is unchanged.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const STORE = process.env.ARCU_DATA_DIR || "/app/data";
const TOKEN = readFileSync(
  process.env.ARCU_TOKEN_FILE || "/run/secrets/api_token",
  "utf8"
).trim();

// Fail fast on an empty token file instead of silently serving /api/ to
// everyone (an empty token compares equal to a missing Authorization header).
if (!TOKEN) {
  console.error("API token file is empty");
  process.exit(1);
}

const MAX_BODY = 256 * 1024;

function portFromEnv(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`Invalid ${name}: "${raw}"`);
    process.exit(1);
  }

  return value;
}

const API_PORT = portFromEnv("ARCU_API_PORT", 3000);
const API_HOST = process.env.ARCU_API_HOST || "0.0.0.0";
const PREVIEW_PORT = portFromEnv("ARCU_PREVIEW_PORT", 3001);
const PREVIEW_HOST = process.env.ARCU_PREVIEW_HOST || "0.0.0.0";

function json(res, code, value) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(value));
}

function authorized(req) {
  const provided = (
    req.headers.authorization || ""
  ).replace(/^Bearer /, "");

  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

async function readBody(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY) {
      const err = new Error("Request too large");
      err.status = 413;
      throw err;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

const api = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(
      req.url || "/",
      "http://localhost"
    ).pathname;

    if (
      req.method === "GET" &&
      pathname === "/health"
    ) {
      return json(res, 200, {
        ok: true,
        service: "arcunara-studio-dev",
        version: "0.2.0"
      });
    }

    if (
      !pathname.startsWith("/api/") ||
      !authorized(req)
    ) {
      return json(res, 401, {
        error: "Unauthorized"
      });
    }

    if (
      req.method === "GET" &&
      pathname === "/api/projects"
    ) {
      const entries = await fs.readdir(STORE, {
        withFileTypes: true
      });

      const projects = [];

      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          !/^[0-9a-f-]{36}$/.test(entry.name)
        ) {
          continue;
        }

        try {
          const file = path.join(
            STORE,
            entry.name,
            "meta.json"
          );

          projects.push(JSON.parse(
            await fs.readFile(file, "utf8")
          ));
        } catch {}
      }

      projects.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      );

      return json(res, 200, { projects });
    }

    if (
      req.method === "POST" &&
      pathname === "/api/projects"
    ) {
      const contentType =
        req.headers["content-type"] || "";

      if (!contentType.startsWith(
        "application/json"
      )) {
        return json(res, 415, {
          error: "Use application/json"
        });
      }

      let payload;

      try {
        payload = JSON.parse(
          await readBody(req)
        );
      } catch (err) {
        return json(
          res,
          err.status || 400,
          {
            error: err.status
              ? "Request too large"
              : "Invalid JSON"
          }
        );
      }

      const name =
        typeof payload.name === "string"
          ? payload.name.trim()
          : "";

      const html =
        typeof payload.html === "string"
          ? payload.html
          : "";

      if (
        !name ||
        name.length > 100 ||
        !html.toLowerCase().includes("<html") ||
        Buffer.byteLength(html) > 180000
      ) {
        return json(res, 400, {
          error: "Invalid name or HTML"
        });
      }

      const id = crypto.randomUUID();
      const dir = path.join(STORE, id);

      const meta = {
        id,
        name,
        createdAt: new Date().toISOString()
      };

      await fs.mkdir(dir, {
        recursive: false,
        mode: 0o700
      });

      try {
        await fs.writeFile(
          path.join(dir, "index.html"),
          html,
          { flag: "wx", mode: 0o600 }
        );

        await fs.writeFile(
          path.join(dir, "meta.json"),
          JSON.stringify(meta),
          { flag: "wx", mode: 0o600 }
        );
      } catch (err) {
        await fs.rm(dir, {
          recursive: true,
          force: true
        });

        throw err;
      }

      return json(res, 201, {
        ...meta,
        previewPath: `/p/${id}/`
      });
    }

    return json(res, 404, {
      error: "Not Found"
    });

  } catch (err) {
    console.error("API error:", err.message);

    return json(res, 500, {
      error: "Internal error"
    });
  }
});

const preview = http.createServer(
  async (req, res) => {
    const pathname = new URL(
      req.url || "/",
      "http://localhost"
    ).pathname;

    const match =
      /^\/p\/([0-9a-f-]{36})\/$/.exec(pathname);

    if (req.method !== "GET" || !match) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    try {
      const html = await fs.readFile(
        path.join(
          STORE,
          match[1],
          "index.html"
        )
      );

      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "sandbox allow-scripts allow-forms; " +
          "default-src 'none'; " +
          "script-src 'unsafe-inline'; " +
          "style-src 'unsafe-inline'; " +
          "img-src data:"
      });

      res.end(html);

    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
);

await fs.mkdir(STORE, {
  recursive: true
});

api.listen(API_PORT, API_HOST, () => {
  console.log(`Arcunara API v0.2 started on port ${api.address().port}`);
});

preview.listen(PREVIEW_PORT, PREVIEW_HOST, () => {
  console.log(`Arcunara Preview v0.2 started on port ${preview.address().port}`);
});
