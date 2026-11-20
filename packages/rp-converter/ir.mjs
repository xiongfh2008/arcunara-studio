// RC18A: conservative static HTML -> editable-widget candidate intermediate
// representation. NOT an Axure .rp compiler. No code execution, browser,
// external fetch, CSS stylesheet resolution, or invented widget geometry.
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../apps/api/lib/httputil.mjs";
import { walkFiles } from "../../apps/api/lib/entrypoint.mjs";
import { businessPages, isAxureFileSet } from "../../apps/api/lib/axure.mjs";
import { isValidSegment } from "../../apps/api/lib/pathsafety.mjs";

export const IR_SCHEMA = "arcunara.editable-ir.v1";
const MAX_PAGES = 50;
const MAX_HTML_BYTES_PER_PAGE = 8 * 1024 * 1024;
const MAX_HTML_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_WIDGETS_PER_PAGE = 350;
const MAX_WIDGETS_TOTAL = 3000;
const MAX_TEXT_CHARS = 512;
const CAPTURE = new Set(["h1", "h2", "h3", "h4", "h5", "h6",
  "p", "label", "button", "a", "textarea", "select"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP_CONTENT = new Set(["script", "style", "noscript", "template", "svg"]);
const ALLOWED_PAGE_EXTENSION = /\.html?$/i;

function decodeHtml(text) {
  const named = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    nbsp: " ", copy: "©", mdash: "—", ndash: "–"};
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key[0] !== "#") return named[key] ?? "&" + entity + ";";
    const n = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff &&
      !(n >= 0xd800 && n <= 0xdfff)
      ? String.fromCodePoint(n) : "\uFFFD";
  }).replace(/\s+/g, " ").trim();
}

function boundedText(value, max = MAX_TEXT_CHARS) {
  return decodeHtml(String(value ?? "").slice(0, max * 4)).slice(0, max);
}

function attributes(source) {
  const out = Object.create(null);
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\u0060]+)))?/g;
  let match;
  let count = 0;
  while ((match = re.exec(source)) && count++ < 48) {
    const key = match[1].toLowerCase();
    if (!/^[a-z_:][\w:.-]{0,63}$/.test(key) || Object.hasOwn(out, key)) continue;
    out[key] = String(match[2] ?? match[3] ?? match[4] ?? "").slice(0, 2048);
  }
  return out;
}

// Lex only a safe subset. Handles '>' inside quoted attributes; raw
// script/style/template and SVG contents are skipped, not parsed/executed.
function scanHtml(html, handlers) {
  const lower = html.toLowerCase();
  let pos = 0;
  while (pos < html.length) {
    const left = html.indexOf("<", pos);
    if (left < 0) {
      handlers.text(html.slice(pos));
      break;
    }
    if (left > pos) handlers.text(html.slice(pos, left));
    if (html.startsWith("<!--", left)) {
      const end = html.indexOf("-->", left + 4);
      pos = end < 0 ? html.length : end + 3;
      continue;
    }
    let j = left + 1;
    let quote = null;
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
    if (j === html.length) break;
    const raw = html.slice(left + 1, j).trim();
    pos = j + 1;
    const close = raw.startsWith("/");
    const body = close ? raw.slice(1).trim() : raw;
    const match = /^([a-zA-Z][\w:-]*)\b/.exec(body);
    if (!match) continue;
    const tag = match[1].toLowerCase();
    if (SKIP_CONTENT.has(tag)) {
      if (!close) {
        const endIndex = lower.indexOf("</" + tag, pos);
        if (endIndex < 0) {
          pos = html.length;
        } else {
          const endTag = html.indexOf(">", endIndex);
          pos = endTag < 0 ? html.length : endTag + 1;
        }
      }
      continue;
    }
    if (close) {
      handlers.end(tag);
      continue;
    }
    const attrs = attributes(body.slice(match[0].length));
    handlers.start(tag, attrs, raw.endsWith("/") || VOID.has(tag));
  }
}

