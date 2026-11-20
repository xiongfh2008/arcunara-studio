// RC21 visual deployment preflight: no Docker or VPS required.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
const base=fileURLToPath(new URL("../",import.meta.url));
const read=rel=>readFileSync(path.join(base,rel),"utf8");
const compose=read("infra/rc21-preview/compose.yaml");
const current=read("infra/docker/compose.yaml");
const legacy=read("legacy-v02/compose.yaml");
const dockerfile=read("infra/docker/Dockerfile");
function getPorts(source) {
  return [...source.matchAll(/"127\.0\.0\.1:(\d+):(\d+)"/g)].map(x=>Number(x[1]));
}
function verify(condition,message) {
  if(!condition)throw new Error("RC21 preflight failed: "+message);
  console.log("ok  "+message);
}
const name=compose.match(/^name:\s*(\S+)\s*$/m)?.[1];
const other=new Set([...getPorts(current),...getPorts(legacy)]);
const ports=getPorts(compose);
verify(name==="arcunara-rc21-preview","dedicated compose project name");
verify(!current.includes(name)&&!legacy.includes(name),"no existing compose project collision");
verify(ports.length===2&&ports.includes(29088)&&ports.includes(29089),
  "only two documented loopback ports");
verify(ports.every(port=>!other.has(port)),"RC21 ports avoid legacy and v0.3");
verify(!/network_mode:\s*host/.test(compose),"not host network mode");
verify(/read_only:\s*true/.test(compose)&&/user:\s*node/.test(compose),
  "non-root read-only container");
verify(/cap_drop:\s*\n\s*-\s*ALL/.test(compose)&&
  /no-new-privileges:true/.test(compose),"restricted Linux capabilities");
verify(compose.includes("./data:/app/data")&&
  compose.includes("./secrets/api_token:/run/secrets/api_token:ro"),
  "RC21-owned data volume and token");
verify(!compose.split("\n").filter(x=>!x.trim().startsWith("#")).join("\n")
  .includes("/opt/arcunara-studio-dev"),"never mounts older project");
verify(compose.includes("ARCU_TEAM_ACCESS_ENABLED=0")&&
  compose.includes("ARCU_MEMBER_LOGIN_ENABLED=0"),"browser login modes disabled");
verify(compose.includes("ARCU_AI_ENABLED=${ARCU_AI_ENABLED:-0}"),
  "AI paid API calls disabled by default");
verify(dockerfile.includes("COPY packages/rp-converter ./packages/rp-converter"),
  "RP converter modules bundled in Docker image");
console.log("RC21 preflight passed.");
