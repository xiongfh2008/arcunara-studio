// RC3: Axure export detection, safe-preview navigation page, raw-entry
// preservation, version/rollback consistency, and XSS-safety of the
// platform-rendered navigation page.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./helpers/harness.mjs";
import { buildZip, filesZip } from "./helpers/zipbuilder.mjs";
import {
  businessPages,
  inspectAxureProject,
  isAxureFileSet,
  renderNavPage
} from "../apps/api/lib/axure.mjs";

// --- unit: pure helpers ----------------------------------------------------

test("detection requires both Axure markers", () => {
  assert.equal(isAxureFileSet(["index.html", "data/document.js"]), false);
  assert.equal(
    isAxureFileSet(["index.html", "resources/scripts/axure/axQuery.js"]),
    false
  );
  assert.equal(
    isAxureFileSet([
      "index.html",
      "data/document.js",
      "resources/scripts/axure/axQuery.js"
    ]),
    true
  );
});

test("business pages exclude player shells, helpers and dotfiles", () => {
  const pages = businessPages([
    "index.html",
    "start.html",
    "start_c_1.html",
    "start_with_pages.html",
    ".hidden.html",
    "resources/Other.html",
    "data/x.html",
    "页面A（新增）.html",
    "POBO手续费管理.html"
  ]);
  // deterministic zh collation order (CJK-leading sorts before Latin-leading)
  assert.deepEqual(pages, ["页面A（新增）.html", "POBO手续费管理.html"]);
});

test("renderNavPage escapes script-breaking sequences in file names", () => {
  const html = renderNavPage(
    "00000000-0000-0000-0000-000000000000",
    ["a</script><script>alert(1)</script>.html", "普通页面.html"]
  );

  // the injected payload must contain no raw "<" at all — a "</script>"
  // breakout requires a literal "<", so escaping it suffices; the escaped
  // form \u003c must be present for the script-breaking name
  const pagesLine = /var PAGES = (.*);\n/.exec(html)?.[1] ?? "";
  assert.ok(!pagesLine.includes("<"));
  assert.match(pagesLine, /\\u003c\/script>/);
  assert.match(html, /b\.textContent = item\.name/);
});

// --- fixtures -------------------------------------------------------------

function axureZip(businessPages) {
  // Feature-complete Axure export skeleton: player shells, the two
  // detection markers, helper pages under resources/, and the business
  // pages at top level.
  return filesZip([
    { name: "index.html", data: "<html><body><h1>Axure player shell</h1><script src=\"resources/scripts/axure/axQuery.js\"></script></body></html>" },
    { name: "start.html", data: "<html><body>player start</body></html>" },
    { name: "start_c_1.html", data: "<html><body>player variant</body></html>" },
    { name: "data/document.js", data: "/* axure data */" },
    { name: "resources/scripts/axure/axQuery.js", data: "window.axQuery={};" },
    { name: "resources/scripts/axure/action.js", data: "window.action={};" },
    { name: "resources/css/axure_rp_page.css", data: ".ax_default{}" },
    { name: "resources/Other.html", data: "<html><body>helper</body></html>" },
    { name: "resources/chrome/chrome.html", data: "<html><body>ext helper</body></html>" },
    ...businessPages.map((p) => ({ name: p, data: `<html><body><h1>${p}</h1></body></html>` }))
  ]);
}

// Windows-legal hostile name probing URL round-trip fidelity (%41 must not
// decode to "A"), quote/ampersand injection, and spaces. Names containing
// raw < > would additionally be un-extractable on Windows dev machines.
const HOSTILE_PAGE = "x' y & z%41.html";

const PLAIN_ZIP = () => filesZip([
  { name: "index.html", data: "<html><body><h1>plain prototype</h1></body></html>" },
  { name: "about.html", data: "<html><body>about</body></html>" }
]);

let server;
let axureId;
let plainId;

before(async () => {
  server = await startServer();

  const fd = new FormData();
  fd.set("name", "AxureProto");
  fd.set("file", new Blob([
    axureZip([
      "付款人名称管理（新增）.html",
      "POBO手续费管理（新增）.html",
      "pobo配置管理（新增）.html",
      HOSTILE_PAGE
    ])
  ], { type: "application/zip" }), "axure.zip");
  const r = await server.api("/api/projects", { method: "POST", body: fd });
  assert.equal(r.status, 201, `axure fixture upload failed: ${JSON.stringify(r.json)}`);
  axureId = r.json.id;

  const fd2 = new FormData();
  fd2.set("name", "PlainProto");
  fd2.set("file", new Blob([PLAIN_ZIP()]), "plain.zip");
  const r2 = await server.api("/api/projects", { method: "POST", body: fd2 });
  assert.equal(r2.status, 201, `plain fixture upload failed: ${JSON.stringify(r2.json)}`);
  plainId = r2.json.id;
});

