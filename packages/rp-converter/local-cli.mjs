#!/usr/bin/env node
// RC18B developer-only local bridge. This file is NOT loaded by API/preview.
// CLI commands are fixed; no shell, no user-supplied executable, no remote
// download and no fallback to a fabricated .rp file.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { convertIRToRP1 } from "./rp1-bridge.mjs";

const USAGE = [
  "Usage:",
  "  node packages/rp-converter/local-cli.mjs convert <arcunara-ir.json> <new.rp1.json>",
  "  node packages/rp-converter/local-cli.mjs compile <source.rp1.json> <zee-rp-dir> <new-output.rp>",
  "",
  "Compile is a LOCAL developer operation, not an Arcunara API endpoint.",
  "Zee-RP current RP/1 target is Axure RP9. RP11 host validation is separate.",
  "Set AXURE_BLANK_TEMPLATE_RP9 if required by your Zee-RP installation."
].join("\n");

async function isPresent(filepath) {
  try { await fs.stat(filepath); return true; }
  catch (err) { if (err.code === "ENOENT") return false; throw err; }
}
function requireJsonRP1(doc) {
  if (!doc || doc.language !== "rp/1" || doc.target !== 9 ||
      !Array.isArray(doc.pages) || doc.pages.length === 0 || doc.pages.length > 50) {
    throw new Error("Expected a nonempty RP/1 target=9 JSON AST; RP11 is not supported");
  }
}

function runCommand(executable, args, {cwd, timeoutMs}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, shell:false, windowsHide:true,
      stdio:["ignore","pipe","pipe"]
    });
    let logs = "", size = 0, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onChunk = data => {
      size += data.length;
      // The tools may report parser errors; retain a bounded excerpt.
      if (logs.length < 120000) logs += data.toString("utf8").slice(0, 120000 - logs.length);
      if (size > 1024 * 1024) child.kill("SIGKILL");
    };
    child.stdout.on("data",onChunk);
    child.stderr.on("data",onChunk);
    child.on("error", err => {clearTimeout(timer);reject(err);});
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("Zee-RP command timed out"));
      if (size > 1024 * 1024) return reject(new Error("Zee-RP command logs exceeded cap"));
      if (code !== 0) return reject(new Error("Zee-RP exited " + code + ":\n" + logs.slice(-2000)));
      resolve(logs);
    });
  });
}

async function main(args) {
  const [command, ...parameters] = args;
  if (command === "convert" && parameters.length === 2) {
    const [input, output] = parameters.map(p => path.resolve(p));
    if (input === output || !output.endsWith(".json") || await isPresent(output)) {
      throw new Error("Destination must be a NEW .json file distinct from input");
    }
    const ir = JSON.parse(await fs.readFile(input,"utf8"));
    const {spec,report} = convertIRToRP1(ir);
    await fs.writeFile(output,JSON.stringify(spec,null,2)+"\n",{flag:"wx",mode:0o600});
    process.stdout.write(JSON.stringify({output,report},null,2)+"\n");
    return;
  }
  if (command === "compile" && parameters.length === 3) {
    const [input,zeeRoot,output] = parameters.map(p => path.resolve(p));
    if (input === output || !output.toLowerCase().endsWith(".rp") ||
        await isPresent(output)) {
      throw new Error("Destination must be a NEW .rp file distinct from input");
    }
    const spec = JSON.parse(await fs.readFile(input,"utf8"));
    requireJsonRP1(spec);
    const pkg = JSON.parse(await fs.readFile(path.join(zeeRoot,"package.json"),"utf8"));
    if (pkg.name !== "zee-rp") throw new Error("Invalid Zee-RP directory");
    const compiler = path.join(zeeRoot,"scripts","proto.mjs");
    if (!(await fs.stat(compiler)).isFile()) throw new Error("Zee-RP proto.mjs not found");
    // check does not create native files. Abort on semantic errors.
    await runCommand(process.execPath,[compiler,"check","--spec",input],{
      cwd:zeeRoot,timeoutMs:120000
    });
    const temp = await fs.mkdtemp(path.join(os.tmpdir(),"arcunara-rp1-"));
    try {
      await runCommand(process.execPath,[compiler,"generate","--spec",input,
        "--out-dir",path.join(temp,"bundle"),"--out-rp",output,"--backend","native"],{
        cwd:zeeRoot,timeoutMs:480000
      });
      const stat = await fs.stat(output);
      if (!stat.isFile() || stat.size < 128) {
        await fs.rm(output,{force:true});
        throw new Error("Zee-RP did not emit a plausible output file");
      }
      process.stdout.write(JSON.stringify({
        output,size:stat.size,sourceTarget:9,
        status:"zee-rp-generated-not-axure-host-validated",
        axureRP11Validated:false,
        note:"Must open, inspect, edit and save in Axure before claiming compatibility"
      },null,2)+"\n");
    } catch (err) {
      // Only remove the output path if this invocation created it.
      // Existing output is pre-rejected and never touched.
      await fs.rm(output,{force:true});
      throw err;
    } finally {
      await fs.rm(temp,{recursive:true,force:true});
    }
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write((err?.message || String(err))+"\n");
  process.exitCode = 1;
});
