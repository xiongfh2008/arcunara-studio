// RC11: read-only Axure RP11 conversion-readiness report.
//
// This analyzer NEVER executes any uploaded HTML/JS, never guesses proprietary
// .rp structures, and never claims native export support. It inventories
// ordinary HTML elements and flags common dynamic features which require
// extra mapping into a native Axure compiler (e.g. local Zee-RP).
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./httputil.mjs";
import { walkFiles } from "./entrypoint.mjs";
import { businessPages, isAxureFileSet } from "./axure.mjs";

const MAX_PAGES = 100;
const MAX_HTML_SCAN_BYTES = 8 * 1024 * 1024;
const IGNORE_PREFIXES = ["resources/","data/","plugins/","chrome/"];
const ELEMENTS = {
  headings: /<h[1-6]\b/gi,
  text: /<(?:p|span|label|strong|em)\b/gi,
  images: /<img\b/gi,
  buttons: /<button\b/gi,
  inputs: /<input\b/gi,
  selects: /<select\b/gi,
  textareas: /<textarea\b/gi,
  links: /<a\b/gi,
  tables: /<table\b/gi,
  forms: /<form\b/gi,
  iframes: /<iframe\b/gi
};
const RISK_RULES = [
  ["INLINE_EVENTS", /\bon(?:click|change|submit|input|mouseover)\s*=/i,
    "发现 HTML 内联交互，需要映射到 Axure 原生事件"],
  ["SCRIPT_DEPENDENCY", /<script\b/i,
    "发现脚本依赖；脚本不能直接转换为 Axure 原生交互"],
  ["DYNAMIC_FRAME", /<iframe\b/i,
    "发现嵌入框架；需要改写为原生页面或说明不支持"],
  ["STORAGE_API", /\b(?:localStorage|sessionStorage|indexedDB)\b/i,
    "发现浏览器本地存储依赖，不能直接原生映射"],
  ["NETWORK_API", /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket)\b/i,
    "发现网络数据依赖，需独立处理接口和数据绑定"]
];

function count(text, re) {
  // Avoid allocating a potentially gigantic matches array for hostile HTML.
  let result = 0;
  for (const match of text.matchAll(re)) {
    result++;
    if (result >= 100000) break;
  }
  return result;
}

export async function analyzeAxureReadiness(store, projectId, requestedVersion) {
  const meta = await store.readRawMeta(projectId);
  if (!meta) throw new ApiError(404,"Not Found","PROJECT_NOT_FOUND");
  if (meta.lifecycleState === "trashed") {
    throw new ApiError(409,"Project is in trash","PROJECT_TRASHED");
  }
  const current = await store.currentVersionEntry(projectId,meta);
  let entry = current;
  if (requestedVersion !== undefined && requestedVersion !== null) {
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) {
      throw new ApiError(400,"Invalid version","INVALID_VERSION");
    }
    const versions = Array.isArray(meta.versions) ? meta.versions : [current];
    entry = versions.find(x=>x.version === requestedVersion);
    if (!entry) throw new ApiError(404,"Version not found","VERSION_NOT_FOUND");
  }
  const dir = store.versionSourceDir(projectId,entry);
  const files = await walkFiles(dir);
  const isAxureExport = isAxureFileSet(files);
  const htmlFiles = isAxureExport
    ? businessPages(files)
    : files.filter(f => /\.html?$/i.test(f) &&
        !IGNORE_PREFIXES.some(prefix=>f.startsWith(prefix)) &&
        !f.split("/").some(segment=>segment.startsWith(".")));
  const totals = Object.fromEntries(Object.keys(ELEMENTS).map(k=>[k,0]));
  const risks = new Map();
  const pages = [];
  for (const name of htmlFiles.slice(0,MAX_PAGES)) {
    const filename = path.join(dir,...name.split("/"));
    const stats = await fs.stat(filename);
    if (stats.size > MAX_HTML_SCAN_BYTES) {
      risks.set("OVERSIZED_HTML","部分 HTML 文件超过分析上限，已跳过");
      continue;
    }
    const html = await fs.readFile(filename,"utf8");
    const elements = Object.fromEntries(
      Object.entries(ELEMENTS).map(([key,re])=>[key,count(html,re)])
    );
    for (const [key,n] of Object.entries(elements)) totals[key] += n;
    for (const [code,re,message] of RISK_RULES) {
      if (re.test(html)) risks.set(code,message);
    }
    pages.push({path:name,bytes:stats.size,elements});
  }
  if (htmlFiles.length > MAX_PAGES) {
    risks.set("PAGE_LIMIT","页面数量超过一次性分析上限，仅分析前100页");
  }
  if (isAxureExport) {
    risks.set("AXURE_HTML_EXPORT",
      "这是 Axure HTML 导出物，不包含原始 .rp 的全部组件、条件动作和源对象信息");
  }
  return {
    projectId,
    version:entry.version,
    analyzer:"arcunara-rc11-readiness",
    isAxureHtmlExport:isAxureExport,
    totalHtmlPages:htmlFiles.length,
    analyzedPages:pages.length,
    elements:totals,
    pages,
    risks:[...risks].map(([code,message])=>({code,message})),
    nativeRpExportReady:false,
    status:"analysis-only",
    conclusion:"已完成静态转换评估；本结果不是 .rp 文件。原生 RP11 导出需要接入 Zee-RP 编译器并通过 Axure RP11 宿主验收。"
  };
}
