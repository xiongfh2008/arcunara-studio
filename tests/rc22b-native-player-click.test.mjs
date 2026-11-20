// RC22B browser-entry regression: a safe-nav sandboxed document must not
// depend on opening popups; the trusted workbench can mint the capability.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { startServer } from "./helpers/harness.mjs";

const SAFE = "https://staging.arcunara.com";
const NATIVE = "https://axure-staging.arcunara.com";
const TOKEN = "ee" + "a".repeat(14) + "." + "B".repeat(43);
const SRC=readFileSync(new URL("../apps/api/console.html",import.meta.url),"utf8");

function nativeUrlFunction() {
  const start=SRC.indexOf("function nativeAxurePreviewUrl(safeUrl) {");
  assert.ok(start>0);
  const end=SRC.indexOf("\n}\n",start);
  assert.ok(end>start);
  return SRC.slice(start,end+2);
}

test("workbench offers a direct native Axure action only when enabled",async()=>{
  const cfg = {
    ARCU_STAGING_PUBLIC_PREVIEW:"1",
    ARCU_ACCESS_ISSUER:"https://example.cloudflareaccess.com",
    ARCU_ACCESS_AUDIENCE:"a".repeat(64),
    ARCU_ACCESS_ADMIN_EMAIL:"admin@example.com",
    ARCU_ACCESS_ORIGIN:SAFE,
    ARCU_PREVIEW_PUBLIC_BASE_URL:SAFE,
    ARCU_AXURE_NATIVE_ORIGIN:NATIVE
  };
  const app=await startServer(cfg);
  try {
    const page=await app.api("/console",{token:null});
    assert.equal(page.status,200);
    assert.match(page.text,/window\.__ARCU_AXURE_NATIVE_ORIGIN__ = "https:\/\/axure-staging\.arcunara\.com";/);
    assert.match(page.text,/id="nativeAxurePreviewBtn"/);
    assert.match(page.text,/nativeAxurePreviewBtn"\)\.addEventListener\("click", async \(\) => \{/);
    assert.match(page.text,/window\.open\("about:blank", "_blank"\)/);
    assert.match(page.text,/await usablePreviewUrl\(selected\.id\)/);
    assert.match(page.text,/nativeAxurePreviewUrl\(safeUrl\)/);
  } finally {
    await app.stop(); await app.cleanup();
  }
  const off=await startServer();
  try {
    const page=await off.api("/console",{token:null});
    assert.equal(page.status,200);
    assert.match(page.text,/window\.__ARCU_AXURE_NATIVE_ORIGIN__ = null;/);
  } finally {await off.stop();await off.cleanup();}
});

test("native workbench URL uses only valid server-issued scoped share tickets",()=>{
  const code=nativeUrlFunction();
  function call(raw,origin=NATIVE) {
    const ctx=vm.createContext({
      URL,
      window:{
        __ARCU_AXURE_NATIVE_ORIGIN__:origin,
        __ARCU_STAGING_PUBLIC_PREVIEW__:true
      },
      previewBase:()=>SAFE
    });
    vm.runInContext(code+"\nvar native= nativeAxurePreviewUrl;",ctx);
    return ()=>ctx.native(raw);
  }
  assert.equal(call(SAFE+"/s/"+TOKEN+"/")(),NATIVE+"/s/"+TOKEN+"/index.html");
  for(const invalid of [
    SAFE+"/p/875b47ed-1ba2-4916-b189-b11a39f20a63/",
    SAFE+"/s/"+TOKEN+"/index.html",
    SAFE+"/s/"+TOKEN+"/?p=page",
    SAFE+"/s/"+TOKEN+"/#foo",
    "https://evil.example.com/s/"+TOKEN+"/",
    SAFE+"/s/../"+TOKEN+"/",
    SAFE+"/s/"+TOKEN.replace("ee","AA")+"/random/"
  ]) {
    assert.throws(call(invalid),/无效的预览链接/);
  }
  assert.throws(call(SAFE+"/s/"+TOKEN+"/",null),/Axure 原生预览尚未启用/);
});
