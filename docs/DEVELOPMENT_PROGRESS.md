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

## 阶段 B：HTML/ZIP 上传引擎 — ✅ 已完成（commit 4fecc47）

- 流式 multipart 解析（busboy）：总量/单文件 ZIP 20MiB / HTML 2MiB 限额在传输中生效，单文件规则
- 安全 ZIP 解压（yauzl，strictFileNames）：Zip Slip / 绝对路径 / 反斜杠 / NUL / 控制字符 / 保留设备名拒绝；符号链接与非常规条目拒绝；加密条目拒绝；条目数、单条目、HTML、总解压量限额实时生效；重复/大小写/Unicode 规范化碰撞拒绝；CRC 与 size 校验
- 入口识别：根 index.html > 单一包装目录重定位 > 单 HTML 文件；歧义归档明确报错
- 原子发布：staging 目录 rename 至 versions/1 后写 meta；失败全量清理（含中断请求的排空）
- 限额可经 ARCU_MAX_* 环境变量调整
- 新增 36 个上传/ZIP 安全测试；关键修复：yauzl close() 无回调导致的挂起、mid-stream 失败的 fd 释放与请求排空、路由级失败临时文件清理

## 阶段 C：完整静态预览引擎 — ✅ 已完成

- 多文件静态服务：HTML/CSS/JS/图片/字体/JSON/文本/音视频，MIME 白名单（未知扩展名 404）
- 路径安全：逐段解码+校验、原始请求点段拒绝（fetch 规范化前的防护）、点文件与 meta.json 永不服务、逐级 lstat 符号链接检查、safeJoin 双重包含校验
- CSP sandbox（opaque origin）+ 'self' 子资源 + data: URI；外部网络请求/插件/base 劫持/Service Worker 阻止；nosniff/no-store/no-referrer
- `/p/{id}` → `/p/{id}/` 302 规范化；entry ≠ index.html 时 302 到入口页；HEAD 支持；目录列表不提供
- 新增 11 个预览测试（含 raw socket 穿越测试）

## 阶段 D：版本管理与旧数据兼容 — ✅ 已完成

- `POST /api/projects/{id}/versions`：multipart 文件或 JSON html 上传新版本，验证全程在 staging 完成
- `GET /api/projects/{id}/versions`：版本历史（version/createdAt/fileCount/totalSize/entryPoint/isCurrent）
- `POST /api/projects/{id}/rollback`：原子切换 currentVersion（meta.json 临时文件 + rename），幂等（重复回滚返回 rolledBack:false）
- 固定预览链接：/p/{id}/ 永远指向 currentVersion；回滚后内容立即跟随
- v0.2.0 兼容：无 versions/ 目录的旧项目按"legacy-root 隐式 v1"读取与服务，根目录文件永不移动/删除；首次更新时记录为 v1 并发布 v2+；可回滚回 legacy 根内容
- 进程内按项目写锁串行化所有 meta/版本变更，避免竞态
- 新增 11 个版本管理测试（含 legacy 目录直写模拟）；全量回归 80/80 通过

## 阶段 E-1：轻量内部工作台 — ✅ 已完成

- `GET /console`：自包含单页工作台（零依赖、暗色 SaaS 风格、桌面优先、基础响应式）
- 功能：Token 内存连接（不写入 localStorage/sessionStorage/Cookie，不出现在源码）、项目列表、
  新建（multipart 文件或粘贴 HTML）、详情、上传新版本、历史版本、回滚、预览链接复制/打开
- 安全：页面经 CSP default-src 'none' + frame-ancestors 'none' + form-action 'none' 加固；
  所有动态内容 textContent 渲染（无 innerHTML 注入面）；预览端口由服务端注入
- 预览服务不提供 /console；新增 2 个 console 测试；全量 82/82 通过

## 阶段 E-2：Docker / CI — ✅ 已完成（commit 9d940c2）

- `infra/docker/Dockerfile`：node:24-alpine，`npm ci --omit=dev` 依赖烘焙，非 root，无密钥/数据入镜像
- compose 改为镜像构建（不再 bind-mount 源码）；运行时安全姿态与 v0.2.0 完全一致
- CI 增加 `npm ci`（含 npm 缓存）
- **本地 Docker 验收真实执行**：镜像构建 → compose up → health v0.3.0 → 无 Token 401 → ZIP multipart 创建（含 description）→ 预览 200 + CSP → CSS 资源 MIME → rollback 端点 → /console 200 → down 清理

## 阶段 E-3：浏览器端到端验证 — ✅ 已完成（真实 Chromium）

- 通过 ZCode 内置 Chromium 完成端到端验证（非 HTTP-200 代替）：
  - 工作台：页面渲染、Token 内存连接、项目列表
  - 预览：外部 CSS 真实生效（computed style：文字色 rgb(29,78,216)、居中、背景 rgb(238,242,255)）
  - 外部 JS 真实执行（load 事件改写标题 "[JS loaded]"；onclick → 函数执行 → DOM 更新 + 类切换 + 颜色变化 rgb(21,128,61)）
  - 图片真实解码（naturalWidth > 0，1x1 PNG）
  - 页面导航：相对链接 → page2.html → 返回；URL/标题/内容全部验证
  - 截图视觉确认；CSP sandbox 下脚本正常执行
- 过程中发现并修正测试夹具缺陷（fixture 按钮漏写 onclick —— 产品行为正常）
- 诚实记录：仓库内**未**包含 Playwright 自动化测试（未安装依赖与浏览器二进制）；CI 目前仅 lint + 集成测试

## 阶段 E-4：安全收尾与文档 — ✅ 已完成

- 预览 CSP 增加 `form-action 'self'`（阻止表单提交跳转外部站点）
- 新增 `docs/KNOWN_LIMITATIONS.md`（上传限制、预览隔离边界、公网部署前置条件）
- 更新 README、development.md（完整 API 规范）、deployment.md（Dockerfile 流程、v0.2.0 兼容与回滚）、.env.example
