// Upload engine tests: multipart HTML and ZIP project creation, entry
// detection, and live quota enforcement (incl. env-tunable limits).

import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { filesZip, buildZip } from "./helpers/zipbuilder.mjs";

const MIB = 1024 * 1024;

const INDEX_HTML =
  "<!DOCTYPE html><html><head><link rel=\"stylesheet\" href=\"css/style.css\"></head><body><h1>Home</h1><script src=\"js/app.js\"></script></body></html>";

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

function uploadBody({ name, description, filename, content }) {
  const fd = new FormData();

  if (name !== undefined) {
    fd.set("name", name);
  }
  if (description !== undefined) {
    fd.set("description", description);
  }
  fd.set("file", new Blob([content]), filename);

  return fd;
}

async function upload(options) {
  return server.api("/api/projects", {
    method: "POST",
    body: uploadBody(options)
  });
}

test("creates a project from a multipart HTML file", async () => {
  const r = await upload({
    name: "Single",
    filename: "page.html",
    content: INDEX_HTML
  });

  assert.equal(r.status, 201);
  assert.equal(r.json.name, "Single");
  assert.equal(r.json.entryPoint, "index.html");
  assert.equal(r.json.fileCount, 1);
  assert.equal(r.json.currentVersion, 1);
  assert.equal(r.json.totalSize, Buffer.byteLength(INDEX_HTML));
  assert.equal(r.json.previewPath, `/p/${r.json.id}/`);

  const stored = await fs.readFile(
    path.join(server.dataDir, r.json.id, "index.html"),
    "utf8"
  );
  assert.equal(stored, INDEX_HTML);
});

test("creates a multi-file project from a ZIP", async () => {
  const zip = filesZip([
    { name: "index.html", data: INDEX_HTML },
    { name: "css/style.css", data: "body { color: #222; }" },
    { name: "js/app.js", data: "console.log('ok');" },
    { name: "images/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: "fonts/example.woff2", data: Buffer.from([0x77, 0x4f, 0x46, 0x32]) },
    { name: "page1.html", data: "<html><body>Page 1</body></html>" }
  ]);

  const r = await upload({ name: "Multi", filename: "prototype.zip", content: zip });

  assert.equal(r.status, 201);
  assert.equal(r.json.entryPoint, "index.html");
  assert.equal(r.json.fileCount, 6);

  const dir = path.join(server.dataDir, r.json.id);
  assert.equal(await fs.readFile(path.join(dir, "css", "style.css"), "utf8"), "body { color: #222; }");
  assert.equal(await fs.readFile(path.join(dir, "js", "app.js"), "utf8"), "console.log('ok');");
  assert.ok((await fs.stat(path.join(dir, "images", "logo.png"))).isFile());
  assert.ok((await fs.stat(path.join(dir, "fonts", "example.woff2"))).isFile());
  assert.equal(await fs.readFile(path.join(dir, "page1.html"), "utf8"), "<html><body>Page 1</body></html>");
});

test("stores the optional description field", async () => {
  const r = await upload({
    name: "Described",
    description: "  A demo prototype  ",
    filename: "page.html",
    content: INDEX_HTML
  });

  assert.equal(r.status, 201);
  assert.equal(r.json.description, "A demo prototype");

  const detail = await server.api(`/api/projects/${r.json.id}`);
  assert.equal(detail.json.description, "A demo prototype");
});

test("re-roots a single wrapper directory containing index.html", async () => {
  const zip = filesZip([
    { name: "prototype/index.html", data: INDEX_HTML },
    { name: "prototype/css/style.css", data: "body{}" },
    { name: "prototype/page1.html", data: "<html><body>p1</body></html>" }
  ]);

  const r = await upload({ name: "Wrapped", filename: "wrapped.zip", content: zip });

  assert.equal(r.status, 201);
  assert.equal(r.json.entryPoint, "index.html");

  const dir = path.join(server.dataDir, r.json.id);
  assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), INDEX_HTML);
  assert.equal(await fs.readFile(path.join(dir, "css", "style.css"), "utf8"), "body{}");
  await assert.rejects(fs.stat(path.join(dir, "prototype")));
});

test("uses a single HTML file as the entry when there is no index.html", async () => {
  const zip = filesZip([
    { name: "docs/page.html", data: INDEX_HTML },
    { name: "assets/data.json", data: "{}" }
  ]);

  const r = await upload({ name: "SingleHtml", filename: "x.zip", content: zip });

  assert.equal(r.status, 201);
  assert.equal(r.json.entryPoint, "docs/page.html");
});

test("rejects a ZIP with multiple ambiguous HTML entries", async () => {
  const zip = filesZip([
    { name: "a.html", data: INDEX_HTML },
    { name: "b.html", data: INDEX_HTML },
    { name: "assets/data.json", data: "{}" }
  ]);

  const r = await upload({ name: "Ambiguous", filename: "x.zip", content: zip });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "ENTRY_NOT_DETERMINED");
});

test("rejects a ZIP without any HTML file", async () => {
  const zip = filesZip([
    { name: "css/style.css", data: "body{}" },
    { name: "data.json", data: "{}" }
  ]);

  const r = await upload({ name: "NoHtml", filename: "x.zip", content: zip });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "NO_HTML_ENTRY");
});

test("rejects an empty ZIP", async () => {
  const r = await upload({ name: "Empty", filename: "empty.zip", content: filesZip([]) });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "EMPTY_ARCHIVE");
});

