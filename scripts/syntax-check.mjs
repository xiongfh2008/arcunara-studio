// Minimal zero-dependency "lint": run node --check on every project .mjs file.
// Kept dependency-free on purpose — see docs/development.md.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const ROOTS = ["apps", "scripts", "tests"];

function collectMjsFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectMjsFiles(full));
    } else if (entry.name.endsWith(".mjs")) {
      files.push(full);
    }
  }

  return files;
}

const files = ROOTS.flatMap((root) => collectMjsFiles(root));

if (files.length === 0) {
  console.error("No .mjs files found to check");
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "ignore"
  });

  if (result.status !== 0) {
    failures.push(file);
    console.error(`FAIL  ${file}`);
  } else {
    console.log(`ok    ${file}`);
  }
}

if (failures.length > 0) {
  console.error(
    `\nSyntax check failed for ${failures.length}/${files.length} file(s)`
  );
  process.exit(1);
}

console.log(`\nSyntax check passed for ${files.length} file(s)`);
