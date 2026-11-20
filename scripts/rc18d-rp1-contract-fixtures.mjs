#!/usr/bin/env node
// RC18D: realistic Arcunara IR -> RP/1 fixtures for an upstream Zee-RP
// semantic-contract check. No user data, no network, no .rp files.
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { convertIRToRP1 } from "../packages/rp-converter/rp1-bridge.mjs";

if (process.argv.length !== 3) {
  console.error("Usage: node scripts/rc18d-rp1-contract-fixtures.mjs <new-directory>");
  process.exit(2);
}
const output = path.resolve(process.argv[2]);
const base = {
  schema:"arcunara.editable-ir.v1",
  artifactType:"editable-candidate-intermediate-json",
  target:"axure-rp11",
  status:"mapping-only",
  nativeRpExportReady:false,
  compiler:{available:false,name:"zee-rp",output:null},
  projectId:"contract-only",
  version:1,
  isAxureHtmlExport:false,
  summary:{pages:0,editableCandidates:0,candidatesWithExplicitGeometry:0,htmlBytesScanned:0},
  warnings:[],
  limitations:[]
};

const fixtures = [
  {
    file:"01-multipage-navigation.rp1.json",
    name:"Contract: Multilingual Navigation",
    pages:[
      {id:"p001",sourcePath:"index.html",title:"概览 / Dashboard",warnings:[],
        nodes:[
          {id:"w0001",type:"text",sourceTag:"h1",text:"欢迎使用 Arcunara",editableCandidate:true,
            geometry:{x:24,y:24,width:400,height:40},
            style:{fontSize:24,fontWeight:"700",color:"#123456"}},
          {id:"w0002",type:"text",sourceTag:"p",text:"This is an editable paragraph.",editableCandidate:true,
            geometry:{x:24,y:84,width:500,height:64}},
          {id:"w0003",type:"link",sourceTag:"a",text:"打开详情",editableCandidate:true,
            navigation:{kind:"navigate-page",target:"details.html"},
            geometry:{x:24,y:180,width:180,height:44},
            style:{backgroundColor:"#336699",color:"#FFFFFF",borderRadius:6}},
          {id:"w0004",type:"input",sourceTag:"input",editableCandidate:true,
            input:{kind:"text",placeholder:"请输入名称"},
            geometry:{x:24,y:260,width:340,height:44}}
        ]},
      {id:"p002",sourcePath:"details.html",title:"Details",warnings:[],
        nodes:[
          {id:"w0001",type:"text",sourceTag:"h2",text:"详情",editableCandidate:true,
            geometry:{x:24,y:24,width:280,height:40}},
          {id:"w0002",type:"link",sourceTag:"a",text:"返回",editableCandidate:true,
            navigation:{kind:"navigate-page",target:"index.html"},
            geometry:{x:24,y:85,width:140,height:40}}
        ]}
    ]
  },
  {
    file:"02-inputs-and-images.rp1.json",
    name:"Contract: Forms and Image",
    pages:[{id:"p001",sourcePath:"index.html",title:"表单",warnings:[],
      nodes:[
        {id:"w0001",type:"text",sourceTag:"label",text:"个人资料",editableCandidate:true,
          style:{fontSize:18,color:"#333333"}},
        {id:"w0002",type:"button",sourceTag:"button",text:"提交",editableCandidate:true,
          geometry:{width:190,height:42},style:{fontSize:16,backgroundColor:"#0055CC"}},
        {id:"w0003",type:"input",sourceTag:"textarea",editableCandidate:true,
          input:{kind:"textarea",placeholder:"填写备注"},geometry:{width:380,height:80}},
        {id:"w0004",type:"checkbox",sourceTag:"input",editableCandidate:true},
        {id:"w0005",type:"radio",sourceTag:"input",editableCandidate:true},
        {id:"w0006",type:"image",sourceTag:"img",editableCandidate:true,
          assetPath:"assets/logo.png",alt:"Logo",
          geometry:{width:120,height:60}}
      ]}]
  },
  {
    file:"03-layout-fallback.rp1.json",
    name:"Contract: Synthesized Geometry",
    pages:[{id:"p001",sourcePath:"index.html",title:"布局兼容性",warnings:["LAYOUT_NOT_EXPLICIT_IN_INLINE_CSS"],
      nodes:[
        {id:"w0001",type:"text",sourceTag:"h3",text:"No explicit position",editableCandidate:true},
        {id:"w0002",type:"button",sourceTag:"button",text:"Next action",editableCandidate:true},
        {id:"w0003",type:"link",sourceTag:"a",text:"External link without mapped action",editableCandidate:true},
        {id:"w0004",type:"input",sourceTag:"input",editableCandidate:true,
          input:{kind:"number",placeholder:"0"}}
      ]}]
  }
];

await fs.mkdir(output,{recursive:true});

// Real Zee-RP validates the existence of referenced images during "check".
// Generate a self-contained original 1x1 red PNG (no network, no user media).
const pngChunk = (type, bytes) => {
  const tag = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, bytes])) >>> 0);
  return Buffer.concat([size,tag,bytes,checksum]);
};
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a","hex"),
  pngChunk("IHDR",Buffer.from([0,0,0,1, 0,0,0,1, 8,2,0,0,0])),
  pngChunk("IDAT",deflateSync(Buffer.from([0,255,0,0]))),
  pngChunk("IEND",Buffer.alloc(0))
]);
await fs.mkdir(path.join(output,"assets"),{recursive:true});
await fs.writeFile(path.join(output,"assets","logo.png"),png,{flag:"wx"});
const manifest = [];
for (const fixture of fixtures) {
  const ir = {...base,pages:fixture.pages,summary:{...base.summary,pages:fixture.pages.length}};
  const {spec,report} = convertIRToRP1(ir,{projectName:fixture.name});
  if (spec.language !== "rp/1" || spec.target !== 9 || report.hostValidated !== false ||
      report.nativeRpExportReady !== false) {
    throw new Error("Source contract unexpectedly claims native RP11 support");
  }
  const file = path.join(output,fixture.file);
  await fs.writeFile(file,JSON.stringify(spec,null,2)+"\n",{flag:"wx"});
  manifest.push({file:fixture.file, pages:spec.pages.length, widgets:report.mapped,
    sourceStatus:report.status, unverified:true});
}
console.log(JSON.stringify({schema:"arcunara.rp1-contract-fixtures.v1",
  source:"Arcunara RC18B bridge", upstreamRequired:"zee-rp semantic check",
  nativeGenerated:false, hostRP11Verified:false,
  fixtures:manifest},null,2));
