// RC22: Actual Axure native player on a separate hostname, never staging.
// Integration tests exercise the real preview listener with explicit Host.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { request } from "node:http";
import { filesZip } from "./helpers/zipbuilder.mjs";
import { startServer } from "./helpers/harness.mjs";
import { loadConfig } from "../apps/api/lib/config.mjs";

const SAFE_HOST="staging.arcunara.com";
const NATIVE_HOST="axure-staging.arcunara.com";
let server, axureId, plainId, shareToken, ephemeralToken, plainToken;

function get(path,host,{method="GET"}={}) {
  return new Promise((resolve,reject)=>{
    const url=new URL(server.previewBase);
    const req=request({
      hostname:url.hostname,port:Number(url.port),path,method,
      headers:{Host:host}
    },res=>{
      const parts=[];
      res.on("data",c=>parts.push(c));
      res.on("end",()=>resolve({
        status:res.statusCode,
        headers:res.headers,
        body:Buffer.concat(parts).toString("utf8")
      }));
      res.on("error",reject);
    });
    req.on("error",reject);req.end();
  });
}

before(async()=>{
  server=await startServer({
    ARCU_ACCESS_ISSUER:"https://example.cloudflareaccess.com",
    ARCU_ACCESS_AUDIENCE:"a".repeat(64),
    ARCU_ACCESS_ADMIN_EMAIL:"admin@example.com",
    ARCU_ACCESS_ORIGIN:"https://"+SAFE_HOST,
    ARCU_STAGING_PUBLIC_PREVIEW:"1",
    ARCU_PREVIEW_PUBLIC_BASE_URL:"https://"+SAFE_HOST,
    ARCU_AXURE_NATIVE_ORIGIN:"https://"+NATIVE_HOST
  });
  const fd=new FormData();
  fd.set("name","Real Axure");
  fd.set("file",new Blob([filesZip([
    {name:"index.html",data:'<html><body><h1 id="player">Native Axure player</h1><iframe src="page.html"></iframe><script src="resources/scripts/axure/player.js"></script></body></html>'},
    {name:"data/document.js",data:"window.axureDocument={};"},
    {name:"resources/scripts/axure/player.js",data:"localStorage.setItem('native', 'yes'); new Function('return 1')();"},
    {name:"page.html",data:"<html><body>Axure business content</body></html>"}
  ])]),"axure.zip");
  let res=await server.api("/api/projects",{method:"POST",body:fd});
  assert.equal(res.status,201,JSON.stringify(res.json));axureId=res.json.id;
  res=await server.api(`/api/projects/${axureId}/shares`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({expiresInHours:1})
  });
  assert.equal(res.status,201);shareToken=res.json.token;
  res=await server.api(`/api/projects/${axureId}/preview-ticket`,{method:"POST"});
  assert.equal(res.status,201);ephemeralToken=res.json.token;
  const pd=new FormData();
  pd.set("name","Ordinary HTML");
  pd.set("file",new Blob([filesZip([
    {name:"index.html",data:"<html>Ordinary site</html>"}
  ])]),"plain.zip");
  res=await server.api("/api/projects",{method:"POST",body:pd});
  assert.equal(res.status,201);plainId=res.json.id;
  res=await server.api(`/api/projects/${plainId}/shares`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:"{}"
  });
  assert.equal(res.status,201);plainToken=res.json.token;
});

after(async()=>{if(server){await server.stop();await server.cleanup();}});

