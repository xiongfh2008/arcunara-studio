// Pre-deployment safety checks for the isolated v0.3.0 test stack.
//
// Validates that infra/docker/compose.yaml cannot collide with any existing
// deployment (in particular the v0.2.0 compose project derived from
// /opt/arcunara-studio-dev):
//   - compose project name must not be the legacy v0.2.0 project name
//   - legacy-v02/compose.yaml must not reference the new project/container
//   - host port sets of both stacks must be disjoint and loopback-bound
//   - data/token volumes must be stack-local relative paths (never the
//     legacy deployment directory)
//   - no host networking
//
// Run with:  npm run preflight   (also part of CI)
// Exit code 1 on any violation.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(rel) {
  try {
    return readFileSync(pathToFileURL(repoRoot + rel), "utf8");
  } catch (err) {
    return fail(`cannot read ${rel}: ${err.message}`);
  }
}

const problems = [];

function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(label);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

const composePath = "infra/docker/compose.yaml";
const legacyPath = "legacy-v02/compose.yaml";

const compose = read(composePath);
const legacy = read(legacyPath);

// --- compose project name -------------------------------------------------
const nameMatch = /^name:\s*(\S+)\s*$/m.exec(compose);
const projectName = nameMatch ? nameMatch[1] : null;

check("compose declares an explicit project name", Boolean(projectName));
check(
  "project name differs from the v0.2.0 deployment name",
  projectName !== "arcunara-studio-dev",
  `got ${projectName}`
);
check(
  "legacy compose never references the new project name",
  !legacy.includes(projectName ?? "arcunara-studio-v03-test")
);

// --- container names ------------------------------------------------------
const containerMatch = /container_name:\s*(\S+)\s*/.exec(compose);
check(
  "container name is explicit and differs from legacy references",
  Boolean(containerMatch) && !legacy.includes(containerMatch[1]),
  `got ${containerMatch ? containerMatch[1] : "none"}`
);

// --- host ports -----------------------------------------------------------
function hostPorts(text) {
  const ports = [];
  const re = /"127\.0\.0\.1:(\d+):(\d+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ports.push({ host: Number(m[1]), container: Number(m[2]) });
  }
  return ports;
}

const newPorts = hostPorts(compose);
const legacyPorts = hostPorts(legacy);

check("new stack declares 2 loopback port mappings", newPorts.length === 2);
check("legacy stack declares its own loopback mappings", legacyPorts.length === 2);

const newHostPorts = new Set(newPorts.map((p) => p.host));
const legacyHostPorts = new Set(legacyPorts.map((p) => p.host));
const overlap = [...newHostPorts].filter((p) => legacyHostPorts.has(p));

check("host ports do not overlap with the legacy stack", overlap.length === 0, overlap.join(", ") || "disjoint");
check(
  "new stack uses the documented test ports",
  newHostPorts.size === 2 &&
    newHostPorts.has(28088) &&
    newHostPorts.has(28089) &&
    newPorts.every((p) => p.container === 3000 || p.container === 3001)
);
check(
  "legacy stack keeps its own ports",
  legacyHostPorts.has(18088) && legacyHostPorts.has(18089)
);
check(
  "no non-loopback port bindings",
  !/"(\d+\.\d+\.\d+\.\d+|\[[^\]]+\]):\d+:\d+"/.test(compose.replace(/"127\.0\.0\.1:\d+:\d+"/g, ""))
);

// --- volumes / isolation --------------------------------------------------
const composeCode = compose
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

check(
  "data and token volumes are stack-local relative paths",
  compose.includes("- ./data:/app/data") && compose.includes("- ./secrets/api_token:/run/secrets/api_token:ro")
);
check(
  "new stack never references the legacy deployment directory",
  !composeCode.includes("/opt/arcunara-studio-dev") && !composeCode.includes("legacy-v02")
);
check("no host networking", !/network_mode:\s*(")?host(")?\s*$/m.test(composeCode));

// --- workbench preview URL wiring ------------------------------------------
check(
  "compose configures the browser-facing preview base URL",
  /ARCU_PREVIEW_PUBLIC_BASE_URL=\$\{ARCU_PREVIEW_PUBLIC_BASE_URL:-http:\/\/127\.0\.0\.1:28089\}/.test(compose)
);

if (problems.length > 0) {
  console.error(`\nPreflight failed: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log("\nPreflight passed: compose isolation is intact.");
