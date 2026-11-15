// Deploy pipeline shared by `arcunara deploy` and `arcunara watch`:
// collect source → client-side quota precheck → pack → hash → upload.
//
// The upload is idempotent: the content hash rides the request and the
// server skips version creation when the current version already has the
// same content. A failed upload never changes the current version.

import fs from "node:fs/promises";
import path from "node:path";
import { collectDirectory, contentHashOfBuffer } from "./collect.mjs";
import { buildZip } from "./zip.mjs";
import { apiRequest, uploadVersion } from "./client.mjs";

const HTML_RE = /\.(html?|htm)$/i;

function log(message) {
  process.stderr.write(`${message}\n`);
}

// Resolves the publishable source and produces upload payload + metadata.
export async function prepareSource(sourcePath, limits) {
  const resolved = path.resolve(sourcePath);
  const st = await fs.lstat(resolved);

  if (st.isDirectory()) {
    log(`正在收集目录 ${resolved} ...`);
    const collected = await collectDirectory(resolved, limits);
    log(`共 ${collected.fileCount} 个文件，${fmtSize(collected.totalSize)}，正在打包 ...`);
    const zip = buildZip(collected.entries);

    if (limits && zip.length > limits.maxZipBytes) {
      throw new Error(
        `打包后超过服务器 ZIP 限制：${fmtSize(zip.length)} > ${fmtSize(limits.maxZipBytes)}`
      );
    }

    return {
      data: zip,
      filename: "deploy.zip",
      contentType: "application/zip",
      contentHash: collected.contentHash,
      fileCount: collected.fileCount,
      totalSize: collected.totalSize,
      kind: "directory"
    };
  }

  if (!st.isFile()) {
    throw new Error(`不支持的源类型（既不是目录也不是常规文件）：${resolved}`);
  }

  if (HTML_RE.test(resolved)) {
    const data = await fs.readFile(resolved);

    if (limits && data.length > limits.maxHtmlBytes) {
      throw new Error(
        `HTML 文件超过服务器限制：${fmtSize(data.length)} > ${fmtSize(limits.maxHtmlBytes)}`
      );
    }

    const text = data.toString("utf8");

    if (!text.toLowerCase().includes("<html")) {
      throw new Error("该文件不是有效的 HTML 文档（缺少 <html> 标记）");
    }

    return {
      data,
      filename: path.basename(resolved),
      contentType: "text/html",
      contentHash: contentHashOfBuffer(data),
      fileCount: 1,
      totalSize: data.length,
      kind: "html"
    };
  }

  if (/\.zip$/i.test(resolved)) {
    const data = await fs.readFile(resolved);

    if (limits && data.length > limits.maxZipBytes) {
      throw new Error(
        `ZIP 文件超过服务器限制：${fmtSize(data.length)} > ${fmtSize(limits.maxZipBytes)}`
      );
    }

    return {
      data,
      filename: path.basename(resolved),
      contentType: "application/zip",
      contentHash: contentHashOfBuffer(data),
      fileCount: null,
      totalSize: data.length,
      kind: "zip"
    };
  }

  throw new Error("请提供 HTML 文件、ZIP 文件或包含原型的目录");
}

// Fetches server limits and runs the client-side quota precheck.
export async function precheck(api, sourcePath) {
  const limits = (await api(`/api/limits`)).limits;

  if (!limits) {
    throw new Error("无法获取服务器上传配额（/api/limits）");
  }

  const prepared = await prepareSource(sourcePath, limits);

  return { prepared, limits };
}

export async function publishOnce({ apiBase, projectId, token, sourcePath, onResult }) {
  const api = (pathname) => apiRequest(apiBase, pathname, { token });

  const { prepared } = await precheck(api, sourcePath);

  log(
    `上传 ${prepared.filename}（${fmtSize(prepared.data.length)}，内容指纹 ${prepared.contentHash.slice(0, 12)}…）`
  );

  const view = await uploadVersion(apiBase, projectId, {
    token,
    data: prepared.data,
    filename: prepared.filename,
    contentType: prepared.contentType,
    contentHash: prepared.contentHash,
    onProgress(pct, sent, total) {
      log(`上传进度 ${pct}%（${fmtSize(sent)}/${fmtSize(total)}）`);
    }
  });

  return { view, prepared };
}

// Limited retry with exponential backoff (watch mode; deploy fails fast
// with a clear error so the operator can fix the tunnel/network first).
export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, onRetry } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (attempt < attempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);

        if (onRetry) {
          onRetry(err, attempt, delay);
        }

        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

export function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}