function inlineStyle(text) {
  const decl = Object.create(null);
  for (const fragment of String(text || "").slice(0, 2048).split(";")) {
    const pos = fragment.indexOf(":");
    if (pos < 1) continue;
    const key = fragment.slice(0, pos).trim().toLowerCase();
    const value = fragment.slice(pos + 1).trim();
    if (/^(position|left|top|width|height|color|background-color|font-size|font-weight|border-radius)$/.test(key)) {
      decl[key] = value;
    }
  }
  const px = value => {
    const match = /^(0|[0-9]{1,5}(?:\.[0-9]{1,2})?)px$/i.exec(value ?? "");
    return match && Number(match[1]) <= 20000 ? Number(match[1]) : undefined;
  };
  const geom = {};
  if (["absolute", "fixed"].includes(decl.position)) {
    if (px(decl.left) !== undefined) geom.x = px(decl.left);
    if (px(decl.top) !== undefined) geom.y = px(decl.top);
  }
  if (px(decl.width) !== undefined) geom.width = px(decl.width);
  if (px(decl.height) !== undefined) geom.height = px(decl.height);
  const style = {};
  if (px(decl["font-size"]) !== undefined) style.fontSize = px(decl["font-size"]);
  if (px(decl["border-radius"]) !== undefined) style.borderRadius = px(decl["border-radius"]);
  if (["normal", "bold", "400", "500", "600", "700", "800"].includes(decl["font-weight"])) {
    style.fontWeight = decl["font-weight"];
  }
  for (const prop of ["color", "background-color"]) {
    const v = decl[prop] ?? "";
    if (/^(#[\da-f]{3,8}|[a-z]{3,20}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%]+\))$/i.test(v)) {
      style[prop === "color" ? "color" : "backgroundColor"] = v;
    }
  }
  return { geometry: Object.keys(geom).length ? geom : null, style };
}

function relativeResource(raw, filePath, allowPage, knownFiles) {
  if (!raw || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("\\") ||
      raw.includes("\\") || /^[a-z][\w+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]); }
  catch { return null; }
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), decoded));
  if (normalized.startsWith("../") || normalized === ".." ||
      !normalized.split("/").every(s => isValidSegment(s, {allowDotfiles: false}))) return null;
  if (allowPage && !ALLOWED_PAGE_EXTENSION.test(normalized)) return null;
  return knownFiles.has(normalized) ? normalized : null;
}