test("native host serves the real Axure index player, not a safe-nav redirect",async()=>{
  const r=await get(`/s/${shareToken}/index.html?g=1&p=page`,NATIVE_HOST);
  assert.equal(r.status,200);
  assert.match(r.body,/Native Axure player/);
  const csp=r.headers["content-security-policy"];
  assert.match(csp,/script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.match(csp,/connect-src 'self'/);
  assert.match(csp,/frame-src 'self'/);
  assert.ok(!csp.includes("sandbox"),"opaque origin must be disabled ONLY on native host");
  assert.equal(r.headers["x-frame-options"],"SAMEORIGIN");
  assert.equal(r.headers["set-cookie"],undefined);
  assert.equal(r.headers["referrer-policy"],"no-referrer");
  const root=await get(`/s/${shareToken}/`,NATIVE_HOST);
  assert.equal(root.status,200);assert.match(root.body,/Native Axure player/);
});

test("native host serves original HTML iframe, JS, document, CSS and stores origin context",async()=>{
  const page=await get(`/s/${shareToken}/page.html`,NATIVE_HOST);
  assert.equal(page.status,200);assert.match(page.body,/Axure business content/);
  assert.ok(!page.headers["content-security-policy"].includes("sandbox"));
  const js=await get(`/s/${shareToken}/resources/scripts/axure/player.js`,NATIVE_HOST);
  assert.equal(js.status,200);
  assert.match(js.body,/localStorage\.setItem/);
  const data=await get(`/s/${shareToken}/data/document.js`,NATIVE_HOST);
  assert.equal(data.status,200);
});

test("safe workbench hostname keeps opaque sandbox and old link redirects",async()=>{
  const root=await get(`/s/${shareToken}/`,SAFE_HOST);
  assert.equal(root.status,200);
  assert.match(root.body,/安全预览/);
  assert.match(root.body,/id="nativeAxurePlayer"/);
  assert.match(root.body,new RegExp("https://"+NATIVE_HOST+"/s/"));
  assert.match(root.headers["content-security-policy"],/sandbox allow-scripts/);
  const player=await get(`/s/${shareToken}/index.html?p=page`,SAFE_HOST);
  assert.equal(player.status,302);
  assert.ok(player.headers.location.startsWith(`/s/${shareToken}/#`));
  const safePage=await get(`/s/${shareToken}/page.html`,SAFE_HOST);
  assert.equal(safePage.status,200);
  assert.match(safePage.headers["content-security-policy"],/sandbox allow-scripts/);
});

test("native origin serves only valid Axure share-capability URLs",async()=>{
  const paths=["/","/console","/health","/api/projects",`/p/${axureId}/`,
    `/s/${plainToken}/index.html`,
    `/s/0000000000000000.${"A".repeat(43)}/index.html`];
  for(const path of paths) {
    const r=await get(path,NATIVE_HOST);
    assert.equal(r.status,404,path);
  }
  const ephem=await get(`/s/${ephemeralToken}/index.html`,NATIVE_HOST);
  assert.equal(ephem.status,200);
  const nonAxure=await get(`/s/${plainToken}/index.html`,SAFE_HOST);
  assert.equal(nonAxure.status,200);
});

test("unknown Host cannot obtain relaxed native policy",async()=>{
  const r=await get(`/s/${shareToken}/index.html`,"other.example.com");
  assert.equal(r.status,302);
  const page=await get(`/s/${shareToken}/page.html`,"other.example.com");
  assert.match(page.headers["content-security-policy"],/sandbox/);
});

test("HEAD on native share keeps same headers and no response body",async()=>{
  const r=await get(`/s/${shareToken}/index.html`,NATIVE_HOST,{method:"HEAD"});
  assert.equal(r.status,200);
  assert.equal(r.body,"");
  assert.match(r.headers["content-security-policy"],/unsafe-eval/);
});

test("configuration forbids using the admin hostname or a different admin port",()=>{
  const env={
    ARCU_TOKEN_FILE:server.tokenFile,
    ARCU_ACCESS_ISSUER:"https://example.cloudflareaccess.com",
    ARCU_ACCESS_AUDIENCE:"a".repeat(64),
    ARCU_ACCESS_ADMIN_EMAIL:"admin@example.com",
    ARCU_ACCESS_ORIGIN:"https://"+SAFE_HOST,
    ARCU_STAGING_PUBLIC_PREVIEW:"1",
    ARCU_PREVIEW_PUBLIC_BASE_URL:"https://"+SAFE_HOST,
    ARCU_LOCAL_AUTO_LOGIN:"0"
  };
  for(const raw of ["https://"+SAFE_HOST, "https://"+SAFE_HOST+":8443"]) {
    assert.throws(()=>loadConfig({
      ...env,ARCU_AXURE_NATIVE_ORIGIN:raw
    }),/distinct HTTPS host/);
  }
  assert.equal(loadConfig({
    ...env,ARCU_AXURE_NATIVE_ORIGIN:"https://"+NATIVE_HOST
  }).axureNativeOrigin,"https://"+NATIVE_HOST);
});
