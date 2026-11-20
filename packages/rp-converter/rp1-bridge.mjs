// RC18B: Arcunara editable-candidate IR -> Zee-RP's published RP/1 JSON AST.
// This is an OFFLINE source bridge, not a .rp or RP11 compiler.
// Contract references: LilZeeCN/zee-rp references/rp-language.md (target:9).
import { ApiError } from "../../apps/api/lib/httputil.mjs";

export const RP1_BRIDGE_SCHEMA = "arcunara.rp1-bridge.v1";
const MAX_PAGES = 50;
const MAX_ELEMENTS = 3000;
const MAX_CANVAS_W = 4096;
const MAX_CANVAS_H = 8192;
const DEFAULT_CANVAS_W = 1440;
const BASE_PADDING = 24;
const COLORS = Object.freeze({black:"#000000",white:"#FFFFFF",red:"#FF0000",
  blue:"#0000FF",green:"#008000",gray:"#808080",grey:"#808080",
  transparent:"#FFFFFF",navy:"#000080",orange:"#FFA500",
  purple:"#800080",yellow:"#FFFF00"});
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/;
const SAFE_ASSET_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_NAME_LEN = 120;
const MAX_NODE_TEXT = 512;

function fail(message, code = "INVALID_EDITABLE_IR") {
  throw new ApiError(400, message, code);
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value, cap = MAX_NODE_TEXT) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, cap);
}

function finitePixel(n, max) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max
    ? Math.round(n) : null;
}

function color(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map(ch=>ch+ch).join("").toUpperCase();
  return COLORS[v.toLowerCase()] ?? null;
}

function safeAssetPath(name) {
  if (typeof name !== "string" || name.length > 500 ||
      name.startsWith("/") || name.startsWith(".") || name.includes("\\") ||
      name.includes("?") || name.includes("#") ||
      !SAFE_ASSET_EXT.test(name)) return false;
  return name.split("/").every(seg =>
    seg && seg !== "." && seg !== ".." && !seg.startsWith(".") &&
    !/[:\u0000-\u001f\u007f]/.test(seg));
}

function nativeStyle(node, out, warnings, label) {
  const style = node.style;
  if (!plain(style)) return;
  // RP/1 is strict: labels/paragraphs do NOT accept fills/radii and images
  // do not accept text styling. Only add properties documented for the type.
  const isText = ["label","paragraph","button","input"].includes(out.type);
  const isBoxStyle = ["button","input"].includes(out.type);
  const fg = color(style.color);
  const bg = color(style.backgroundColor);
  if (isText && fg) out.color = fg;
  else if (style.color !== undefined) warnings.add("STYLE_COLOR_DROPPED:" + label);
  if (isBoxStyle && bg) out.fill = bg;
  else if (style.backgroundColor !== undefined) warnings.add("STYLE_BACKGROUND_DROPPED:" + label);
  const font = finitePixel(style.fontSize, 120);
  if (isText && font && font >= 8) out.fontSize = font;
  const radius = finitePixel(style.borderRadius, 100);
  if (isBoxStyle && radius !== null) out.radius = radius;
  if (isText && ["bold", "600", "700", "800"].includes(style.fontWeight)) out.fontWeight = 700;
  else if (isText && style.fontWeight === "500") out.fontWeight = 500;
}

function geometry(node, position, warnings, label) {
  const g = plain(node.geometry) ? node.geometry : {};
  const knownX = finitePixel(g.x, MAX_CANVAS_W);
  const knownY = finitePixel(g.y, MAX_CANVAS_H);
  const knownW = finitePixel(g.width, MAX_CANVAS_W);
  const knownH = finitePixel(g.height, MAX_CANVAS_H);
  const baseW = node.type === "image" ? 220 :
    ["button","link"].includes(node.type) ? 180 :
    ["input","checkbox","radio"].includes(node.type) ? 280 : 360;
  const baseH = node.type === "image" ? 140 :
    ["button","link"].includes(node.type) ? 42 :
    ["input","checkbox","radio"].includes(node.type) ? 38 :
    node.sourceTag === "p" ? 64 : 32;
  const w = knownW ?? baseW;
  const h = knownH ?? baseH;
  // If source lacks coordinates, give every editable element a stable
  // deterministic position instead of silently overlapping at (0,0).
  let x = knownX ?? BASE_PADDING;
  let y = knownY ?? position.fallbackY;
  const outOfCanvas = x + w > MAX_CANVAS_W || y + h > MAX_CANVAS_H;
  if (outOfCanvas) {
    x = BASE_PADDING; y = position.fallbackY;
    warnings.add("OUT_OF_CANVAS_REPOSITIONED:" + label);
  }
  if (knownX === null || knownY === null || knownW === null || knownH === null) {
    warnings.add("LAYOUT_SYNTHESIZED:" + label);
  }
  position.fallbackY = Math.max(position.fallbackY + baseH + 14, y + h + 14);
  return {x,y,w,h};
}

