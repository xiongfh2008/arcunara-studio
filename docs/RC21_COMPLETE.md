# RC21 — AI 原型生成、文件编辑、版本审核与发布

## 交付范围

RC21A 已完成单 HTML 文件编辑。本次补齐 RC21B/C/D：多文件 HTML/CSS/JS/JSON/SVG/TXT/MD 源代码编辑、文件创建及删除、草稿逐行差异预览、沙箱静态预览、一个版本提交多个文件修改、可选 DeepSeek AI 原型生成、AI 草稿人工审核后创建项目、项目公开网站版本钉住与显式重发。

## 使用流程

1. 管理员在工作台使用「AI 生成原型」填写项目名称和 2400 字内页面描述。服务端未启用 AI 时入口隐藏；不会出现模拟 AI 输出。
2. 服务端通过固定 HTTPS DeepSeek Chat Completions 接口调用模型。结果返回浏览器的 HTML 草稿代码与沙箱静态预览；**不会立即创建项目、公开发布或自动调用 Axure 编译**。
3. 审核草稿后点击「审核后创建项目」，走原有项目创建 API；或者将生成 HTML 放进已选单文件原型的编辑器，人工保存为新版本。
4. 选择任一项目 →「编辑项目文件」可浏览真实版本文件树。可编辑 HTML、CSS、JS、MJS、JSON、TXT、MD、SVG 等 UTF-8 文本，图片/字体/视频等文件为只读资源并在下一版本完整保留。可新增或删除文本文件，但不能删除入口 HTML。
5. 编辑后查看逐行文本差异；草稿 iframe 使用 `sandbox=""` 和 CSP，禁用网络请求、JS 和表单，**不等于真实带 JS 的网站预览**。需要真实脚本效果时，保存新版本后使用专门的原型预览服务 `/p/{uuid}/`，该服务保持已有安全模型。
6. 一次操作最多修改 16 个文本文件，单文件最多 180000 UTF-8 字节，内容通过 JSON 接口提交。服务端复制并校验整棵版本目录，编辑时的版本号 + 文件清单 SHA-256 在项目写锁内比较，防止其他人/AI Agent 更新时静默覆盖。
7. 保存产生新版本，旧版 ZIP、历史版本和回滚不变；未更改时不会创建新版本。
8. 单独点击发布才将当前版本发布到公开独立站点；已有公开网站保存修改或回滚后仍显示上次**人工确认**发布的版本，工作台显示当前版本与公开版本的差异及「发布当前版本」。

## API

| 方法与路径 | 权限 | 用途 |
|---|---|---|
| `GET /api/projects/{uuid}/source/files` | admin/editor/viewer | 查看当前版本源文件列表、文本可编辑性、版本/哈希基线 |
| `GET /api/projects/{uuid}/source/file?path=...` | admin/editor/viewer | 查看单个受支持的 UTF-8 文本文件（每份 ≤180000 字节） |
| `POST /api/projects/{uuid}/source/publish` | admin/editor | 提交 `{baseVersion,baseRevision,changes:[{path,content}|{path,remove:true}]}`，创建完整新版本 |
| `GET /api/ai/status` | admin | 查看 AI 功能开关、模型及剩余本进程配额 |
| `POST /api/ai/generate` | admin | 请求 `{prompt}`，返回 HTML 草稿及 token 用量，不写入版本 |
| `PATCH /api/projects/{uuid}` | admin | `{siteEnabled:true}`：显式（重新）发布当前版本；`false`：撤销公开访问 |

AI 提示词不能作为路径或 SSH 命令执行；AI 生成 HTML 的 JS 未在工作台执行。模型输出并不保证无安全问题，用户在公开发布前应人工审核。

## AI 配置与成本边界

```dotenv
ARCU_AI_ENABLED=0
ARCU_AI_API_KEY_FILE=/run/secrets/ai_api_key
```

- 默认 `0`，不调用付费接口，也不生成虚假示例。
- 固定服务商 DeepSeek、固定 HTTPS `https://api.deepseek.com/chat/completions`、固定模型 `deepseek-chat`；密钥必须放在服务器绝对路径的只读文件中，**不要发送到聊天、提交到 GitHub 或写入浏览器 LocalStorage**。
- 单次提示词最多 2400 字，模型最大输出 4096 tokens、45 秒超时，返回 HTML 最多 180000 UTF-8 字节；每服务进程 UTC 日上限 20 次、同时最多 1 次调用。
- AI 请求消耗实际服务商费用，失败请求也占本进程调用额度。当前仅进程内上限，重启会重置计数，尚不是可用于商业公开服务的持久化账单预算/统一限流。
- 不包含模型注册页、模型切换、AI 代码补丁代理、多轮上下文聊天、自动测试生成、付费积分计费或邮箱通知。若要开放给付费用户需另设数据库计量、异步任务和成本上限。

## 权限与兼容

- 管理员可生成 AI 和发布网站；editor 可编辑已授权项目文件；viewer 可浏览但不可保存；部署密钥仅沿用已有专门的版本上传流程，不能读取编辑器文件或产生 AI 费用。
- 旧版 v0.2 项目仍可回滚/上传，`legacy-root` 中 `meta.json` 和 `versions/` 绝不复制到新版本；安全目录扫描拒绝软链接、路径碰撞和元数据伪装。
- 未发布项目保持 RC13 原来的 `siteEnabled:false` 数据结构；旧已发布项目第一次新建草稿时把旧公开版本钉住，避免静默公开新草稿。
- 本轮不触碰已运行的 VPS 容器及原有项目数据。

## 发布前验证

`npm run lint`、`npm run preflight`、`npm run preflight:rc21` 与 `npm test` 必须全部通过；还需真实 Chrome/Edge 在 1440/1024/768/390 宽度确认文件树滚动、源码编辑、未保存提示、草稿沙箱、AI 服务可用性、模型真实费用、版本保存与回滚。真实 DeepSeek API 调用因 CI 不保存密钥，只能由用户在隔离测试环境启用后验证。

独立部署脚本及网络限制详见 `docs/RC21_PREVIEW_DEPLOY.md`。