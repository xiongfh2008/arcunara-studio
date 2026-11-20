import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateNativeSource } from "../packages/rp-converter/native-inputs.mjs";

const generator = fileURLToPath(new URL("../scripts/rc18d-rp1-contract-fixtures.mjs",import.meta.url));

test("RC18D generates deterministic real RP/1 source fixtures, not fake native files",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-contract-"));
  try{
    const out=path.join(root,"fixtures");
    await fs.mkdir(out);
    const cmd=spawnSync(process.execPath,[generator,out],{
      encoding:"utf8",timeout:20000
    });
    assert.equal(cmd.status,0,cmd.stderr);
    const report=JSON.parse(cmd.stdout);
    assert.equal(report.schema,"arcunara.rp1-contract-fixtures.v1");
    assert.equal(report.nativeGenerated,false);
    assert.equal(report.hostRP11Verified,false);
    assert.equal(report.fixtures.length,3);
    let totalPages=0, totalWidgets=0;
    for(const item of report.fixtures){
      assert.match(item.file,/\.rp1\.json$/);
      assert.equal(item.unverified,true);
      const source=JSON.parse(await fs.readFile(path.join(out,item.file),"utf8"));
      const check=validateNativeSource(source);
      assert.equal(source.language,"rp/1");
      assert.equal(source.target,9);
      assert.equal(check.pages,item.pages);
      assert.equal(check.nodes>=item.widgets,true); // Includes page container(s).
      totalPages+=check.pages;
      totalWidgets+=check.nodes;
    }
    assert.equal(totalPages,4);
    assert.ok(totalWidgets>10);
    assert.deepEqual((await fs.readdir(out)).sort(),
      [...report.fixtures.map(x=>x.file),"assets"].sort());
    const logo=await fs.readFile(path.join(out,"assets","logo.png"));
    assert.equal(logo.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    assert.ok(logo.length>60,"PNG fixture is nonempty");
    const again=spawnSync(process.execPath,[generator,out],{
      encoding:"utf8",timeout:20000
    });
    assert.notEqual(again.status,0,"Fixtures are not silently overwritten");
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});