function validateIR(ir) {
  if (!plain(ir) || ir.schema !== "arcunara.editable-ir.v1" ||
      ir.status !== "mapping-only" || ir.nativeRpExportReady !== false ||
      !Array.isArray(ir.pages)) fail("Expected Arcunara RC18A editable IR");
  if (ir.pages.length < 1 || ir.pages.length > MAX_PAGES) {
    fail("IR page count out of range","RP1_PAGE_LIMIT");
  }
  let total = 0;
  const pagePaths = new Set();
  for (const page of ir.pages) {
    if (!plain(page) || !ID_RE.test(page.id) || typeof page.sourcePath !== "string" ||
        pagePaths.has(page.sourcePath) || !Array.isArray(page.nodes)) {
      fail("Malformed or duplicate IR page");
    }
    pagePaths.add(page.sourcePath);
    total += page.nodes.length;
    if (page.nodes.length > 350 || total > MAX_ELEMENTS) {
      fail("IR element count out of range","RP1_ELEMENT_LIMIT");
    }
    const seenIds = new Set();
    for (const node of page.nodes) {
      if (!plain(node) || !ID_RE.test(node.id) || seenIds.has(node.id) ||
          typeof node.type !== "string") fail("Malformed or duplicate IR widget");
      seenIds.add(node.id);
    }
  }
}

export function convertIRToRP1(ir, {projectName} = {}) {
  validateIR(ir);
  const pageIdByPath = new Map(ir.pages.map(p => [p.sourcePath,p.id]));
  const report = {
    schema:RP1_BRIDGE_SCHEMA,
    target:"rp/1 / Axure RP9 (not RP11-certified)",
    sourceIRSchema:ir.schema,
    projectId:ir.projectId ?? null,
    version:ir.version ?? null,
    mapped:0, downgraded:0, skipped:0,
    warnings:[],
    nativeRpExportReady:false,
    status:"source-only",
    hostValidated:false
  };
  const warnings = new Set();
  const pages = [];
  for (const page of ir.pages) {
    const pos = {fallbackY:BASE_PADDING};
    const children = [];
    let maxRight = DEFAULT_CANVAS_W, maxBottom = 900;
    for (const node of page.nodes) {
      const label = page.id + "/" + node.id;
      const t = node.type;
      let out;
      if (t === "text") {
        out = {type:node.sourceTag === "p" ? "paragraph" : "label",id:node.id,
          text:string(node.text) || " "};
      } else if (t === "button") {
        out = {type:"button",id:node.id,text:string(node.text)||"按钮"};
      } else if (t === "link") {
        out = {type:"button",id:node.id,text:string(node.text)||"链接"};
        const target = node.navigation?.kind === "navigate-page" &&
          pageIdByPath.get(node.navigation.target);
        if (target) {
          out.on = {click:[{type:"link",page:target}]};
        } else {
          warnings.add("LINK_ACTION_DROPPED:" + label);
          report.downgraded++;
        }
      } else if (t === "input") {
        out = {type:"input",id:node.id,value:"",
          placeholder:string(node.input?.placeholder,200)};
        if (!["text","email","number","tel","search","url","textarea","select",""].includes(
          String(node.input?.kind ?? "").toLowerCase())) {
          warnings.add("INPUT_KIND_AS_TEXT:" + label);
          report.downgraded++;
        }
      } else if (t === "checkbox" || t === "radio") {
        out = {type:t,id:node.id,text:string(node.text)||" ",checked:false};
        if (t === "radio") out.group = "imported-radio";
      } else if (t === "image") {
        if (!safeAssetPath(node.assetPath)) {
          out = {type:"label",id:node.id,text:"[图片资源未映射]"};
          warnings.add("IMAGE_REPLACED_WITH_LABEL:" + label);
          report.downgraded++;
        } else {
          out = {type:"image",id:node.id,src:node.assetPath};
          warnings.add("IMAGE_REQUIRES_ORIGINAL_ASSET:" + label);
        }
      } else {
        report.skipped++;
        warnings.add("UNSUPPORTED_WIDGET_SKIPPED:" + label);
        continue;
      }
      Object.assign(out,geometry(node,pos,warnings,label));
      nativeStyle(node,out,warnings,label);
      maxRight = Math.max(maxRight,out.x+out.w+BASE_PADDING);
      maxBottom = Math.max(maxBottom,out.y+out.h+BASE_PADDING);
      children.push(out);
      report.mapped++;
    }
    if (maxRight > MAX_CANVAS_W || maxBottom > MAX_CANVAS_H) {
      warnings.add("CANVAS_BOUNDS_CLAMPED:" + page.id);
    }
    pages.push({
      id:page.id,
      name:string(page.title, MAX_NAME_LEN)||page.id,
      canvas:{w:Math.min(MAX_CANVAS_W,maxRight),h:Math.min(MAX_CANVAS_H,maxBottom)},
      root:{type:"box",id:"root",layout:"stack",padding:0,fill:"#FFFFFF",children}
    });
    if (Array.isArray(page.warnings)) {
      for (const w of page.warnings) warnings.add("SOURCE_IR:" + String(w).slice(0,100));
    }
  }
  report.warnings = [...warnings].sort();
  // The downstream compiler supports RP9 native output only. Users must
  // explicitly invoke Zee-RP and verify any resulting .rp in Axure.
  const spec = {
    language:"rp/1",
    target:9,
    name:string(projectName,MAX_NAME_LEN)||"Arcunara prototype",
    theme:"enterprise-light",
    domain:"web",
    pages
  };
  return {spec,report};
}
