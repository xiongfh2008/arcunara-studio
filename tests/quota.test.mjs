// RC2 quota regression tests — sized against a real Axure RP11 export
// (2,786 entries, 4.58 MiB max HTML, 72.6 MiB uncompressed). Production
// defaults must keep rejecting oversized archives; the test-env quotas
// (ARCU_MAX_FILES=5000, ARCU_MAX_HTML_BYTES=8MiB, ARCU_MAX_EXTRACT_BYTES=
// 128MiB) must accept them. Fixtures are generated in-memory; the real
// POBO ZIP never enters the repository.

import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { buildZip, filesZip } from "./helpers/zipbuilder.mjs";

const MIB = 1024 * 1024;
const SAMPLE_ENTRIES = 2786; // real POBO export entry count

const INDEX_HTML = "<html><body><h1>rc2</h1></body></html>";

function entriesZip(count) {
  // `count` total entries INCLUDING a root index.html so a fully-extracted
  // archive can pass entry detection (the real Axure export has exactly one
  // index.html inside its single wrapper directory).
  const entries = [{ name: "index.html", data: INDEX_HTML }];
  for (let i = 0; i < count - 1; i++) {
    entries.push({
      name: `dir${Math.floor(i / 500)}/file-${i}.txt`,
      data: "x"
    });
  }
  return buildZip(entries);
}

let server;

