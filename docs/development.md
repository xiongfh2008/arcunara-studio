# 开发说明

本文档描述 `apps/api`（v0.2.0 基线）的运行方式、环境变量、API 行为规范与工程约定。

## 环境要求

- Node.js **24**（本项目零第三方依赖，仅使用 Node 内置模块）
- npm 仅用于脚本编排：`npm start` / `npm test` / `npm run lint`

## 环境变量

`apps/api/server.mjs` 在启动时读取以下变量。**全部默认值与已验证的 VPS v0.2.0 部署一致**，因此 Docker 中不设置任何变量即可复现原始行为。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ARCU_DATA_DIR` | `/app/data` | 项目数据目录（`{uuid}/index.html` + `meta.json`），启动时自动创建 |
| `ARCU_TOKEN_FILE` | `/run/secrets/api_token` | Bearer Token 文件路径，启动时一次性读取并 trim；**为空则拒绝启动** |
| `ARCU_API_PORT` | `3000` | API 监听端口（`0` 表示随机端口） |
| `ARCU_PREVIEW_PORT` | `3001` | 预览服务监听端口（`0` 表示随机端口） |
| `ARCU_API_HOST` | `0.0.0.0` | API 绑定地址；本地开发建议 `127.0.0.1` |
| `ARCU_PREVIEW_HOST` | `0.0.0.0` | 预览服务绑定地址；本地开发建议 `127.0.0.1` |

非法端口值（非整数或超出 0–65535）会在启动时直接报错退出。

## API 行为规范（v0.2.0，与 legacy 逐字兼容）

两个 HTTP 服务：API（默认 3000）与预览（默认 3001）。

### API 服务

| 请求 | 行为 |
| --- | --- |
| `GET /health` | 公开，200 `{ok:true, service:"arcunara-studio-dev", version:"0.2.0"}`，响应含 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` |
| 其他任何非 `/api/` 路径 | 一律 401 `{"error":"Unauthorized"}`（即使携带有效 Token） |
| `/api/*` 无 Token / Token 错误 | 401 `{"error":"Unauthorized"}`（timing-safe 比较，`Bearer ` 前缀大小写敏感） |
| `GET /api/projects` | 200 `{projects:[{id,name,createdAt}]}`，读取数据目录下 UUID 命名目录的 `meta.json`（损坏条目静默跳过），按 `createdAt` 倒序 |
| `POST /api/projects` | 201 `{id,name,createdAt,previewPath:"/p/{id}/"}` |
| 其他 `/api/*` 路由 | 404 `{"error":"Not Found"}` |
| 未捕获异常 | 500 `{"error":"Internal error"}` |

`POST /api/projects` 校验顺序：

1. `Content-Type` 必须以 `application/json` 开头（允许 charset 后缀），否则 415 `{"error":"Use application/json"}`
2. 请求体累计超过 **256 KiB** → 413 `{"error":"Request too large"}`
3. JSON 解析失败 → 400 `{"error":"Invalid JSON"}`
4. `name` 必须为字符串，trim 后非空且长度 ≤ 100；`html` 必须为字符串，包含 `<html`（大小写不敏感）且字节数 ≤ 180000；否则 400 `{"error":"Invalid name or HTML"}`

写入：UUID 目录（mode 0700），`index.html` 与 `meta.json` 以 `wx` 标志 + mode 0600 写入；写入失败时回滚删除目录。

### 预览服务

| 请求 | 行为 |
| --- | --- |
| `GET /p/{uuid}/` | 200 `text/html; charset=utf-8`，返回该项目的 `index.html` |
| 其他（方法错误、路径无尾斜杠、非法 UUID、项目不存在） | 404 纯文本 `Not Found` |

预览响应固定头：`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`，以及 CSP：
`sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`

## 测试

```bash
npm test        # 全部集成测试
npm run lint    # node --check 全部项目 .mjs（apps/scripts/tests）
```

- 测试以**子进程**方式启动真实的 `apps/api/server.mjs`（与 Docker 内运行方式一致），通过 stdout 解析实际监听端口。
- 数据目录与 Token 文件位于 `os.tmpdir()` 下的独立临时目录，测试结束自动清理；不触碰 VPS 数据、生产端口或仓库内任何持久数据。
- 绑定 `127.0.0.1` + 端口 `0`（随机端口），可在 CI 与本地并行运行。
- 覆盖用例：健康检查、鉴权（无/错/对 Token、非 API 路径行为）、创建成功、非法 payload（400 × 7 类）、JSON/Content-Type 错误（400/415）、413 超限、256KiB 与 180000 字节边界、列表排序、预览头与内容一致性、磁盘持久化一致性、预览 404 × 5 类、未知 API 路由 404。

## 迁移说明（相对 legacy-v02/server.mjs）

行为完全兼容，仅有三处刻意差异（不影响任何 API 行为）：

1. **配置环境变量化**：数据目录、Token 文件、端口、绑定地址可通过 `ARCU_*` 变量覆盖，默认值与 legacy 相同。
2. **启动期校验**：Token 文件为空时拒绝启动（legacy 会把空 Token 当作"未携带 Authorization 头即可通过"的安全漏洞）；端口值非法时明确报错。
3. **启动日志包含实际端口**（`Arcunara API v0.2 started on port 3000`），以便测试解析随机端口。

## 工程约定

- `legacy-v02/` 冻结：禁止修改，仅作回滚参考与行为对照。
- 依赖策略：保持零第三方依赖；确需引入时先在 issue 中说明理由。
- Git：`main` 为主分支，功能开发使用 feature 分支；禁止 `git push --force`；提交前自查不得包含 Token、密钥、`.env`、用户数据、日志与临时文件（`.gitignore` 已覆盖 `data/`、`secrets/`、`.env*`、`*.log`、`tmp/`）。
- CI：GitHub Actions 仅运行 `npm run lint` 与 `npm test`，不做任何自动部署。
