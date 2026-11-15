# Arcunara Studio

面向全球用户的 AI 原型转换与托管 SaaS：HTML/ZIP 原型一键托管、更新与分享；后续支持 HTML → Axure RP11 原生 `.rp` 转换、CLI 与各 AI 工具 Skill。

- **v0.3.0（RC4 预览体验开发中）**：HTML/ZIP 托管、版本回滚、Axure 多页面安全导航、页面搜索与画布宽度切换（桌面/平板/手机）。
- **v0.2.0**：已在 VPS Docker 环境完成真实 HTTP 验收的托管基线（`legacy-v02/` 冻结保存）。
- **后续规划**：HTML → `.rp` 转换（`packages/rp-converter`）、用户系统与访问控制、CLI / Codex / Cursor / Trae Skill、浏览器插件。

## 工程流程

**Codex 本地开发 → GitHub 代码管理 → VPS Docker 测试部署 → 验收后发布。**

禁止在 VPS 上直接开发业务源码；`legacy-v02/` 保持冻结，仅作回滚参考。

## 目录结构

```text
arcunara-studio/
├── apps/
│   ├── api/               # v0.3.0 托管服务（Node.js 24，零框架）
│   │   ├── server.mjs     # 入口
│   │   ├── console.html   # 内部工作台（GET /console）
│   │   └── lib/           # config/auth/store/multipart/zipextract/entrypoint/
│   │                      # staging/routes/preview/pathsafety/httputil
│   └── web/               # 前端（未实现，占位）
├── packages/
│   ├── shared/            # 共享工具（未实现，占位）
│   └── rp-converter/      # HTML → .rp 转换器（未实现，占位）
├── infra/
│   └── docker/            # Dockerfile + 独立开发环境 compose（28088/28089）
├── tests/                 # Node.js 集成与回归测试（node:test）+ helpers
├── scripts/syntax-check.mjs
├── docs/
│   ├── development.md         # 开发说明（API 规范、环境变量、结构）
│   ├── deployment.md          # 部署与回滚（含 v0.2.0 兼容性）
│   ├── DEVELOPMENT_PROGRESS.md# 开发进度（按阶段）
│   └── KNOWN_LIMITATIONS.md   # 已知限制与安全边界
├── legacy-v02/            # 已验证 v0.2.0 原始文件（冻结）
├── .github/workflows/ci.yml   # CI：npm ci + lint + test（不部署）
├── .env.example
└── package.json
```

## 快速开始

### 本地运行（Node.js ≥ 24）

```bash
npm install

mkdir -p .local/secrets
openssl rand -hex 32 > .local/secrets/api_token

ARCU_DATA_DIR=.local/data \
ARCU_TOKEN_FILE=.local/secrets/api_token \
ARCU_API_HOST=127.0.0.1 \
ARCU_PREVIEW_HOST=127.0.0.1 \
npm start
```

- API：`http://127.0.0.1:3000`（`/health`、`/api/projects`、`/console`）
- 预览：`http://127.0.0.1:3001/p/{id}/`（Axure ZIP 自动展示安全页面目录，支持中文搜索和 1440/768/390 px 画布预览；预览宽度不等同真实设备模拟）

### Docker 独立开发环境

```bash
cd infra/docker
mkdir -p data secrets && openssl rand -hex 32 > secrets/api_token
sudo chown -R 1000:1000 data secrets
docker compose -f infra/docker/compose.yaml up -d --build
curl http://127.0.0.1:28088/health   # {"ok":true,...,"version":"0.3.0"}
```

详见 [docs/deployment.md](docs/deployment.md)。与现有 VPS 部署（18088/18089）完全隔离，不触碰 `/opt/arcunara-studio-dev`。

## 测试

```bash
npm test        # 全量集成与回归测试：上传引擎 / ZIP 安全 / 预览 / 版本回滚 / 工作台 / Axure 导航
npm run lint    # node --check 全部 .mjs
```

测试以子进程启动真实服务，使用临时目录与随机端口，不触碰任何持久数据。

## 文档

- [docs/development.md](docs/development.md) — API 规范、环境变量、模块结构
- [docs/deployment.md](docs/deployment.md) — 部署、验收、回滚（含 v0.2.0 兼容性说明）
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — 已知限制与安全边界（公网部署前必读）
- [docs/DEVELOPMENT_PROGRESS.md](docs/DEVELOPMENT_PROGRESS.md) — 按阶段的开发进度

## v0.3.0 之后计划（尚未实现）

用户系统与访问控制、项目删除、`packages/rp-converter`（HTML → Axure RP11 `.rp`，参考 `D:\AI\zee-rp`）、CLI 与 AI 工具 Skill、浏览器插件、Playwright CI 浏览器测试。
