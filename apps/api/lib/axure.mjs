// Axure RP HTML export detection and safe-preview navigation.
//
// Detection is FEATURE-based, not "has an index.html": an archive must
// contain BOTH `data/document.js` and at least one script under
// `resources/scripts/axure/` — markers Axure always emits and plain
// prototypes do not. A plain project that merely ships an index.html is
// never misclassified.
//
// The business-page list is computed from the CURRENT version directory at
// request time, so version updates and rollbacks always stay in sync and
// there is no stored list to migrate. Uploaded scripts are never executed
// to build it — only directory listings and file names are read, and the
// original files/directories are left untouched.
//
// Business pages = top-level *.html files excluding the fixed set of Axure
// player shells (index/start variants) and dotfiles. Helper pages inside
// resources/, chrome/, plugins/, data/ etc. are nested and therefore
// excluded by the top-level rule automatically.
//
// The safe-preview navigation page is rendered SERVER-SIDE from that list.
// All page names reach the DOM via JSON + textContent (XSS-safe); all URLs
// are built by per-path-segment encodeURIComponent — string concatenation
// of raw names can never bypass the preview path validation.

import fs from "node:fs/promises";
import { walkFiles } from "./entrypoint.mjs";

const AXURE_PLAYER_PAGES = new Set([
  "index.html",
  "start.html",
  "start_c_1.html",
  "start_c_2.html",
  "start_with_pages.html",
  "start_without_pages.html"
]);

export function isAxureFileSet(files) {
  return (
    files.includes("data/document.js") &&
    files.some(
      (f) => f.startsWith("resources/scripts/axure/") && f.endsWith(".js")
    )
  );
}

// Top-level business pages of an (already re-rooted) Axure version.
export function businessPages(files) {
  const collator = new Intl.Collator(["zh", "en"], { numeric: true });
  return files
    .filter(
      (f) =>
        !f.includes("/") &&
        /\.html?$/i.test(f) &&
        !AXURE_PLAYER_PAGES.has(f.toLowerCase()) &&
        !f.startsWith(".")
    )
    .sort(collator.compare);
}

// Walks the version directory once; returns detection result and pages.
// Also works for non-Axure projects (isAxure: false, pages: []).
export async function inspectAxureProject(versionDir) {
  const files = await walkFiles(versionDir);
  const isAxure = isAxureFileSet(files);
  return { isAxure, pages: isAxure ? businessPages(files) : [] };
}

function encodePreviewPath(id, page) {
  // Per-segment encoding only — never raw concatenation of file names.
  return `/p/${id}/${page.split("/").map(encodeURIComponent).join("/")}`;
}

// Server-rendered navigation page: directory sidebar + sandboxed preview
// iframe. Rendered names go through JSON + textContent; no user HTML is
// ever injected into this platform page.
export function renderNavPage(id, pages) {
  const items = pages.map((page) => ({
    name: page.replace(/\.html?$/i, ""),
    href: encodePreviewPath(id, page)
  }));

  // JSON-embed for the client script; escape "<" so "</script>" in a file
  // name cannot break out of the script element.
  const payload = JSON.stringify(items).replace(/</g, "\\u003c");
  const first = items.length > 0 ? items[0].href : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安全预览 · 页面目录</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --border:#2a2f3a; --text:#e6e9ef; --muted:#8b93a3; --accent:#5b8cff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 "Segoe UI", system-ui, sans-serif; display:flex; flex-direction:column; height:100vh; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--border); }
  header h1 { font-size:14px; margin:0; font-weight:600; }
  header .tag { font-size:11px; color:var(--muted); border:1px solid var(--border); border-radius:999px; padding:1px 8px; }
  header .spacer { flex:1; }
  header a, header button { color:var(--accent); text-decoration:none; font-size:12px; background:none; border:none; cursor:pointer; font-family:inherit; padding:4px 6px; }
  header a:hover, header button:hover { text-decoration:underline; }
  main { flex:1; display:flex; min-height:0; }
  nav { width:260px; overflow:auto; border-right:1px solid var(--border); background:var(--panel); padding:8px; }
  nav .item { display:block; width:100%; text-align:left; padding:8px 10px; margin-bottom:4px; border-radius:8px; border:1px solid transparent; background:none; color:var(--text); cursor:pointer; font-family:inherit; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  nav .item:hover { background:var(--panel); border-color:var(--border); }
  nav .item.active { background:var(--panel); border-color:var(--accent); }
  .stage { flex:1; display:flex; flex-direction:column; min-width:0; }
  .stagebar { padding:6px 12px; font-size:12px; color:var(--muted); border-bottom:1px solid var(--border); background:var(--panel); display:flex; gap:10px; align-items:center; }
  .stagebar a { color:var(--accent); }
  iframe { flex:1; border:0; background:#fff; }
</style>
</head>
<body>
<header>
  <h1>安全预览 · 页面目录</h1>
  <span class="tag" id="count"></span>
  <span class="spacer"></span>
  <a id="openStandalone" href="#" target="_blank" rel="noopener noreferrer">独立页面</a>
  <a id="rawEntry" href="/p/${id}/index.html">原始入口（index.html，调试用）</a>
</header>
<main>
  <nav id="list"></nav>
  <div class="stage">
    <div class="stagebar">
      <span id="current"></span>
      <span>· 页面内容为上传原型，运行于隔离沙箱</span>
    </div>
    <iframe id="view" title="页面预览" src="${first}"></iframe>
  </div>
</main>
<script>
  // Server-injected page list: JSON with "<" escaped; rendered via
  // textContent only — uploaded file names can never inject markup.
  var PAGES = ${payload};
  var list = document.getElementById("list");
  var view = document.getElementById("view");
  var current = document.getElementById("current");
  document.getElementById("count").textContent = PAGES.length + " 个业务页面";

  function select(index) {
    var item = PAGES[index];
    if (!item) return;
    view.src = item.href;
    current.textContent = item.name;
    document.getElementById("openStandalone").href = item.href;
    var buttons = list.querySelectorAll(".item");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].className = i === index ? "item active" : "item";
    }
    if (location.hash !== "#" + item.href) {
      history.replaceState(null, "", "#" + item.href);
    }
  }

  PAGES.forEach(function (item, index) {
    var b = document.createElement("button");
    b.className = "item";
    b.type = "button";
    b.textContent = item.name; // safe text node — no markup parsing
    b.addEventListener("click", function () { select(index); });
    list.appendChild(b);
  });

  // Deep link: /p/{id}/#<encoded href>
  var hash = decodeURIComponent((location.hash || "").slice(1));
  var start = PAGES.findIndex(function (p) { return p.href === hash; });
  select(start >= 0 ? start : 0);
</script>
</body>
</html>
`;
}
