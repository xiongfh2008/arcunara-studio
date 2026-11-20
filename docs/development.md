# 开发说明

本文档描述 Arcunara Studio v0.3.0（P0 HTML 托管 MVP）的运行方式、环境变量、API 规范与工程约定。

## 环境要求

- Node.js **24**；运行依赖仅 `busboy`（流式 multipart）与 `yauzl`（流式 ZIP），其余为 Node 内置模块
- npm 脚本：`npm start` / `npm test` / `npm run lint`

## 代码结构

```text
apps/api/
├── server.mjs          # 入口：配置加载、store 初始化、双 HTTP 服务
├── console.html        # 内部工作台（GET /console，单文件、零依赖）
└── lib/
    ├── config.mjs      # 环境变量与上传限额
    ├── httputil.mjs    # JSON 响应 / 错误封装（error + code）/ 流式限额读体
    ├── auth.mjs        # timing-safe Bearer 鉴权
    ├── pathsafety.mjs  # 路径段校验 / safeJoin / 碰撞键
    ├── store.mjs       # 项目与版本存储（原子发布、进程内写锁、legacy 兼容）
    ├── multipart.mjs   # 流式 multipart 解析（busboy）与实时限额
    ├── zipextract.mjs  # 安全 ZIP 解压（yauzl，流式，逐条目配额）
    ├── entrypoint.mjs  # 入口识别与包装目录重定位
    ├── staging.mjs     # 上传 → 校验后的 staging 目录
    ├── routes.mjs      # API 路由 + /console
    └── preview.mjs     # 预览服务（路径安全、MIME 白名单、sandbox CSP）
```

数据布局：`{store}/{uuid}/meta.json` + `{store}/{uuid}/versions/{n}/...`；
v0.2.0 旧项目（根目录 `index.html` + `meta.json`）按"隐式 v1（legacy-root）"读取与服务，文件永不移动或删除。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ARCU_DATA_DIR` | `/app/data` | 数据目录，启动自动创建 |
| `ARCU_TOKEN_FILE` | `/run/secrets/api_token` | Bearer Token 文件，为空则拒绝启动 |
| `ARCU_API_PORT` / `ARCU_API_HOST` | `3000` / `0.0.0.0` | API 监听（`0` = 随机端口） |
| `ARCU_PREVIEW_PORT` / `ARCU_PREVIEW_HOST` | `3001` / `0.0.0.0` | 预览监听（内部地址，与浏览器访问地址解耦） |
| `ARCU_LOCAL_AUTO_LOGIN` | `0` | **仅本机开发**：设为 `1` 后，只允许 API 与预览都绑定 `127.0.0.1`，本机访问 `/console` 将自动建立 HttpOnly 临时会话，不再手动输入 Token。VPS/Docker 保持 `0`；即使启用，也仍需合法 `ARCU_TOKEN_FILE` 启动服务。 |
| `ARCU_PREVIEW_PUBLIC_BASE_URL` | 未设置 | 工作台预览链接的浏览器侧基址（如 Docker 宿主映射 `http://127.0.0.1:28089` 或未来独立预览域名 `https://preview.example.com`）；未设置时链接使用同主机 + 实际监听端口；非法值（非 http/https、含凭据/查询串）拒绝启动 |
| `ARCU_MAX_ZIP_BYTES` | 20 MiB | ZIP 压缩大小上限 |
| `ARCU_MAX_EXTRACT_BYTES` | 80 MiB | 解压总量上限 |
| `ARCU_MAX_FILE_BYTES` | 20 MiB | 解压单文件上限 |
| `ARCU_MAX_HTML_BYTES` | 2 MiB | 单 HTML 上限 |
| `ARCU_MAX_FILES` | 2000 | 文件数上限 |
| `ARCU_MAX_DEPTH` | 20 | 目录深度上限 |
| `ARCU_MAX_PATH_LENGTH` | 256 | 条目路径长度上限 |
| `ARCU_MAX_DESCRIPTION_CHARS` | 1000 | 描述长度上限 |
| `ARCU_MAX_UPLOAD_BODY_BYTES` | 24 MiB | multipart 请求体总量 |
| `ARCU_MAX_JSON_BODY_BYTES` | 256 KiB | legacy JSON 请求体上限（与 v0.2.0 一致） |

所有限额在**处理过程中**生效（流式/逐条目），不是事后检查。

## Windows 本地免输入 Token（仅开发使用）

当前工作台采用管理员 API Token，并非正式多用户登录。为避免每次刷新都手动粘贴 Token，本地可显式开启自动连接：

```powershell
cd D:\\Project\\arcunara-studio
$env:ARCU_DATA_DIR = ".local/data"
$env:ARCU_TOKEN_FILE = ".local/secrets/api_token"
$env:ARCU_API_HOST = "127.0.0.1"
$env:ARCU_PREVIEW_HOST = "127.0.0.1"
$env:ARCU_API_PORT = "3100"
$env:ARCU_PREVIEW_PORT = "3101"
$env:ARCU_LOCAL_AUTO_LOGIN = "1"
npm start
```

