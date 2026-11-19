#!/usr/bin/env node
// Arcunara CLI (RC6) — publish AI-generated HTML prototypes from the local
// machine to an Arcunara Studio instance.
//
//   arcunara init                     associate the current directory with a project
//   arcunara deploy [path]            publish a HTML file / ZIP / directory
//   arcunara status                   show project + current version + preview URL
//   arcunara versions                 list versions
//   arcunara rollback <n> [--yes]     roll back (admin token required)
//   arcunara watch [dir]              auto-publish on stable changes
//
// Credentials are read from the environment only (never stored on disk by
// this CLI, never passed as flags to keep them out of shell history):
//   ARCU_DEPLOY_KEY   dpk_... project-scoped deploy key (deploy/status/versions)
//   ARCU_API_TOKEN    admin API token (rollback; also accepted for read-only)
//
// Because the Arcunara test instance is reachable through an SSH tunnel
// (loopback-only ports), the CLI requires the tunnel to be up. Errors say
// so explicitly.

import path from "node:path";
import process from "node:process";
import fsSync from "node:fs";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { saveConfig } from "./lib/config.mjs";
import { apiRequest, ApiError } from "./lib/client.mjs";
import { publishOnce, fmtSize } from "./lib/deploy.mjs";
import { watchDir } from "./lib/watch.mjs";
import { detectStaticOutput, localBuildCommand } from "./lib/publish.mjs";

const USAGE = `Arcunara CLI — AI 原型自动发布

用法:
  arcunara init [--project <id>] [--api <url>] [--preview-base <url>] [--dir <path>]
  arcunara deploy [path] [--project <id>] [--api <url>] [--preview-base <url>] [--build]
  arcunara publish [--project <id>] [--api <url>] [--dir <dist>] [--skip-build]
  arcunara status [--project <id>] [--api <url>] [--preview-base <url>]
  arcunara versions [--project <id>] [--api <url>]
  arcunara rollback <version> [--project <id>] [--api <url>] [--yes]
  arcunara watch [dir] [--project <id>] [--api <url>] [--debounce <ms>]

凭据（仅从环境变量读取，不写入文件或命令行）:
  ARCU_DEPLOY_KEY   项目级部署密钥 dpk_...（deploy/status/versions）
  ARCU_API_TOKEN    管理员 API Token（rollback；也可用于只读命令）

说明:
  当前测试实例仅监听服务器回环地址，需保持 SSH 隧道可用：
  ssh -L 28088:127.0.0.1:28088 -L 28089:127.0.0.1:28089 root@<server>`;

