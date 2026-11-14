# 开发进度记录 — P0 HTML 托管 MVP（v0.3.0）

分支：`feature/hosting-mvp`（基于 main @ `8fc9a61`，v0.2.0 工程基线）

> 本文档按阶段更新：已完成功能、修改文件、测试与结果、Commit、遗留问题。

## 阶段 A：项目检查与模块化重构 — ✅ 已完成

**已完成内容**

- 确认 v0.2.0 基线（main @ 8fc9a61，16 文件，工作区干净）。
- 创建 `feature/hosting-mvp` 分支。
- 新增依赖：`busboy@1.6.0`（流式 multipart 解析，MIT）、`yauzl@3.4.0`（流式 ZIP 读取，MIT，默认拒绝加密/强加密条目，读取时校验 size/CRC）。选择理由：均为成熟维护中的流式库，满足"限制在处理过程中生效"的要求，避免手写 multipart/ZIP 解码器。
- `apps/api/server.mjs` 拆分为模块（行为保持 v0.2.0 兼容）：
  - `lib/config.mjs` — 环境变量与上传限额（ZIP 20MiB / 解压 80MiB / 单文件 20MiB / HTML 2MiB / 文件数 2000 / 深度 20 / multipart 总量 24MiB，均可 env 覆盖）
  - `lib/httputil.mjs` — JSON 响应、错误封装（保留 v0.2.0 error 字段，新增 code 字段）、流式限额读体
  - `lib/auth.mjs` — timing-safe Bearer 鉴权
  - `lib/pathsafety.mjs` — 路径段校验 / safeJoin / 碰撞键（供解压与预览共用）
  - `lib/store.mjs` — 项目存储（创建/列表/详情、进程内写锁、v0.2.0 旧目录只读兼容视图）
  - `lib/routes.mjs` — API 路由（health / 列表 / JSON 创建；multipart 与详情在阶段 B）
  - `lib/preview.mjs` — 预览服务（阶段 A 保持 v0.2.0 行为）
- 测试基建：`tests/helpers/harness.mjs`（子进程启动真实服务 + 随机端口 + 临时目录）。
- 新增 API：`GET /api/projects/{id}`（项目详情）、`GET /api/projects/{id}` 404 语义。

**行为说明（相对 v0.2.0 的有意差异）**

- `/health` version 字段更新为 `0.3.0`。
- 列表/创建响应新增字段：`updatedAt`、`currentVersion`、`fileCount`、`totalSize`、`entryPoint`（创建还含 `versionCount`）；v0.2.0 字段全部保留。
- 415 错误信息更新为 "Use application/json or multipart/form-data"（为 multipart 预留），新增 `code` 字段。

**已执行测试**：`npm run lint`（8 文件通过）、`npm test`（20/20 通过，含 v0.2.0 回归）

**Commit**：见 Git 历史（阶段 A 提交）

**遗留问题**：无

**下一阶段**：阶段 B — multipart/ZIP 上传引擎（含 ZIP 安全校验与入口识别）
