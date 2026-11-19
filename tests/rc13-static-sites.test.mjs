import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

const DOMAIN = "sites.arcunara.test";

async function staticProject(server, name = "Generated website") {
  const form = new FormData();
  form.set("name", name);
  form.set("file", new Blob([filesZip([
    { name:"index.html", data:'<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><h1>AI website</h1><script type="module" src="/assets/app.js"></script></body></html>' },
    { name:"assets/app.css", data:":root{color:#123456}" },
    { name:"assets/app.js", data:"window.siteReady=true" },
    { name:"nested/index.html", data:"<html>Nested</html>" }
  ])]), "site.zip");
  const response = await server.api("/api/projects",{ method:"POST",body:form });
  assert.equal(response.status,201,JSON.stringify(response.json));
  return response.json.id;
}

async function patch(server,id,object,token) {
  return server.api(`/api/projects/${id}`,{
    method:"PATCH",token,headers:{"content-type":"application/json"},
    body:JSON.stringify(object)
  });
}

test("RC13 site listener is disabled by default and publication cannot be enabled",async()=>{
  const server=await startServer();
  try {
    assert.equal(server.siteBase,null);
    const id=await staticProject(server);
    assert.equal((await patch(server,id,{siteEnabled:true})).status,409);
    const detail=await server.api(`/api/projects/${id}`);
    assert.equal(detail.json.siteEnabled,false);
    assert.equal(detail.json.siteUrl,null);
    assert.equal((await server.preview(`/p/${id}/`)).status,200);
  } finally { await server.stop();await server.cleanup(); }
});

test("RC13 static website is published only on its isolated UUID host, with normal JS and safe assets",async()=>{
  const server=await startServer({
    ARCU_SITE_HOSTING_ENABLED:"1",
    ARCU_SITE_DOMAIN:DOMAIN,
    ARCU_SITE_PORT:"0",
    ARCU_SITE_HOST:"127.0.0.1"
  });
  try {
    assert.ok(server.siteBase);
    const id=await staticProject(server);
    assert.equal((await server.site(id,"/")).status,404,"unpublished project inaccessible");
    const invalid=await patch(server,id,{siteEnabled:"yes"});
    assert.equal(invalid.status,400);
    const publish=await patch(server,id,{siteEnabled:true});
    assert.equal(publish.status,200,JSON.stringify(publish.json));
    const detail=await server.api(`/api/projects/${id}`);
    assert.equal(detail.json.siteEnabled,true);
    assert.equal(detail.json.siteUrl,`https://${id}.${DOMAIN}/`);

    const html=await server.site(id,"/",{headers:{accept:"text/html"}});
    assert.equal(html.status,200);
    assert.match(await html.text(),/AI website/);
    assert.doesNotMatch(html.headers.get("content-security-policy")??"",/sandbox/);
    assert.match(html.headers.get("content-security-policy")??"",/frame-ancestors 'none'/);
    assert.equal(html.headers.get("set-cookie"),null);
    const js=await server.site(id,"/assets/app.js");
    assert.equal(js.status,200);
    assert.match(js.headers.get("content-type"),/javascript/);
    assert.match(await js.text(),/siteReady/);
    const css=await server.site(id,"/assets/app.css");
    assert.equal(css.status,200);
    assert.match(await css.text(),/#123456/);
    assert.equal((await server.site(id,"/nested/")).status,200);
    const route=await server.site(id,"/dashboard/settings",{headers:{accept:"text/html"}});
    assert.equal(route.status,200);
    assert.match(await route.text(),/AI website/);
    assert.equal((await server.site(id,"/assets/nope.js",{headers:{accept:"text/html"}})).status,404);
    assert.equal((await server.site(id,"/api/projects",{headers:{accept:"text/html"}})).status,404);
    assert.equal((await server.site(id,"/meta.json")).status,404);
    assert.equal((await server.site(id,"/.env")).status,404);
    assert.equal((await server.site(id,"/assets/%2Fetc")).status,404);
    assert.equal((await server.site(id,"/",{method:"POST"})).status,404);
    const head=await server.site(id,"/assets/app.css",{method:"HEAD"});
    assert.equal(head.status,200);
    assert.equal(await head.text(),"");
    const another=crypto.randomUUID();
    assert.equal((await server.site(another,"/")).status,404);
    const cross=await fetch(server.siteBase + "/",{headers:{host:"staging.arcunara.com"}});
    assert.equal(cross.status,404);

    assert.equal((await patch(server,id,{siteEnabled:true},null)).status,401);
    const key=await server.api(`/api/projects/${id}/deploy-keys`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    assert.equal(key.status,201);
    assert.equal((await patch(server,id,{siteEnabled:false},key.json.token)).status,403);
    assert.equal((await patch(server,id,{siteEnabled:false})).status,200);
    assert.equal((await server.site(id,"/")).status,404);
    assert.equal((await server.preview(`/p/${id}/`)).status,200,"preview gate independent of publication");
    await patch(server,id,{siteEnabled:true});
    assert.equal((await server.site(id,"/")).status,200);
    assert.equal((await patch(server,id,{lifecycleState:"trashed"})).status,200);
    assert.equal((await server.site(id,"/")).status,404);
    await patch(server,id,{lifecycleState:"active"});
    assert.equal((await server.site(id,"/")).status,404,"restore must not silently republish a public website");
  } finally { await server.stop();await server.cleanup(); }
});
