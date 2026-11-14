# Arcunara Studio

面向全球用户的 HTML 原型托管与 HTML → Axure RP11 原生可编辑文件（`.rp`）转换平台。

- **v0.2.0（当前）**：HTML 静态项目托管 MVP —— 创建、预览、项目列表、本地持久化，已在 VPS Docker 环境完成功能验证。
- **后续规划**：ZIP 项目上传、版本管理、HTML → `.rp` 转换（`packages/rp-converter`）、CLI / Codex / Cursor / Trae Skill、浏览器插件。

## 工程流程

**Codex 本地开发 → GitHub 代码管理 → VPS Docker 测试部署 → 验收后发布。**

禁止在 VPS 上直接开发业务源码；`legacy-v02/` 是已验证的 v0.2.0 基线，保持冻结，仅作回滚参考。

## 目录结构

```text
arcunara-studio/
├── apps/
│   ├── api/               # v0.2.0 API 服务（迁移自 legacy-v02，零依赖 Node.js 24）
│   │   └── server.mjs
│   └── web/               # 前端（未实现，占位）
├── packages/
│   ├── shared/            # 共享工具（未实现，占位）
│   └── rp-converter/      # HTML → .rp 转换器（未实现，占位）
├── infra/
│   └── docker/            # 独立开发环境 Compose 配置（端口 28088/28089）
│       ├── compose.yaml
│       ├── data/          # 运行时数据（gitignored，自动/手动创建）
│       └── secrets/       # api_token 等（gitignored，手动创建）
├── tests/
│   └── api.test.mjs       # 零依赖黑盒集成测试（node:test）
├── scripts/
│   └── syntax-check.mjs   # npm run lint：node --check 全部 .mjs
├── docs/
│   ├── development.md     # 开发说明（环境变量、API 行为规范、测试）
│   └── deployment.md      # 部署与回滚说明（独立开发环境）
├── legacy-v02/            # 已验证 v0.2.0 原始文件（冻结，禁止修改）
├── .github/
│   └── workflows/ci.yml   # GitHub Actions：仅 lint + test，不自动部署
├── .env.example
├── package.json
└── README.md
```

## 快速开始

### 本地运行（Node.js ≥ 24，零第三方依赖）

```bash
# 1. 准备 Token 文件（内容即 Bearer Token，勿提交）
mkdir -p .local/secrets
openssl rand -hex 32 > .local/secrets/api_token

# 2. 启动（Git Bash / Linux / macOS）
ARCU_DATA_DIR=.local/data \
ARCU_TOKEN_FILE=.local/secrets/api_token \
ARCU_API_HOST=127.0.0.1 \
ARCU_PREVIEW_HOST=127.0.0.1 \
npm start
```

Windows PowerShell：

```powershell
$env:ARCU_DATA_DIR = ".local/data"
$env:ARCU_TOKEN_FILE = ".local/secrets/api_token"
$env:ARCU_API_HOST = "127.0.0.1"
$env:ARCU_PREVIEW_HOST = "127.0.0.1"
npm start
```

- API：`http://127.0.0.1:3000/health`（无需鉴权）
- 项目接口：`http://127.0.0.1:3000/api/projects`（`Authorization: Bearer <token>`）
- 预览：`http://127.0.0.1:3001/p/{id}/`

也可复制 `.env.example` 为 `.env` 后使用 `node --env-file=.env apps/api/server.mjs`。

### Docker 独立开发环境

```bash
# 1. 准备 Token（uid 1000 = 容器内 node 用户）
cd infra/docker
mkdir -p data secrets
openssl rand -hex 32 > secrets/api_token
chmod 600 secrets/api_token
sudo chown -R 1000:1000 data secrets

# 2. 启动
docker compose -f infra/docker/compose.yaml up -d

# 3. 验证
curl http://127.0.0.1:28088/health
```

详见 [docs/deployment.md](docs/deployment.md)。该环境使用 28088/28089 端口与项目名 `arcunara-studio-dev`，与现有 VPS 开发部署（18088/18089）互不干扰，不会修改 `/opt/arcunara-studio-dev`。

## 测试

```bash
npm test        # node:test 集成测试（临时目录 + 随机端口，不触碰任何持久数据）
npm run lint    # node --check 全部项目 .mjs 文件
```

测试覆盖：健康检查、鉴权（无/错/对 Token）、项目创建与校验（400/413/415）、
项目列表与排序、HTML 预览与 CSP 头、持久化一致性、404 行为、请求体与 HTML 大小边界。

## 文档

- [docs/development.md](docs/development.md) — 环境变量、API 行为规范、测试与工程约定
- [docs/deployment.md](docs/deployment.md) — Docker 部署、验收与回滚步骤
- `legacy-v02/` — v0.2.0 已验证原始文件（冻结）

## v0.3.0 计划（暂不实现）

ZIP 项目上传、项目版本管理、`packages/rp-converter`（HTML → Axure RP11 `.rp`，参考 `D:\AI\zee-rp` 编译器）、CLI 与各 AI 工具 Skill、浏览器插件。
