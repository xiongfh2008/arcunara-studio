// Streaming multipart/form-data parsing (busboy) with live enforcement of
// upload quotas. The uploaded file is streamed to a temp file in the store's
// staging area — the body is never buffered in memory.

import Busboy from "busboy";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ApiError } from "./httputil.mjs";

export function isZipName(name) {
  return typeof name === "string" && /\.zip$/i.test(name);
}

export function isHtmlName(name) {
  return typeof name === "string" && /\.html?$/i.test(name);
}

// Resolves with { fields, file: { filename, tmpPath, bytes } } or rejects
// with an ApiError. On any rejection all temp artifacts are removed and the
// request body is drained first, so the client can finish sending and still
// receive the error response instead of a connection reset.
export function parseMultipartUpload(req, { tmpDir, limits }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let busboy = null;
    const tempPaths = [];
    const fields = {};
    let file = null;
    let fileOut = null;
    let fileWritePromise = Promise.resolve();

    async function destroyFileOut() {
      const out = fileOut;

      if (out && !out.destroyed) {
        await new Promise((r) => {
          out.once("close", r);
          out.destroy();
        });
      }
    }

    async function cleanup() {
      await destroyFileOut();

      for (const p of tempPaths.splice(0)) {
        await fs.rm(p, { force: true }).catch(() => {});
      }
    }

    function drainRequest(maxBytes = 64 * 1024 * 1024) {
      return new Promise((resolve) => {
        if (req.readableEnded || req.destroyed) return resolve();

        let drained = 0;
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          req.off("data", onData);
          req.off("end", finish);
          req.off("close", finish);
          resolve();
        };

        const onData = (chunk) => {
          drained += chunk.length;
          if (drained > maxBytes) {
            req.destroy(); // bound the drain; the client loses the connection
            finish();
          }
        };

        req.on("data", onData);
        req.on("end", finish);
        req.on("close", finish);
        req.resume();
      });
    }

    async function fail(err) {
      if (settled) return;
      settled = true;

      try {
        req.unpipe(busboy);
        busboy?.removeAllListeners?.();
      } catch {}

      await cleanup();
      await drainRequest();
      reject(err);
    }

    function succeed(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    try {
      // errors thrown synchronously inside handlers are funneled into fail()
      busboy = Busboy({
        headers: req.headers,
        limits: {
          // Catastrophic backup only: our own streaming counters enforce the
          // precise caps first (ZIP_TOO_LARGE / HTML_TOO_LARGE).
          fileSize: limits.maxZipBytes + 1024 * 1024,
          // Two so a second file part surfaces as an event we can reject;
          // busboy would silently drop parts beyond this limit.
          files: 2,
          fields: 10,
          fieldSize: 64 * 1024,
          fieldsSize: 256 * 1024,
          headerPairs: 100
        }
      });
    } catch (err) {
      fail(new ApiError(400, "Invalid multipart payload", "INVALID_MULTIPART", err));
      return;
    }

    // Total request body cap, enforced live while the upload streams in.
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > limits.maxUploadBodyBytes && !settled) {
        fail(new ApiError(413, "Request too large", "UPLOAD_TOO_LARGE"));
      }
    });

    req.on("error", (err) =>
      fail(new ApiError(400, "Request stream error", "REQUEST_STREAM_ERROR", err))
    );

    busboy.on("field", (name, value) => {
      if (!settled && fields[name] === undefined) {
        fields[name] = value;
      }
    });

    busboy.on("file", (name, stream, info) => {
      if (settled) {
        stream.resume();
        return;
      }

      if (file) {
        stream.resume();
        fail(new ApiError(400, "Only one file per request", "MULTIPLE_FILES"));
        return;
      }

      const filename = info.filename || "";

      if (!isZipName(filename) && !isHtmlName(filename)) {
        stream.resume();
        fail(new ApiError(400, "Unsupported file type", "UNSUPPORTED_FILE_TYPE"));
        return;
      }

      const cap = isZipName(filename)
        ? limits.maxZipBytes
        : limits.maxHtmlBytes;

      const tmpPath = path.join(
        tmpDir,
        `upload-${crypto.randomBytes(8).toString("hex")}`
      );
      tempPaths.push(tmpPath);

      file = { filename, tmpPath, bytes: 0 };

      let bytes = 0;
      const out = fsSync.createWriteStream(tmpPath, {
        flags: "wx",
        mode: 0o600
      });
      fileOut = out;

      stream.on("data", (chunk) => {
        if (settled) return;

        bytes += chunk.length;
        file.bytes = bytes;

        if (bytes > cap) {
          fail(
            new ApiError(
              413,
              isZipName(filename)
                ? "ZIP archive too large"
                : "HTML file too large",
              isZipName(filename) ? "ZIP_TOO_LARGE" : "HTML_TOO_LARGE"
            )
          );
        }
      });

      stream.on("limit", () => {
        fail(new ApiError(413, "Uploaded file too large", "FILE_LIMIT"));
      });

      stream.on("error", (err) =>
        fail(new ApiError(400, "Invalid multipart payload", "INVALID_MULTIPART", err))
      );

      out.on("error", (err) =>
        fail(new ApiError(500, "Internal error", "WRITE_FAILED", err))
      );

      fileWritePromise = new Promise((resolveWrite) => {
        out.on("finish", resolveWrite);
      });

      stream.pipe(out);
    });

    busboy.on("error", (err) =>
      fail(new ApiError(400, "Invalid multipart payload", "INVALID_MULTIPART", err))
    );

    busboy.on("close", () => {
      if (settled) return;

      fileWritePromise.then(() => {
        if (settled) return;

        if (!file) {
          fail(new ApiError(400, "File field is required", "FILE_REQUIRED"));
          return;
        }

        if (file.bytes === 0) {
          fail(new ApiError(400, "Uploaded file is empty", "EMPTY_FILE"));
          return;
        }

        succeed({ fields, file });
      }, () => {});
    });

    req.pipe(busboy);
  });
}