function pageWidgets(html, pagePath, knownPages, knownFiles) {
  const nodes = [];
  const warnings = new Set();
  if (/<script\b/i.test(html)) warnings.add("SCRIPT_INTERACTIONS_UNMAPPED");
  if (/\bon(?:click|change|submit|input|mouseover)\s*=/i.test(html)) {
    warnings.add("INLINE_EVENTS_UNMAPPED");
  }
  if (/<(?:link\b[^>]*rel\s*=\s*["']?stylesheet|style\b)/i.test(html)) {
    warnings.add("EXTERNAL_OR_EMBEDDED_CSS_UNRESOLVED");
  }
  if (/<(?:iframe|canvas|video|audio|table|form|svg)\b/i.test(html)) {
    warnings.add("COMPLEX_WIDGETS_REQUIRE_MANUAL_MAPPING");
  }
  if (/@media\b/i.test(html)) warnings.add("RESPONSIVE_RULES_UNMAPPED");
  let active = null;
  let depth = 0;
  let nodeNumber = 0;
  let withGeometry = 0;

  function add(tag, attrs, rawText) {
    const text = boundedText(rawText);
    const source = attrs.src;
    const allowed = tag === "img" || tag === "input" || (CAPTURE.has(tag) && text);
    if (!allowed) return;
    if (tag === "input" && ["hidden", "password", "file"].includes((attrs.type || "").toLowerCase())) {
      warnings.add("SENSITIVE_OR_UNSUPPORTED_INPUT_OMITTED");
      return;
    }
    if (++nodeNumber > MAX_WIDGETS_PER_PAGE) {
      throw new ApiError(413, "Too many editable candidates on one page", "IR_WIDGET_LIMIT");
    }
    const name = "w" + String(nodeNumber).padStart(4, "0");
    const {geometry, style} = inlineStyle(attrs.style);
    if (geometry) withGeometry++;
    let type = "text";
    if (tag === "img") type = "image";
    else if (tag === "button") type = "button";
    else if (tag === "a") type = "link";
    else if (tag === "input") type = ["checkbox", "radio"].includes(attrs.type) ?
      attrs.type : "input";
    else if (["textarea", "select"].includes(tag)) type = "input";
    const node = {
      id: name, type, sourceTag: tag, editableCandidate: true,
      ...(text ? { text } : {}),
      ...(geometry ? { geometry } : {}),
      ...(Object.keys(style).length ? { style } : {})
    };
    if (type === "input") {
      node.input = {
        kind: tag === "input" ? (attrs.type || "text").slice(0, 30) : tag,
        ...(attrs.placeholder ? {placeholder: boundedText(attrs.placeholder)} : {})
      };
    }
    if (type === "image") {
      const asset = relativeResource(source, pagePath, false, knownFiles);
      if (asset) node.assetPath = asset;
      else warnings.add("UNRESOLVED_IMAGE_ASSET");
      if (attrs.alt) node.alt = boundedText(attrs.alt);
    }
    if (type === "link") {
      const target = relativeResource(attrs.href, pagePath, true, knownPages);
      if (target) node.navigation = { kind: "navigate-page", target };
      else warnings.add("LINK_ACTION_UNMAPPED");
    }
    nodes.push(node);
  }

  scanHtml(html, {
    start(tag, attrs, selfClose) {
      if (active) {
        if (!selfClose) depth++;
        return;
      }
      if (tag === "img" || tag === "input") {
        add(tag, attrs, "");
        return;
      }
      if (CAPTURE.has(tag) && !selfClose) {
        active = { tag, attrs, text: "" };
        depth = 1;
      }
    },
    text(value) {
      if (active && active.text.length < MAX_TEXT_CHARS * 4) {
        active.text += value.slice(0, MAX_TEXT_CHARS * 4 - active.text.length);
      }
    },
    end(tag) {
      if (!active) return;
      if (--depth <= 0) {
        add(active.tag, active.attrs, active.text);
        active = null;
        depth = 0;
      }
    }
  });
  if (!nodes.length) warnings.add("NO_STATIC_EDITABLE_CANDIDATES");
  if (withGeometry < nodes.length) warnings.add("LAYOUT_NOT_EXPLICIT_IN_INLINE_CSS");
  return { nodes, warnings: [...warnings].sort(), withGeometry };
}

// Only a fully specified stored version is read. This never changes any
// metadata, calls remote assets or creates an .rp file.
export async function buildEditableIR(store, projectId, requestedVersion) {
  if (requestedVersion !== undefined && requestedVersion !== null &&
      (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)) {
    throw new ApiError(400, "Invalid version", "INVALID_VERSION");
  }
  return store.withLock(projectId, async () => {
    const meta = await store.readRawMeta(projectId);
    if (!meta) throw new ApiError(404, "Not Found", "PROJECT_NOT_FOUND");
    if (meta.lifecycleState === "trashed") {
      throw new ApiError(409, "Project is in trash", "PROJECT_TRASHED");
    }
    const current = await store.currentVersionEntry(projectId, meta);
    const versions = Array.isArray(meta.versions) ? meta.versions : [current];
    const entry = requestedVersion == null ? current :
      versions.find(x => x.version === requestedVersion);
    if (!entry) throw new ApiError(404, "Version not found", "VERSION_NOT_FOUND");
    const dir = store.versionSourceDir(projectId, entry);
    const allFiles = (await walkFiles(dir)).filter(name => !name.split("/").some(x=>x.startsWith(".")));
    if (allFiles.length > 6000) throw new ApiError(413, "Too many files", "IR_FILE_LIMIT");
    const isAxure = isAxureFileSet(allFiles);
    const selected = isAxure ? businessPages(allFiles) :
      allFiles.filter(name=>ALLOWED_PAGE_EXTENSION.test(name) &&
      !/^(resources|data|plugins|chrome)\//i.test(name)).sort();
    if (selected.length > MAX_PAGES) {
      throw new ApiError(413, "Too many HTML pages to map", "IR_PAGE_LIMIT");
    }
    let totalBytes = 0;
    const knownPages = new Set(selected);
    const knownFiles = new Set(allFiles);
    const pages = [];
    let count = 0;
    let withGeometry = 0;
    const warnings = new Set();
    if (isAxure) warnings.add("AXURE_EXPORT_LOSES_ORIGINAL_RP_INTERACTIONS");
    for (let i = 0; i < selected.length; i++) {
      const filename = selected[i];
      const sourcePath = path.join(dir, ...filename.split("/"));
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ApiError(409, "Unsafe HTML file", "IR_UNSAFE_HTML");
      }
      totalBytes += stat.size;
      if (stat.size > MAX_HTML_BYTES_PER_PAGE || totalBytes > MAX_HTML_TOTAL_BYTES) {
        throw new ApiError(413, "HTML scan limit exceeded", "IR_HTML_LIMIT");
      }
      const html = await fs.readFile(sourcePath, "utf8");
      const mapped = pageWidgets(html, filename, knownPages, knownFiles);
      count += mapped.nodes.length;
      if (count > MAX_WIDGETS_TOTAL) {
        throw new ApiError(413, "Too many editable candidates", "IR_WIDGET_LIMIT");
      }
      withGeometry += mapped.withGeometry;
      mapped.warnings.forEach(code=>warnings.add(code));
      const rawTitle = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
      pages.push({
        id: "p" + String(i + 1).padStart(3, "0"),
        sourcePath: filename,
        title: boundedText(rawTitle || path.posix.basename(filename).replace(/\.html?$/i, "")),
        nodes: mapped.nodes,
        warnings: mapped.warnings
      });
    }
    return {
      schema: IR_SCHEMA,
      artifactType: "editable-candidate-intermediate-json",
      projectId, version: entry.version, isAxureHtmlExport: isAxure,
      target: "axure-rp11",
      compiler: {available: false, name: "zee-rp", output: null},
      nativeRpExportReady: false,
      status: "mapping-only",
      summary: {pages: pages.length, editableCandidates: count,
        candidatesWithExplicitGeometry: withGeometry, htmlBytesScanned: totalBytes},
      pages,
      warnings: [...warnings].sort(),
      limitations: [
        "Static candidates only; no compiled .rp is produced.",
        "Only explicit inline pixel dimensions/positions are retained; CSS selectors, flex, grid and responsive layout are not resolved.",
        "JavaScript actions, conditional interactions and plugin-generated widgets are not converted.",
        "Zee-RP compiler integration and Axure RP11 open/edit validation remain outstanding."
      ]
    };
  });
}