before(async () => {
  server = await startServer(); // production defaults: maxFiles 2000, maxHtml 2MiB, extract 80MiB
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

async function uploadZipTo(target, name, zip) {
  const fd = new FormData();
  fd.set("name", name);
  fd.set("file", new Blob([zip]), "upload.zip");
  return target.api("/api/projects", { method: "POST", body: fd });
}

async function projectCount(target) {
  const r = await target.api("/api/projects");
  return r.json.projects.length;
}

test("a 2,786-entry archive is rejected at the default 2,000-entry quota", async () => {
  const before = await projectCount(server);

  const r = await uploadZipTo(server, "TooMany", entriesZip(SAMPLE_ENTRIES));

  assert.equal(r.status, 413);
  assert.equal(r.json.code, "TOO_MANY_FILES");

  // failure leaves no residue and does not touch existing projects
  const tmp = await fs.readdir(path.join(server.dataDir, ".tmp"));
  assert.deepEqual(tmp, []);
  assert.equal(await projectCount(server), before);
});

test("the same archive is accepted under the 5,000-entry test quota", async () => {
  const custom = await startServer({
    ARCU_MAX_FILES: "5000",
    ARCU_MAX_FILE_BYTES: "20971520",
    ARCU_MAX_HTML_BYTES: "8388608",
    ARCU_MAX_EXTRACT_BYTES: "134217728"
  });

  try {
    const r = await uploadZipTo(custom, "AxureSize", entriesZip(SAMPLE_ENTRIES));

    assert.equal(r.status, 201);
    assert.equal(r.json.fileCount, SAMPLE_ENTRIES);
    assert.equal(r.json.entryPoint, "index.html");

    const pv = await custom.preview(`/p/${r.json.id}/`);
    assert.equal(pv.status, 200);
    assert.match(await pv.text(), /rc2/);
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("HTML over 2 MiB and under 8 MiB is handled with the raised quota", async () => {
  const bigHtml = `<html>${"x".repeat(3 * MIB)}`; // 3 MiB — rejected by defaults, fine at 8 MiB

  const rejected = await uploadZipTo(server, "BigHtmlDefault", buildZip([
    { name: "index.html", data: Buffer.from(bigHtml, "utf8"), method: "deflate" }
  ]));
  assert.equal(rejected.status, 413);
  assert.equal(rejected.json.code, "HTML_TOO_LARGE");

  const custom = await startServer({
    ARCU_MAX_FILES: "5000",
    ARCU_MAX_FILE_BYTES: "20971520",
    ARCU_MAX_HTML_BYTES: "8388608",
    ARCU_MAX_EXTRACT_BYTES: "134217728"
  });

  try {
    const r = await uploadZipTo(custom, "BigHtmlOk", buildZip([
      { name: "index.html", data: Buffer.from(bigHtml, "utf8"), method: "deflate" }
    ]));

    assert.equal(r.status, 201);
    assert.equal(r.json.totalSize, Buffer.byteLength(bigHtml));
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("the 128 MiB extraction quota is strictly enforced", async () => {
  const custom = await startServer({
    ARCU_MAX_FILES: "5000",
    ARCU_MAX_FILE_BYTES: "20971520",
    ARCU_MAX_HTML_BYTES: "8388608",
    ARCU_MAX_EXTRACT_BYTES: "134217728"
  });

  try {
    const before = await projectCount(custom);

    // 15 × 9 MiB declared = 135 MiB > 128 MiB — the declared-size precheck
    // fires before any decompression work for the offending entry.
    const over = buildZip(
      Array.from({ length: 15 }, (_, i) => ({
        name: `bin-${i}.bin`,
        data: Buffer.alloc(9 * MIB),
        method: "deflate"
      }))
    );

    const r = await uploadZipTo(custom, "Over128", over);
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "EXTRACT_LIMIT_EXCEEDED");

    const tmp = await fs.readdir(path.join(custom.dataDir, ".tmp"));
    assert.deepEqual(tmp, [], "failed upload leaves no staging leftovers");
    assert.equal(await projectCount(custom), before, "no project created");

    // 13 × 9 MiB = 117 MiB stays under the quota (every entry also stays
    // under the unchanged 20 MiB per-file cap) and really streams to disk.
    const fits = buildZip([
      { name: "index.html", data: INDEX_HTML },
      ...Array.from({ length: 13 }, (_, i) => ({
        name: `bin-${i}.bin`,
        data: Buffer.alloc(9 * MIB),
        method: "deflate"
      }))
    ]);

    const ok = await uploadZipTo(custom, "Under128", fits);
    assert.equal(ok.status, 201);
    assert.equal(ok.json.fileCount, 14);
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("/api/limits reports the active quotas (auth required)", async () => {
  const denied = await server.api("/api/limits", { token: null });
  assert.equal(denied.status, 401);

  const r = await server.api("/api/limits");
  assert.equal(r.status, 200);
  assert.equal(r.json.limits.maxFiles, 2000);
  assert.equal(r.json.limits.maxHtmlBytes, 2 * MIB);
  assert.equal(r.json.limits.maxExtractBytes, 80 * MIB);

  const custom = await startServer({
    ARCU_MAX_FILES: "5000",
    ARCU_MAX_FILE_BYTES: "20971520",
    ARCU_MAX_HTML_BYTES: "8388608",
    ARCU_MAX_EXTRACT_BYTES: "134217728"
  });

  try {
    const rc2 = await custom.api("/api/limits");
    assert.equal(rc2.json.limits.maxFiles, 5000);
    assert.equal(rc2.json.limits.maxHtmlBytes, 8 * MIB);
    assert.equal(rc2.json.limits.maxExtractBytes, 128 * MIB);
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});

test("zip security rules stay enforced under raised quotas", async () => {
  const custom = await startServer({
    ARCU_MAX_FILES: "5000",
    ARCU_MAX_FILE_BYTES: "20971520",
    ARCU_MAX_HTML_BYTES: "8388608",
    ARCU_MAX_EXTRACT_BYTES: "134217728"
  });

  try {
    const upload = (name, zip) => uploadZipTo(custom, name, zip);

    const traversal = filesZip([{ name: "../evil.txt", data: "x" }]);
    let r = await upload("StillEvil1", traversal);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "UNSAFE_ENTRY_PATH");

    const symlink = buildZip([{ name: "link.txt", data: "x", unixMode: 0o120777 }]);
    r = await upload("StillEvil2", symlink);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "SYMLINK_ENTRY");

    const colliding = buildZip([
      { name: "Dup.txt", data: "a" },
      { name: "dup.txt", data: "b" }
    ]);
    r = await upload("StillEvil3", colliding);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "ENTRY_COLLISION");

    const big = buildZip([{ name: "big.bin", data: Buffer.alloc(25 * MIB), method: "deflate" }]);
    r = await upload("StillEvil4", big);
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "ENTRY_TOO_LARGE");
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});