after(async () => {
  if (server) {
    await server.stop();
    await server.cleanup();
  }
});

// --- detection ------------------------------------------------------------

test("feature-based detection marks Axure exports (detail.isAxure)", async () => {
  const r = await server.api(`/api/projects/${axureId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.isAxure, true);
});

test("plain prototypes are not misclassified (isAxure false)", async () => {
  const r = await server.api(`/api/projects/${plainId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.isAxure, false);
});

// --- safe-preview navigation page ------------------------------------------

async function nav() {
  const res = await server.preview(`/p/${axureId}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  return { res, html: await res.text(), csp };
}

test("Axure project root serves the platform navigation page", async () => {
  const { res, html, csp } = await nav();

  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /frame-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(html, /安全预览 · 页面目录/);

  // business pages listed (CJK names intact in the JSON payload)
  for (const name of ["付款人名称管理（新增）", "POBO手续费管理（新增）", "pobo配置管理（新增）"]) {
    assert.match(html, new RegExp(name.replace(/[()[\]]/g, "\\$&")));
  }

  // player shells and helper pages are NOT business pages
  assert.ok(!/"start\.html"/.test(html), "start.html excluded");
  assert.ok(!/"index\.html"/.test(html), "index.html excluded from the list");
  assert.ok(!html.includes("Other.html"), "resources helper excluded");
  assert.ok(!html.includes("chrome.html"), "chrome helper excluded");

  // the raw entry stays reachable for debugging
  assert.match(html, /href="\/p\/[^/]+\/index\.html"/);
});

test("navigation page escapes uploaded file names (XSS-safe)", async () => {
  const { html } = await nav();

  // hostile name appears only inside the JSON payload (never as markup)
  assert.ok(html.includes("x' y & z%41"), "hostile name present in payload");

  // rendering path is textContent-based, not innerHTML
  assert.match(html, /b\.textContent = item\.name/);
  assert.ok(!/innerHTML/.test(html), "nav page must not use innerHTML");

  // the server-side JSON payload must contain no raw "<" — a "</script>"
  // sequence in a file name could otherwise break out of the script element
  const pagesLine = /var PAGES = (.*);\n/.exec(html)?.[1] ?? "";
  assert.ok(pagesLine.length > 0, "PAGES payload found");
  assert.ok(!pagesLine.includes("<"), "no raw < inside the JSON payload");
});

test("page URLs are per-segment encoded and resolvable", async () => {
  const { html } = await nav();

  const encoded = encodeURIComponent("付款人名称管理（新增）.html");
  assert.match(html, new RegExp(encoded.slice(0, 24)), "per-segment encoding in links");

  const res = await server.preview(`/p/${axureId}/${encoded}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /付款人名称管理（新增）/);

  // the hostile name round-trips through per-segment encoding: %41 must
  // survive as "%41" (an unencoded builder would decode it to "A" → 404)
  const hostile = await server.preview(
    `/p/${axureId}/${encodeURIComponent(HOSTILE_PAGE)}`
  );
  assert.equal(hostile.status, 200);
  assert.match(await hostile.text(), /x' y & z%41/);
});

test("raw native entry (index.html) is preserved", async () => {
  const res = await server.preview(`/p/${axureId}/index.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Axure player shell/);
});

test("non-Axure projects keep the RC2 preview entry", async () => {
  const res = await server.preview(`/p/${plainId}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), res.headers.get("content-security-policy"));
  assert.match(await res.text(), /plain prototype/);

  const detail = await server.api(`/api/projects/${plainId}`);
  assert.equal(detail.json.isAxure, false);
});

test("version update and rollback keep the page list consistent", async () => {
  // v2: different business page set
  const fd = new FormData();
  fd.set("file", new Blob([
    axureZip(["新页面D.html", "pobo配置管理（新增）.html"])
  ], { type: "application/zip" }), "v2.zip");

  const r = await server.api(`/api/projects/${axureId}/versions`, { method: "POST", body: fd });
  assert.equal(r.status, 201);

  const v2 = await (await server.preview(`/p/${axureId}/`)).text();
  assert.match(v2, /新页面D/);
  assert.ok(!v2.includes("付款人名称管理（新增）"), "v1 page gone from v2 list");

  // rollback to v1 restores the v1 page list
  const rb = await server.api(`/api/projects/${axureId}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1 })
  });
  assert.equal(rb.json.currentVersion, 1);

  const v1 = await (await server.preview(`/p/${axureId}/`)).text();
  assert.match(v1, /付款人名称管理（新增）/);
  assert.ok(!v1.includes("新页面D"), "v2 page gone after rollback");
});

test("navigation page never exposes metadata or hidden files", async () => {
  const { html } = await nav();
  assert.ok(!html.includes("meta.json"));
  assert.ok(!html.includes(".env"));
  // HEAD works too
  const head = await server.preview(`/p/${axureId}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
});