test("rejects missing name with 400", async () => {
  const r = await upload({
    name: undefined,
    filename: "page.html",
    content: INDEX_HTML
  });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "NAME_REQUIRED");
});

test("rejects an over-long name with 400", async () => {
  const r = await upload({
    name: "x".repeat(101),
    filename: "page.html",
    content: INDEX_HTML
  });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "NAME_TOO_LONG");
});

test("rejects unsupported file extensions", async () => {
  const r = await upload({ name: "Text", filename: "notes.txt", content: "hello" });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "UNSUPPORTED_FILE_TYPE");
});

test("rejects uploads without a file field", async () => {
  const fd = new FormData();
  fd.set("name", "NoFile");

  const r = await server.api("/api/projects", { method: "POST", body: fd });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "FILE_REQUIRED");
});

test("rejects multiple files in one request", async () => {
  const fd = new FormData();
  fd.set("name", "Two");
  fd.append("file", new Blob(["<html>1</html>"]), "a.html");
  fd.append("file", new Blob(["<html>2</html>"]), "b.html");

  const r = await server.api("/api/projects", { method: "POST", body: fd });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "MULTIPLE_FILES");
});

test("rejects an HTML file without an <html tag", async () => {
  const r = await upload({
    name: "NotHtml",
    filename: "page.html",
    content: "<body>no html tag</body>"
  });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_HTML_FILE");
});

test("rejects an empty uploaded file", async () => {
  const r = await upload({ name: "EmptyFile", filename: "page.html", content: "" });

  assert.equal(r.status, 400);
  assert.equal(r.json.code, "EMPTY_FILE");
});

test("rejects HTML files over the 2 MiB limit with 413", async () => {
  const big = `<html>${"x".repeat(2 * MIB + 1024)}`;
  const r = await upload({ name: "BigHtml", filename: "page.html", content: big });

  assert.equal(r.status, 413);
  assert.equal(r.json.code, "HTML_TOO_LARGE");
});

test("rejects ZIP archives over the 20 MiB limit with 413", async () => {
  const zip = buildZip([
    { name: "zeros.bin", data: Buffer.alloc(21 * MIB), method: "store" }
  ]);

  const r = await upload({ name: "BigZip", filename: "big.zip", content: zip });

  assert.equal(r.status, 413);
  assert.equal(r.json.code, "ZIP_TOO_LARGE");
});

test("failed uploads leave no staging leftovers and no projects", async () => {
  const zip = filesZip([{ name: "../evil.txt", data: "x" }]);
  await upload({ name: "Evil", filename: "evil.zip", content: zip });

  const tmpEntries = await fs.readdir(path.join(server.dataDir, ".tmp"));
  assert.deepEqual(tmpEntries, []);

  const list = await server.api("/api/projects");
  assert.ok(!list.json.projects.some((p) => p.name === "Evil"));
});

// --- env-tunable limits ---

test("upload limits are configurable via environment variables", async () => {
  const custom = await startServer({
    ARCU_MAX_UPLOAD_BODY_BYTES: String(2 * MIB),
    ARCU_MAX_ZIP_BYTES: String(16 * MIB),
    ARCU_MAX_FILE_BYTES: String(4 * MIB),
    ARCU_MAX_HTML_BYTES: String(1 * MIB),
    ARCU_MAX_EXTRACT_BYTES: String(1 * MIB),
    ARCU_MAX_FILES: "5",
    ARCU_MAX_DEPTH: "3"
  });

  try {
    const upload2 = (options) =>
      custom.api("/api/projects", { method: "POST", body: uploadBody(options) });

    // Body cap (2 MiB) is hit before the per-file ZIP cap (16 MiB).
    const bodyTooLarge = buildZip([
      { name: "zeros.bin", data: Buffer.alloc(3 * MIB), method: "store" }
    ]);
    let r = await upload2({ name: "Body", filename: "x.zip", content: bodyTooLarge });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "UPLOAD_TOO_LARGE");

    // File-count cap.
    r = await upload2({
      name: "Many",
      filename: "x.zip",
      content: filesZip([
        { name: "f1.txt", data: "1" },
        { name: "f2.txt", data: "2" },
        { name: "f3.txt", data: "3" },
        { name: "f4.txt", data: "4" },
        { name: "f5.txt", data: "5" },
        { name: "f6.txt", data: "6" }
      ])
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "TOO_MANY_FILES");

    // Depth cap (segments > 3).
    r = await upload2({
      name: "Deep",
      filename: "x.zip",
      content: filesZip([{ name: "a/b/c/d/file.txt", data: "x" }])
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "DEPTH_LIMIT_EXCEEDED");

    // HTML size cap inside archives.
    r = await upload2({
      name: "BigInner",
      filename: "x.zip",
      content: buildZip([
        { name: "index.html", data: Buffer.alloc(1.5 * MIB), method: "deflate" }
      ])
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "HTML_TOO_LARGE");

    // Total extraction cap (declared sizes checked while processing).
    r = await upload2({
      name: "Expand",
      filename: "x.zip",
      content: buildZip([
        { name: "a.bin", data: Buffer.alloc(600 * 1024), method: "store" },
        { name: "b.bin", data: Buffer.alloc(600 * 1024), method: "store" }
      ])
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "EXTRACT_LIMIT_EXCEEDED");

    // A legitimate small ZIP still succeeds under the tightened limits.
    r = await upload2({
      name: "Small",
      filename: "x.zip",
      content: filesZip([{ name: "index.html", data: INDEX_HTML }])
    });
    assert.equal(r.status, 201);
  } finally {
    await custom.stop();
    await custom.cleanup();
  }
});
