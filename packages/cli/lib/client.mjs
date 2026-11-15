// Arcunara API client for the CLI.
//
// Uses node:http(s) directly so the multipart upload can stream progress.
// Credentials are supplied by the caller (env) and are never persisted by
// this module — nothing here writes tokens to disk or logs.

import http from "node:http";
import https from "node:https";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestOnce(apiBase, pathname, { method = "GET", token, headers = {}, body, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let base;

    try {
      base = new URL(apiBase);
    } catch {
      reject(new Error(`Invalid API address: ${apiBase}`));
      return;
    }

    const isHttps = base.protocol === "https:";

    if (base.protocol !== "http:" && !isHttps) {
      reject(new Error(`Unsupported API protocol: ${base.protocol} (use http or https)`));
      return;
    }

    const h = { ...headers };

    if (token) {
      h.authorization = `Bearer ${token}`;
    }

    if (body && !h["content-length"]) {
      h["content-length"] = String(body.length);
    }

    const req = (isHttps ? https : http).request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: base.pathname.replace(/\/+$/, "") + pathname,
        method,
        headers: h,
        timeout: 60000
      },
      (res) => {
        const chunks = [];
        let size = 0;

        res.on("data", (chunk) => {
          chunks.push(chunk);
          size += chunk.length;

          if (size > 4 * 1024 * 1024) {
            req.destroy(new ApiError(500, "RESPONSE_TOO_LARGE", "Response too large"));
          }
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;

          try {
            json = JSON.parse(text);
          } catch {}

          resolve({ status: res.statusCode, json, text });
        });

        res.on("error", reject);
      }
    );

    req.on("timeout", () => {
      req.destroy(new ApiError(0, "TIMEOUT", "Connection timed out (is the SSH tunnel up?)"));
    });

    req.on("error", (err) => {
      if (err instanceof ApiError) {
        reject(err);
      } else {
        reject(new ApiError(0, "NETWORK", `Network error: ${err.message}`));
      }
    });

    if (body) {
      // Chunked writes honoring backpressure so progress reflects the
      // bytes actually handed to the socket.
      writeBody(req, body, onProgress).catch(reject);
    } else {
      req.end();
    }
  });
}

async function writeBody(req, body, onProgress) {
  const CHUNK = 64 * 1024;
  let sent = 0;

  for (let i = 0; i < body.length; i += CHUNK) {
    const slice = body.subarray(i, Math.min(i + CHUNK, body.length));

    if (!req.write(slice)) {
      await new Promise((resolve) => req.once("drain", resolve));
    }

    sent += slice.length;

    if (onProgress) {
      onProgress(sent, body.length);
    }
  }

  req.end();
}

export function toApiError(res, fallbackMessage) {
  const code = res.json?.code || "HTTP_ERROR";
  const message =
    res.json?.error ||
    (res.json?.message) ||
    fallbackMessage ||
    `HTTP ${res.status}`;
  return new ApiError(res.status, code, message);
}

export async function apiRequest(apiBase, pathname, options = {}) {
  const res = await requestOnce(apiBase, pathname, options);

  if (res.status >= 400) {
    throw toApiError(res);
  }

  return res.json;
}

// Multipart version upload with a single file field, matching the
// workbench upload format (field name "file").
export function uploadVersion(apiBase, projectId, { token, data, filename, contentType, contentHash, onProgress } = {}) {
  const boundary = `arcunara-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  const parts = [];

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename.replace(/["\r\n]/g, "")}"\r\n` +
        `Content-Type: ${contentType}\r\n` +
        `\r\n`
    )
  );
  parts.push(data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  const headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`
  };

  if (contentHash) {
    headers["x-arcunara-content-hash"] = contentHash;
  }

  let lastPct = -1;

  return requestOnce(apiBase, `/api/projects/${projectId}/versions`, {
    method: "POST",
    token,
    headers,
    body,
    onProgress(sent, total) {
      if (!onProgress) return;
      const pct = Math.floor((sent / total) * 100);

      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(pct, sent, total);
      }
    }
  }).then(async (res) => {
    if (res.status >= 400) {
      throw toApiError(res, "Upload failed");
    }

    return res.json;
  });
}
