import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import yauzl from "yauzl";
import { startServer } from "./helpers/harness.mjs";
import { filesZip } from "./helpers/zipbuilder.mjs";

function multipartZip(entries, name) {
  const form = new FormData();
  if (name) form.set("name", name);
  form.set("file", new Blob([filesZip(entries.map(([file, data]) => ({
    name: file, data
  })))]), "prototype.zip");
  return form;
}

async function download(server, projectId, query = "", token = server.token) {
  return fetch(server.apiBase + "/api/projects/" + projectId + "/export" + query, {
    headers: token ? { authorization: "Bearer " + token } : {}
  });
}

async function unzip(buffer) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, opened) => {
      if (err) reject(err);
      else resolve(opened);
    });
  });
  const files = new Map();
  await new Promise((resolve, reject) => {
    zip.once("error", reject);
    zip.once("end", resolve);
    zip.on("entry", entry => {
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks = [];
        stream.on("data", part => chunks.push(part));
        stream.once("error", reject);
        stream.once("end", () => {
          files.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  zip.close();
  return files;
}

test("RC17 exports a valid ZIP per requested historical version without rollback", async () => {
  const server = await startServer();
  try {
    const created = await server.api("/api/projects", {
      method: "POST",
      body: multipartZip([
        ["index.html", "<html><body>first</body></html>"],
        ["assets/style.css", "body{color:#333}"],
        ["中文/说明.txt", "第一版"]
      ], "Archive fixture")
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;
    const next = await server.api("/api/projects/" + id + "/versions", {
      method: "POST",
      body: multipartZip([
        ["index.html", "<html><body>second</body></html>"],
        ["assets/style.css", "body{color:#777}"],
        ["中文/说明.txt", "第二版"]
      ])
    });
    assert.equal(next.status, 201, JSON.stringify(next.json));

    const v1 = await download(server, id, "?version=1");
    assert.equal(v1.status, 200);
    assert.match(v1.headers.get("content-type"), /application\/zip/);
    assert.match(v1.headers.get("content-disposition"), new RegExp("v1\\.zip"));
    assert.match(v1.headers.get("cache-control"), /no-store/);
    const firstFiles = await unzip(Buffer.from(await v1.arrayBuffer()));
    assert.equal(firstFiles.get("index.html").toString(), "<html><body>first</body></html>");
    assert.equal(firstFiles.get("中文/说明.txt").toString(), "第一版");
    assert.equal(firstFiles.get("assets/style.css").toString(), "body{color:#333}");
    assert.equal(firstFiles.size, 3);

    const currentResponse = await download(server, id);
    assert.equal(currentResponse.status, 200);
    assert.match(currentResponse.headers.get("content-disposition"), /v2\.zip/);
    const currentFiles = await unzip(Buffer.from(await currentResponse.arrayBuffer()));
    assert.equal(currentFiles.get("index.html").toString(), "<html><body>second</body></html>");
    assert.equal(currentFiles.get("中文/说明.txt").toString(), "第二版");
    assert.equal((await server.api("/api/projects/" + id)).json.currentVersion, 2);
    assert.equal((await server.api("/api/projects/" + id + "/versions")).json.versions.length, 2);
  } finally { await server.stop(); await server.cleanup(); }
});

test("RC17 export denies anonymous users, deploy keys, wrong versions and trash", async () => {
  const server = await startServer();
  try {
    const created = await server.api("/api/projects", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Export access",html:"<html>content</html>"})
    });
    const id=created.json.id;
    const key=await server.api("/api/projects/"+id+"/deploy-keys",{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal((await download(server,id,"",null)).status,401);
    const restricted=await download(server,id,"",key.json.token);
    assert.equal(restricted.status,403);
    assert.equal((await restricted.json()).code,"DEPLOY_KEY_FORBIDDEN");
    for (const query of ["?version=0","?version=-1","?version=1.2",
                         "?version=abc","?version=1&version=1","?version=999999999999999999999"]) {
      const bad=await download(server,id,query);
      assert.equal(bad.status,400,query);
    }
    assert.equal((await download(server,id,"?version=99")).status,404);
    await server.api("/api/projects/"+id,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({lifecycleState:"trashed"})
    });
    const deleted=await download(server,id);
    assert.equal(deleted.status,409);
    assert.equal((await deleted.json()).code,"PROJECT_TRASHED");
    const absent=await download(server,crypto.randomUUID());
    assert.equal(absent.status,404);
  } finally { await server.stop(); await server.cleanup(); }
});

test("RC17 legacy-root exports only user files, never private metadata or hidden files", async () => {
  const server=await startServer();
  try {
    const id=crypto.randomUUID();
    const root=path.join(server.dataDir,id);
    await fs.mkdir(path.join(root,"nested"),{recursive:true});
    await fs.writeFile(path.join(root,"index.html"),"<html>legacy</html>");
    await fs.writeFile(path.join(root,"nested","page.html"),"<html>nested</html>");
    await fs.writeFile(path.join(root,".secret"),"NEVER-EXPORT");
    await fs.writeFile(path.join(root,"meta.json"),JSON.stringify({
      id,name:"Legacy",createdAt:new Date().toISOString(), privateSecret:"NEVER-EXPORT"
    }));
    const response=await download(server,id,"?version=1");
    assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());
    const result=await unzip(bytes);
    assert.deepEqual([...result.keys()].sort(),["index.html","nested/page.html"]);
    assert.ok(!bytes.includes(Buffer.from("NEVER-EXPORT")));
  } finally { await server.stop(); await server.cleanup(); }
});

test("RC17 rejects unsafe symlinks and oversized exports before sending ZIP headers", async () => {
  const server=await startServer();
  try {
    const created=await server.api("/api/projects",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Security",html:"<html>safe</html>"})
    });
    const id=created.json.id;
    const version=path.join(server.dataDir,id,"versions","1");
    await fs.symlink(path.join(server.dataDir,id,"meta.json"),path.join(version,"secret-link.txt"));
    const unsafe=await download(server,id);
    assert.equal(unsafe.status,409);
    assert.equal((await unsafe.json()).code,"EXPORT_UNSAFE_ENTRY");
    await fs.unlink(path.join(version,"secret-link.txt"));

    // A sparse file tests the size cap without actually consuming 256 MiB RAM.
    const big=path.join(version,"oversized.bin");
    await fs.writeFile(big,Buffer.alloc(1));
    await fs.truncate(big,256*1024*1024+1);
    const oversized=await download(server,id);
    assert.equal(oversized.status,413);
    assert.equal((await oversized.json()).code,"EXPORT_SIZE_LIMIT");
  } finally { await server.stop();await server.cleanup(); }
});

test("RC17 workbench includes the authenticated ZIP download control", async () => {
  const server=await startServer();
  try {
    const html=await (await fetch(server.apiBase+"/console")).text();
    assert.match(html,/id="downloadVersionZipBtn"/);
    assert.match(html,/\/export\?version=/);
    assert.match(html,/application\/zip|ZIP 下载失败/);
    assert.match(html,/Authorization: "Bearer " \+ token/);
  } finally { await server.stop();await server.cleanup(); }
});
