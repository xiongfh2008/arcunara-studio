# Arcunara CLI

将本地 AI 生成的 HTML 原型一键发布到 Arcunara Studio。零第三方依赖，纯 Node.js（≥24）。

# Arcunara CLI (English below)

Publish AI-generated HTML prototypes from your local machine to an Arcunara
Studio instance with one command. Zero third-party dependencies, plain
Node.js (≥24).

---

## 运行方式 / Running

```bash
# Windows / Linux / macOS（仓库根目录）
node packages/cli/arcunara.mjs <command> [args]

# 或使用 npm script
npm run cli -- <command> [args]
```

下文用 `arcunara` 代替完整命令；请按上面方式替换。

---

## 安全模型 / Security model

- **项目级部署密钥（dpk_）**：只能向绑定的项目上传新版本、查询该项目状态与配额。不能创建分享链接、不能修改项目设置、不能回滚版本、不能访问管理员接口。
- **密钥只通过环境变量读取**：`ARCU_DEPLOY_KEY`（部署密钥）与 `ARCU_API_TOKEN`（管理员，仅 rollback 需要）。CLI 不提供 `--token` 参数（避免进入 shell 历史），`.arcunara.json` 中**禁止**保存任何密钥（CLI 检测到会直接报错）。
- **服务端只保存密钥哈希**（SHA-256），完整密钥仅在工作台创建时展示一次。验证使用时间恒定比较。
- **内容指纹幂等**：每次发布计算 SHA-256 内容指纹并随上传提交；服务器发现与当前版本内容相同则跳过建版。重复执行 `deploy` 不会产生重复版本，断线重试安全。
- **不上传机密**：目录打包自动排除所有点文件（`.git`、`.env`、`.arcunara.json`…）、密钥文件（`*.pem`、`*.key`、`id_rsa*`…）与开发目录（`node_modules`、`.venv`…）；拒绝符号链接与非常规文件。
- **当前限制**：Arcunara 测试实例仅监听 VPS 回环地址。CLI 需要先建立 SSH 隧道，例如：
  `ssh -L 28088:127.0.0.1:28088 -L 28089:127.0.0.1:28089 root@<server>`。隧道断开时 CLI 会明确报错，不会静默降级。

---

## 命令 / Commands（中文）

### `arcunara init`

将当前目录与远端项目关联，写入 `.arcunara.json`（projectId / apiBase / previewBase / uploadDir / buildCommand，无敏感字段）。

```bash
arcunara init --project <uuid> --api http://127.0.0.1:28088 --preview-base http://127.0.0.1:28089
```

TTY 下省略参数会交互式询问。

### `arcunara deploy [path]`

发布原型。支持三种源：

- 单个 `.html` / `.htm` 文件（原样上传）
- `.zip` 文件（原样上传）
- 目录（自动打包 ZIP，保留相对路径与中文文件名）

```bash
arcunara deploy ./dist
arcunara deploy ./prototype.zip --project <uuid> --api http://127.0.0.1:28088
arcunara deploy --build            # 先执行 .arcunara.json 里的 buildCommand，构建成功才上传
```

成功输出：项目 ID、新版本号、预览地址、文件数与大小。内容未变化时输出「未创建新版本」。上传失败不会改变当前版本。

### `arcunara status`

显示项目名称、ID、当前版本、文件统计、更新时间与预览地址。

### `arcunara versions`

列出全部历史版本（含当前版本标识）。

### `arcunara rollback <version> [--yes]`

回滚到指定版本。**需要管理员 Token（ARCU_API_TOKEN）**——部署密钥无权回滚。交互式终端二次确认；自动化场景必须显式 `--yes`。

```bash
arcunara rollback 2 --yes
```

### `arcunara watch [dir]`

监视目录，文件变化稳定后自动发布新版本。

```bash
arcunara watch ./dist
arcunara watch ./dist --debounce 1200 --settle 800
```

- debounce 合并连续写入；settle 期间内容指纹两次采样一致才发布（避免半写文件）
- 同一时间只有一个上传任务；内容相同自动跳过
- 失败重试 ≤3 次（指数退避），当前版本不受影响；Ctrl+C 干净退出

---

## Commands (English)

- `init` — associate the current directory with a remote project (`.arcunara.json`, no secrets).
- `deploy [path]` — publish a single HTML file, a ZIP, or a directory (auto-zipped, UTF-8 names preserved). Content-hash idempotency prevents duplicate versions. Failed uploads never change the current version.
- `status` — project name/id, current version, sizes, preview URL.
- `versions` — list version history.
- `rollback <n> [--yes]` — admin-token only; `--yes` required for non-interactive runs.
- `watch [dir]` — auto-publish on stable changes (debounce + stability sampling + single-flight + bounded retries).

Credentials are read from the environment only: `ARCU_DEPLOY_KEY` (project deploy key, `dpk_...`) and `ARCU_API_TOKEN` (admin; required for rollback). The test instance is loopback-only — an SSH tunnel must be up; errors say so explicitly.

---

## AI 工具集成 / AI tool integration

Codex / Trae / Claude Code 等工具无需任何插件，直接让 AI 在完成原型修改后执行：

```bash
ARCU_DEPLOY_KEY=dpk_... node packages/cli/arcunara.mjs deploy ./dist
```

提示词模板、Node.js 项目与静态原型示例见 `docs/ai-integration.md` 与 `examples/static-prototype/`。