function out(message) {
  process.stdout.write(`${message}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(code);
}

function envToken() {
  const deployKey = (process.env.ARCU_DEPLOY_KEY || "").trim();
  const adminToken = (process.env.ARCU_API_TOKEN || "").trim();

  if (deployKey && !deployKey.startsWith("dpk_")) {
    die("ARCU_DEPLOY_KEY 格式不正确（应以 dpk_ 开头）。");
  }

  return { deployKey, adminToken };
}

function resolveContext(options, { needAdmin = false } = {}) {
  const { deployKey, adminToken } = envToken();

  let config = null;
  try {
    config = loadConfigSync();
  } catch (err) {
    die(err.message);
  }

  const apiBase = options.api || config?.apiBase || process.env.ARCU_API_BASE;

  if (!apiBase) {
    die(
      "缺少 API 地址。请先运行 `arcunara init`，或用 --api 指定，或在 ARCU_API_BASE 环境变量中提供。"
    );
  }

  const projectId = options.project || config?.projectId;

  if (!projectId) {
    die("缺少项目 ID。请先运行 `arcunara init`，或用 --project 指定。");
  }

  const token = needAdmin ? adminToken : deployKey || adminToken;

  if (!token) {
    if (needAdmin) {
      die("回滚需要管理员权限：请设置 ARCU_API_TOKEN 环境变量（管理员 API Token）。");
    }

    die(
      "缺少凭据：请设置 ARCU_DEPLOY_KEY（项目级部署密钥，推荐）或 ARCU_API_TOKEN（管理员 Token）。"
    );
  }

  const previewBase =
    options["preview-base"] ||
    config?.previewBase ||
    process.env.ARCU_PREVIEW_BASE ||
    null;

  return { apiBase, projectId, token, previewBase };
}

function loadConfigSync() {
  try {
    const raw = fsSync.readFileSync(
      path.join(process.cwd(), ".arcunara.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);

    if (parsed.apiToken || parsed.deployKey || parsed.token) {
      die(".arcunara.json 中不允许保存密钥，请改用 ARCU_DEPLOY_KEY 环境变量。");
    }

    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    die(`无法读取 .arcunara.json：${err.message}`);
  }
}

function previewUrl(previewBase, previewPath) {
  return previewBase
    ? `${String(previewBase).replace(/\/+$/, "")}${previewPath}`
    : previewPath;
}

function printDeployResult(view, { previewBase, fileCount, totalSize }) {
  const dedup = Boolean(view.deduplicated);

  out("");
  out(dedup ? "✔ 内容未变化，未创建新版本" : "✔ 发布成功");
  out(`  项目 ID:    ${view.projectId}`);
  out(
    dedup
      ? `  当前版本:   v${view.version}（内容相同，跳过新版本）`
      : `  新版本:     v${view.version}（当前版本 v${view.currentVersion}）`
  );
  out(`  预览地址:   ${previewUrl(previewBase, view.previewPath)}`);

  if (fileCount !== null && fileCount !== undefined) {
    out(`  上传内容:   ${fileCount} 个文件，${fmtSize(totalSize)}`);
  }

  out("");

  if (dedup) {
    out("提示：重新执行 deploy 不会产生重复版本。");
  }
}

async function runBuild(command) {
  if (!command) {
    die("--build 需要配置 buildCommand（.arcunara.json）或 --build-command 参数。");
  }

  out(`执行构建命令: ${command}`);
  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    cwd: process.cwd()
  });

  await new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`构建失败，退出码 ${code}（未上传任何内容）`));
      }
    });
    child.on("error", reject);
  });
}

// ---- commands ------------------------------------------------------------

async function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" },
      "preview-base": { type: "string" },
      dir: { type: "string" }
    },
    strict: true
  });

  let { project, api, "preview-base": previewBase, dir } = values;
  const interactive = process.stdin.isTTY && (!project || !api);

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (!api) {
      api = (await rl.question("API 地址（例如 http://127.0.0.1:28088）: ")).trim();
    }

    if (!project) {
      project = (await rl.question("项目 ID（可在工作台项目详情中复制）: ")).trim();
    }

    rl.close();
  }

  if (!project) {
    die("缺少项目 ID（--project 或交互式输入）。");
  }

  if (!api) {
    die("缺少 API 地址（--api 或交互式输入）。");
  }

  const file = await saveConfig(process.cwd(), {
    projectId: project,
    apiBase: api,
    previewBase: previewBase || null,
    uploadDir: dir || null
  });

  out(`✔ 已写入 ${file}`);
  out("");
  out("下一步:");
  out("  1. 在工作台「项目详情 → 自动部署」创建部署密钥（只展示一次）");
  out("  2. 设置环境变量 ARCU_DEPLOY_KEY（不要写入文件或命令历史）");
  out("  3. 运行 `arcunara deploy ./dist` 发布原型");
}

async function cmdDeploy(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" },
      "preview-base": { type: "string" },
      build: { type: "boolean", default: false },
      "build-command": { type: "string" },
      "source-dir": { type: "string" }
    },
    allowPositionals: true,
    strict: true
  });

  const ctx = resolveContext(values);
  const config = loadConfigSync();
  const source =
    positionals[0] ||
    values["source-dir"] ||
    config?.uploadDir ||
    process.cwd();

  if (values.build || values["build-command"]) {
    await runBuild(values["build-command"] || config?.buildCommand);
  }

  const { view } = await publishOnce({
    apiBase: ctx.apiBase,
    projectId: ctx.projectId,
    token: ctx.token,
    sourcePath: source
  });

  printDeployResult(view, {
    previewBase: ctx.previewBase,
    fileCount: view.deduplicated ? null : view.fileCount ?? null,
    totalSize: view.deduplicated ? null : view.totalSize ?? null
  });

  if (!view.deduplicated && view.currentVersion !== view.version) {
    out(`提示：当前版本为 v${view.currentVersion}（可能存在并发发布）。`);
  }
}

// One-step local static website publication for AI coding assistants.
// Builds locally (when a package.json build script exists), verifies a safe
// index.html output directory, and only then uploads via the existing
// scoped deploy-key/idempotent version pipeline.
async function cmdPublish(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" },
      "preview-base": { type: "string" },
      dir: { type: "string" },
      "skip-build": { type: "boolean", default: false },
      "build-command": { type: "string" }
    },
    strict: true
  });
  const ctx = resolveContext(values);
  const config = loadConfigSync();
  const configuredDir = values.dir || config?.uploadDir || null;
  if (!values["skip-build"]) {
    const command = await localBuildCommand(process.cwd(),
      values["build-command"] || config?.buildCommand);
    if (command) await runBuild(command);
    else out("未配置构建命令，尝试发布现有静态构建目录");
  }
  const sourcePath = await detectStaticOutput(process.cwd(), configuredDir);
  out("静态发布目录: " + sourcePath);
  const { view } = await publishOnce({
    apiBase: ctx.apiBase, projectId: ctx.projectId,
    token: ctx.token, sourcePath
  });
  printDeployResult(view, {
    previewBase: ctx.previewBase,
    fileCount: view.deduplicated ? null : view.fileCount ?? null,
    totalSize: view.deduplicated ? null : view.totalSize ?? null
  });
}

async function cmdStatus(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" },
      "preview-base": { type: "string" }
    },
    strict: true
  });

  const ctx = resolveContext(values);
  const view = await apiRequest(
    ctx.apiBase,
    `/api/projects/${ctx.projectId}`,
    { token: ctx.token }
  );

  out(`项目名称:   ${view.name}`);
  out(`项目 ID:    ${view.id}`);
  out(`当前版本:   v${view.currentVersion}（共 ${view.versionCount} 个版本）`);
  out(`文件数量:   ${view.fileCount}（${fmtSize(view.totalSize)}）`);
  out(`最近更新:   ${view.updatedAt ?? view.createdAt}`);
  out(`预览地址:   ${previewUrl(ctx.previewBase, view.previewPath)}`);
}

async function cmdVersions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" }
    },
    strict: true
  });

  const ctx = resolveContext(values);
  const result = await apiRequest(
    ctx.apiBase,
    `/api/projects/${ctx.projectId}/versions`,
    { token: ctx.token }
  );

  out(`项目 ${result.projectId} 共 ${result.versions.length} 个版本:`);

  for (const v of result.versions) {
    out(
      `  ${v.isCurrent ? "→" : " "} v${String(v.version).padEnd(4)} ${v.createdAt}  ${v.fileCount} 文件  ${fmtSize(v.totalSize)}${v.isCurrent ? "  [当前版本]" : ""}`
    );
  }
}

async function cmdRollback(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" },
      yes: { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: true
  });

  // Accept both "2" and "v2" forms.
  const target = Number(String(positionals[0] ?? "").replace(/^v/i, ""));

  if (!Number.isInteger(target) || target < 1) {
    die("用法: arcunara rollback <版本号>（例如 arcunara rollback 2 或 rollback v2）");
  }

  const ctx = resolveContext(values, { needAdmin: true });

  // Interactive runs confirm twice; automation must pass --yes explicitly.
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      die("非交互环境回滚需要显式确认：追加 --yes 参数。");
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`确认回滚到版本 v${target}？（y/N）`);
    rl.close();

    if (answer.trim().toLowerCase() !== "y") {
      out("已取消。");
      return;
    }
  }

  const result = await apiRequest(ctx.apiBase, `/api/projects/${ctx.projectId}/rollback`, {
    method: "POST",
    token: ctx.token,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ version: target }))
  });

  if (result.rolledBack) {
    out(`✔ 已回滚到 v${result.currentVersion}`);
  } else {
    out(`当前版本已经是 v${result.currentVersion}，未发生变化。`);
  }

  out(`预览地址:   ${previewUrl(ctx.previewBase, result.previewPath)}`);
}

async function cmdWatch(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      api: { type: "string" },
      "preview-base": { type: "string" },
      debounce: { type: "string", default: "800" },
      settle: { type: "string", default: "500" }
    },
    allowPositionals: true,
    strict: true
  });

  const ctx = resolveContext(values);
  const config = loadConfigSync();
  const dir = positionals[0] || config?.uploadDir || process.cwd();
  const debounce = Number(values.debounce);
  const settle = Number(values.settle);

  if (!Number.isFinite(debounce) || debounce < 0 || !Number.isFinite(settle) || settle < 0) {
    die("--debounce / --settle 需要非负整数（毫秒）。");
  }

  const session = await watchDir({
    sourcePath: dir,
    apiBase: ctx.apiBase,
    projectId: ctx.projectId,
    token: ctx.token,
    debounceMs: debounce,
    settleMs: settle,
    attempts: 3
  });

  session.onResult = (view) => {
    out(`预览地址:   ${previewUrl(ctx.previewBase, view.previewPath)}`);
  };

  const shutdown = () => {
    session.close();
    out("");
    out("watch 已停止。");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---- dispatch ------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);

const commands = {
  init: cmdInit,
  deploy: cmdDeploy,
  publish: cmdPublish,
  status: cmdStatus,
  versions: cmdVersions,
  rollback: cmdRollback,
  watch: cmdWatch
};

if (!command || command === "--help" || command === "-h") {
  out(USAGE);
  process.exit(command ? 0 : 1);
}

const handler = commands[command];

if (!handler) {
  die(`未知命令 "${command}"。\n\n${USAGE}`);
}

try {
  await handler(rest);
} catch (err) {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      die(`${err.message}\n请确认 SSH 隧道是否可用（API ${process.env.ARCU_API_BASE ?? ""}）。`);
    } else {
      die(`服务器返回 ${err.status}（${err.code}）：${err.message}`);
    }
  }

  die(err.message);
}
