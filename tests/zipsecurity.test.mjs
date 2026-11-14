// ZIP security tests: hostile archives must be rejected with clear error
// codes, must not touch the filesystem outside the staging area, and must
// leave no leftovers. Archives are built at runtime (no binary fixtures).

import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { buildZip, filesZip } from "./helpers/zipbuilder.mjs";

const INDEX_HTML = "<html><body><h1>ok</h1></body></html>";

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

async function uploadZip(name, zip) {
  const fd = new FormData();
  fd.set("name", name);
  fd.set("file", new Blob([zip]), "upload.zip");
  return server.api("/api/projects", { method: "POST", body: fd });
}

async function assertRejected(name, zip, expectedCode, expectedStatus = 400) {
  const r = await uploadZip(name, zip);

  assert.equal(r.status, expectedStatus, `${name}: status`);
  assert.equal(r.json.code, expectedCode, `${name}: code`);

  // No staging leftovers, no new projects.
  const tmp = await fs.readdir(path.join(server.dataDir, ".tmp"));
  assert.deepEqual(tmp, [], `${name}: staging leftovers`);

  const list = await server.api("/api/projects");
  assert.ok(!list.json.projects.some((p) => p.name === name), `${name}: project leaked`);
}

test("rejects path traversal entries (Zip Slip)", async () => {
  await assertRejected("Slip1", filesZip([{ name: "../evil.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Slip2", filesZip([{ name: "a/../../evil.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Slip3", filesZip([{ name: "a/./b.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Slip4", filesZip([{ name: "a//b.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
});

test("rejects absolute and drive paths", async () => {
  await assertRejected("Abs1", filesZip([{ name: "/etc/evil.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Abs2", filesZip([{ name: "C:/evil.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
});

test("rejects backslash path confusion", async () => {
  await assertRejected("Bslash1", filesZip([{ name: "..\\evil.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Bslash2", filesZip([{ name: "C:\\evil.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Bslash3", filesZip([{ name: "a\\b.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
});

test("rejects NUL bytes and control characters in names", async () => {
  await assertRejected("Nul", filesZip([{ name: "bad\u0000name.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("Ctrl", filesZip([{ name: "bad\u0001name.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
});

test("rejects Windows reserved device names", async () => {
  await assertRejected("NulDev", filesZip([{ name: "NUL", data: "x" }]), "UNSAFE_ENTRY_PATH");
  await assertRejected("ConDev", filesZip([{ name: "CON.txt", data: "x" }]), "UNSAFE_ENTRY_PATH");
});

test("rejects symlink entries", async () => {
  await assertRejected(
    "Symlink",
    buildZip([{ name: "link.txt", data: "/etc/passwd", unixMode: 0o120777 }]),
    "SYMLINK_ENTRY"
  );
});

test("rejects non-regular entry types", async () => {
  await assertRejected(
    "Fifo",
    buildZip([{ name: "pipe", data: "x", unixMode: 0o010644 }]),
    "UNSUPPORTED_ENTRY_TYPE"
  );
});

test("rejects encrypted entries", async () => {
  await assertRejected(
    "Encrypted",
    buildZip([{ name: "index.html", data: INDEX_HTML, encrypted: true }]),
    "ENCRYPTED_ENTRY"
  );
});

test("rejects duplicate entry paths", async () => {
  await assertRejected(
    "Dup",
    buildZip([
      { name: "dup.txt", data: "first" },
      { name: "dup.txt", data: "second" }
    ]),
    "ENTRY_COLLISION"
  );
});

test("rejects case-aliasing entry paths", async () => {
  await assertRejected(
    "Case",
    buildZip([
      { name: "Readme.txt", data: "A" },
      { name: "readme.txt", data: "B" }
    ]),
    "ENTRY_COLLISION"
  );
});

test("rejects Unicode normalization-aliasing entry paths", async () => {
  await assertRejected(
    "Nfc",
    buildZip([
      { name: "caf\u00e9.txt", data: "NFC" },
      { name: "cafe\u0301.txt", data: "NFD" }
    ]),
    "ENTRY_COLLISION"
  );
});

test("rejects over-deep entry paths", async () => {
  const deep = Array.from({ length: 21 }, (_, i) => `d${i}`).join("/");
  await assertRejected("Deep", filesZip([{ name: `${deep}/file.txt`, data: "x" }]), "DEPTH_LIMIT_EXCEEDED", 413);
});

test("rejects entries over the per-file size limit", async () => {
  await assertRejected(
    "OneBig",
    buildZip([{ name: "big.bin", data: Buffer.alloc(25 * 1024 * 1024), method: "deflate" }]),
    "ENTRY_TOO_LARGE",
    413
  );
});

test("rejects HTML entries over the HTML size limit", async () => {
  await assertRejected(
    "BigHtml",
    buildZip([{ name: "index.html", data: Buffer.alloc(3 * 1024 * 1024), method: "deflate" }]),
    "HTML_TOO_LARGE",
    413
  );
});

test("rejects archives expanding beyond the total extraction limit", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    name: `zeros-${i}.bin`,
    data: Buffer.alloc(9 * 1024 * 1024),
    method: "deflate"
  }));

  await assertRejected("Bomb", buildZip(entries), "EXTRACT_LIMIT_EXCEEDED", 413);
});

test("rejects corrupt archives", async () => {
  const valid = filesZip([{ name: "index.html", data: INDEX_HTML }]);
  await assertRejected("Truncated", valid.subarray(0, valid.length - 10), "INVALID_ZIP");

  await assertRejected("Garbage", Buffer.from("this is not a zip file"), "INVALID_ZIP");
});

test("accepts a legitimate nested project after hostile attempts", async () => {
  const zip = filesZip([
    { name: "index.html", data: INDEX_HTML },
    { name: "css/style.css", data: "body{}" },
    { name: "js/app.js", data: "console.log('ok');" }
  ]);

  const r = await uploadZip("Legit", zip);

  assert.equal(r.status, 201);
  assert.equal(r.json.fileCount, 3);
});