浏览器访问 `http://127.0.0.1:3100/console` 即自动连接。在此**仅限本机**的自动登录模式下，上传配额还会采用已验证的大型 Axure ZIP 配置：**5,000 个文件/目录、单 HTML 8 MiB、解压总量 128 MiB**，但 ZIP 压缩包仍为 20 MiB；`ARCU_MAX_FILES`、`ARCU_MAX_HTML_BYTES`、`ARCU_MAX_EXTRACT_BYTES` 的显式设置始终优先。默认服务模式及 VPS 不受影响。工作台的上传弹窗以 `/api/limits` 返回的配额为准。本地开发模式要求已有的非空 Token 文件，但不将其返回到浏览器。服务器只在本机请求 `/console` 时签发独立的、仅 `/api` 使用的临时会话 Cookie（`HttpOnly; SameSite=Strict`），每次服务重启失效；修改数据的请求还需同源 `Origin` 和自定义请求头。默认关闭，非 loopback 监听时拒绝启动。**禁止在 VPS、共享主机或经 SSH 隧道对不受信任用户开放的实例上启用此选项。**

`npm test` 的测试服务器会强制禁用继承的本地自动登录配置，仅明确测试该功能的用例会打开，防止影响原有 Bearer Token 鉴权回归测试。

## API 规范

鉴权：除 `/health` 与 `/console` 外，所有路径需要 `Authorization: Bearer <token>`（timing-safe 比较，`Bearer ` 前缀大小写敏感）。非 `/api/` 路径即使携带有效 Token 也返回 401（v0.2.0 行为保留）。

| Method & Path | 用途 | 成功 | 主要错误 |
| --- | --- | --- | --- |
| `GET /health` | 健康检查（公开） | 200 `{ok,service,version}` | — |
| `GET /console` | 内部工作台页面（公开，无密钥内容） | 200 HTML | — |
| `GET /api/limits` | 当前上传配额（供工作台提示用） | 200 `{limits:{...}}` | 401 |
| `GET /api/projects` | 项目列表（按 createdAt 倒序） | 200 `{projects:[{id,name,createdAt,updatedAt,currentVersion,fileCount,totalSize,description?}]}` | 401 |
| `POST /api/projects` | 创建项目（JSON 或 multipart） | 201 `{id,name,createdAt,updatedAt,currentVersion,fileCount,totalSize,entryPoint,previewPath,versionCount,description?}` | 401 / 415 / 400 / 413 / 500 |
| `GET /api/projects/{id}` | 项目详情 | 200 详情视图 | 404 `PROJECT_NOT_FOUND` |
| `POST /api/projects/{id}/versions` | 上传新版本（multipart 文件或 JSON `{html}`） | 201 `{projectId,version,createdAt,fileCount,totalSize,entryPoint,previewPath,currentVersion}` | 404 / 400 / 413 / 415 |
| `GET /api/projects/{id}/versions` | 版本历史（升序 + isCurrent） | 200 `{projectId,versions:[...]}` | 404 |
| `GET /api/projects/{id}/export?version=N` | RC17 管理员导出当前版本（省略 N）或指定历史版本为 ZIP；流式生成，不影响当前版本 | 200 application/zip 附件 | 400 `INVALID_VERSION` / 404 `VERSION_NOT_FOUND` / 409 `PROJECT_TRASHED` / 413 `EXPORT_SIZE_LIMIT` |
| `POST /api/projects/{id}/rollback` | 回滚 `{version:N}`，幂等 | 200 `{projectId,ok,rolledBack,currentVersion,previewPath}` | 404 / 400 `INVALID_VERSION` / `VERSION_NOT_FOUND` |
| `PATCH /api/projects/{id}` | RC5：编辑 `{name?, description?, previewEnabled?}`，UUID 与数据不变 | 200 详情视图 | 404 / 400 `NAME_REQUIRED` / `NAME_TOO_LONG` / `INVALID_PREVIEW_ENABLED` |
| `GET /api/projects/{id}/shares` | RC5：分享列表（无凭证明文） | 200 `{projectId,shares:[{id,createdAt,expiresAt,status,enabled,revoked,accessCount,lastAccessAt,lastAccessStatus}]}` | 404 |
| `POST /api/projects/{id}/shares` | RC5：创建分享 `{expiresAt? \| expiresInHours?}`（均缺省=永久）；`token` 仅创建响应返回一次 | 201 `{...,token:"{shareId}.{secret}"}` | 400 `INVALID_EXPIRES_AT` |
| `POST /api/projects/{id}/shares/{shareId}/revoke` | RC5：撤销（永久） | 200 分享视图（status=revoked） | 404 `SHARE_NOT_FOUND` |
| `POST /api/projects/{id}/shares/{shareId}/enable` / `disable` | RC5：启停分享（撤销后禁止再启用） | 200 分享视图 | 404 / 400 `SHARE_REVOKED` |

