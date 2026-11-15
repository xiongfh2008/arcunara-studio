// Deployment configuration regression tests.
//
// Static guarantees over infra/docker/compose.yaml vs the frozen
// legacy-v02/compose.yaml: distinct compose project name and containers,
// disjoint loopback host ports, stack-local data volumes, no host
// networking, and the workbench preview base URL wiring. These checks
// mirror scripts/compose-preflight.mjs so CI enforces them even without
// Docker. The legacy file is only ever READ (it is frozen).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const compose = readFileSync(pathToFileURL(repoRoot + "infra/docker/compose.yaml"), "utf8");
const legacy = readFileSync(pathToFileURL(repoRoot + "legacy-v02/compose.yaml"), "utf8");

function hostPorts(text) {
  const ports = new Set();
  const re = /"127\.0\.0\.1:(\d+):\d+"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ports.add(Number(m[1]));
  }
  return ports;
}

test("compose project name is explicit and cannot collide with the v0.2.0 stack", () => {
  const name = /^name:\s*(\S+)\s*$/m.exec(compose)?.[1];
  assert.equal(name, "arcunara-studio-v03-test");
  assert.ok(!legacy.includes(name), "legacy compose never references the new project name");
});

test("container name is explicit and disjoint from legacy references", () => {
  const name = /container_name:\s*(\S+)\s*/.exec(compose)?.[1];
  assert.equal(name, "arcunara-studio-api-v03-test");
  assert.ok(!legacy.includes(name));
});

test("host ports are loopback-only and disjoint between stacks", () => {
  const mine = hostPorts(compose);
  const theirs = hostPorts(legacy);

  assert.deepEqual([...mine].sort(), [28088, 28089]);
  assert.deepEqual([...theirs].sort(), [18088, 18089]);
  assert.equal(mine.intersection(theirs).size, 0);

  // No non-loopback binding has slipped in.
  const others = /"(\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):\d+:\d+"/.exec(
    compose.replace(/"127\.0\.0\.1:\d+:\d+"/g, "")
  );
  assert.equal(others, null);
});

test("data and token volumes are stack-local relative paths", () => {
  // Strip comments first — the header comment mentions the legacy directory
  // only to document that it is never touched.
  const code = compose
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  assert.match(code, /- \.\/data:\/app\/data$/m);
  assert.match(code, /- \.\/secrets\/api_token:\/run\/secrets\/api_token:ro$/m);
  assert.ok(!code.includes("/opt/arcunara-studio-dev"), "never mounts the legacy deployment dir");
  assert.ok(!code.includes("legacy-v02"));
});

test("no host networking and hardened runtime preserved", () => {
  assert.doesNotMatch(compose, /network_mode:\s*(")?host(")?\s*$/m);
  assert.match(compose, /user: node/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /mem_limit: 192m/);
  assert.match(compose, /pids_limit: 64/);
  assert.match(compose, /healthcheck:/);
});

test("workbench preview base URL is wired to the host-mapped port", () => {
  assert.match(
    compose,
    /ARCU_PREVIEW_PUBLIC_BASE_URL=\$\{ARCU_PREVIEW_PUBLIC_BASE_URL:-http:\/\/127\.0\.0\.1:28089\}/
  );
});