JSON 创建（legacy 兼容）：错误信息与 v0.2.0 逐字一致（`Invalid name or HTML` / `Invalid JSON` / `Request too large` / `Use application/json...`）；响应新增字段（additive）。

multipart 创建：字段 `name`（必填 ≤100）、`description`（可选 ≤1000）、`file`（`.html`/`.htm`/`.zip`，单文件）。错误码：`NAME_REQUIRED`、`NAME_TOO_LONG`、`UNSUPPORTED_FILE_TYPE`、`FILE_REQUIRED`、`MULTIPLE_FILES`、`EMPTY_FILE`、`INVALID_HTML_FILE`、`HTML_TOO_LARGE`、`ZIP_TOO_LARGE`、`UPLOAD_TOO_LARGE`。

ZIP 安全错误码：`INVALID_ZIP`、`UNSAFE_ENTRY_PATH`、`SYMLINK_ENTRY`、`UNSUPPORTED_ENTRY_TYPE`、`ENCRYPTED_ENTRY`、`ENTRY_COLLISION`、`TOO_MANY_FILES`、`ENTRY_TOO_LARGE`、`HTML_TOO_LARGE`、`EXTRACT_LIMIT_EXCEEDED`、`DEPTH_LIMIT_EXCEEDED`、`PATH_LIMIT_EXCEEDED`、`EMPTY_ARCHIVE`；入口识别：`NO_HTML_ENTRY`、`ENTRY_NOT_DETERMINED`。

入口识别优先级：① 根 `index.html` → ② 唯一顶层包装目录（内含 `index.html` 时整体重定位）→ ③ 唯一 HTML 文件 → ④ 歧义报错。相对目录结构完整保留，不做扁平化。

### 预览服务（默认 3001，无鉴权）

| 请求 | 行为 |
| --- | --- |
| `GET/HEAD /p/{uuid}/` | 200 入口页（entry ≠ index.html 时 302 到入口）；`/p/{uuid}` 302 补斜杠；RC5：项目 `previewEnabled:false` 时页面与全部资源一律 404 |
| `GET/HEAD /p/{uuid}/{path}` | 200 静态文件（MIME 白名单；未知扩展名 404） |
| `GET/HEAD /s/{shareId}.{secret}/` | RC5：受限分享访问，逐请求校验分享有效性（撤销/停用/过期/凭证错误一律 404）；根文档计一次访问；Axure 项目渲染分享域导航页 |
| `GET/HEAD /s/{shareId}.{secret}/{path}` | RC5：分享内静态资源，同一 Token 全量保护 |
| 其他 | 404 纯文本 `Not Found` |

固定响应头：`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、CSP（sandbox opaque origin + 'self' 子资源 + data: URI，`form-action 'self'`、`base-uri 'none'`、`object-src 'none'`）。逐段 URL 解码与校验、原始 `..`/`.` 段拒绝、点文件与 `meta.json` 永不服务、逐级符号链接检查。安全边界详见 `docs/KNOWN_LIMITATIONS.md`。

## 测试

```bash
npm test        # 全部测试（116 个，约 60s）
npm run lint    # node --check 全部项目 .mjs
npm run preflight   # 部署配置预检（Compose 项目名/端口/卷隔离）
```

测试文件：`api.test.mjs`（回归+详情）、`upload.test.mjs`（上传引擎）、`zipsecurity.test.mjs`（恶意 ZIP）、`preview.test.mjs`（预览与穿越）、`versions.test.mjs`（版本与 legacy）、`console.test.mjs`（工作台与预览链接生成）、`quota.test.mjs`（RC2 大型 Axure ZIP 配额）、`axure.test.mjs`（RC3 Axure 检测与安全预览导航）、`deploy-config.test.mjs`（部署配置回归）。`tests/helpers/` 提供子进程启动 harness 与测试专用 ZIP 构造器。

测试以子进程运行真实服务（临时目录 + 127.0.0.1 + 随机端口），不触碰 VPS 数据或生产端口。浏览器端到端验证以真实 Chromium 完成（记录于 `docs/DEVELOPMENT_PROGRESS.md`）；Playwright 自动化测试为后续待办。

## 工程约定

- `legacy-v02/` 冻结；禁止 `git push --force`；提交前自查密钥/用户数据。
- 依赖策略：仅允许小而成熟的流式库；新增依赖需在 commit/issue 说明理由（busboy/yauzl 选择理由见进度文档）。
- CI：GitHub Actions 仅 `npm ci` + lint + test，不做任何部署。
