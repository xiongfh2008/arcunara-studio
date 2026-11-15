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

## 最终交付状态 — ✅ 已推送 GitHub

- `main` @ `8fc9a61`（v0.2.0 工程基线）已推送
- `feature/hosting-mvp` @ `9163de8`（7 个提交）已推送
- Draft PR：https://github.com/xiongfh2008/arcunara-studio/pull/1（**未合并**，等待人工评审）
- 最终验证：82/82 测试通过、lint 21 文件通过、本地 Docker 构建与容器验收、真实 Chromium 浏览器端到端验证

## RC1：合并前修复与部署准备 — ✅ 已完成

- **Compose 项目名冲突修复**：项目名改为 `arcunara-studio-v03-test`（与 v0.2.0 目录派生名 `arcunara-studio-dev` 隔离），容器名同步改为 `arcunara-studio-api-v03-test`；新增 `scripts/compose-preflight.mjs`（npm run preflight，已加入 CI）静态校验项目名/端口/卷隔离/host 网络禁用
- **工作台预览 URL 修复**：新增 `ARCU_PREVIEW_PUBLIC_BASE_URL`（区分内部监听地址与浏览器访问地址）；未设置时保持本地体验（同主机 + 实际监听端口，支持 port 0）；compose 默认注入 `http://127.0.0.1:28089`（SSH 转发可用）；预览链接永不携带 Token；非法配置拒绝启动
- **Axure 兼容性预检查**（真实 Chromium，Axure 风格 + 敏感 API 探测夹具）：多页跳转/相对路径/外部 JS+CSS/图片/同源字体/iframe 全部通过；eval、Web Storage、SW、fetch/XHR 被安全边界阻止（如实记录）；发现并修复**字体加载阻断**（opaque origin 需要 ACAO:* + font-src 放宽，已用真实 TTF 验证解析与渲染）；**真实 RP11 导出验收仍未完成**
- **测试计数统一**：全量重跑 94/94 通过（修复此前文档 82/83 不一致）；新增部署配置回归测试 `deploy-config.test.mjs`（7 项）与预览链接生成测试（8 项）

## RC2：真实 Axure ZIP 兼容性修复 — ✅ 已完成

- **样本分析**：新增 `scripts/zip-inspect.mjs`（通用 ZIP 结构/配额余量/安全预检/JS 敏感 API 扫描工具）；真实 POBO 样本实测 2,786 条目、72.62 MiB、单层包装目录含唯一 index.html、无穿越/碰撞/符号链接、最大路径 81 字符
- **配额**：生产默认不变（2000/2MiB/80MiB）；compose 测试环境传 `ARCU_MAX_FILES=5000`、`ARCU_MAX_HTML_BYTES=8388608`、`ARCU_MAX_EXTRACT_BYTES=134217728`（单文件与 ZIP 压缩限保持 20 MiB）；新增 `GET /api/limits` 供工作台显示当前配额
- **上传引擎修复**：zipextract 条目迭代器改为持久监听（2,786 条目不再累积 once 监听器）
- **工作台 UX**：创建/上传新版本按钮 busy 状态（上传中…/处理中…）、禁用防重复提交、finally 恢复；配额感知中文错误提示（TOO_MANY_FILES/HTML_TOO_LARGE/EXTRACT_LIMIT_EXCEEDED/ZIP_TOO_LARGE/UNSAFE_ENTRY_PATH 等 20+ 错误码映射，配额值来自 /api/limits）；无虚假进度条
- **测试**：新增 `tests/quota.test.mjs`（2,786 条目默认配额拒绝 / 5,000 配额接收 / 3MiB HTML / 128MiB 严格生效 / 失败无残留 / 配额下安全规则仍生效 / /api/limits）与工作台 UX 静态断言；全量 **102/102 通过**
- **真实样本端到端**：上传 201（4.9s）→ 2,737 文件 → 入口重定根 → 预览/大页/中文路径/字体/.crx 拒绝全部符合预期；真实 Chromium 渲染截图验收

## RC3：Axure 安全预览入口与多页面导航 — ✅ 已完成

- **特征检测**（lib/axure.mjs）：`data/document.js` + `resources/scripts/axure/*.js` 双标记同时存在才判定 Axure 导出；纯 index.html 项目不误判；请求时从当前版本目录计算页面清单（更新/回滚自动一致，不执行上传脚本，不修改文件）
- **业务页面提取**：顶层 .html 排除播放器壳（index/start 变体）与点文件；resources/chrome/plugins 下辅助页因嵌套自动排除；zh collation 确定性排序
- **安全预览导航页**：`/p/{id}/` 对 Axure 项目渲染平台导航页（目录侧栏 + iframe 预览区 + 独立页面 + 原始入口 index.html 调试链接 + hash 深链）；页面名经 JSON `<` 转义 + textContent 渲染（XSS 安全）；URL 逐段 encodeURIComponent；导航页自身 sandbox allow-scripts（opaque origin、无 secrets、frame-ancestors 'none'、frame-src 'self' 仅限本版本页面）
- **detail.isAxure** 字段（additive）→ 工作台链接显示"安全预览（页面目录）"
- **测试**：新增 `tests/axure.test.mjs` 12 项（双标记检测/误分类回归/导航页内容与排除/转义与 textContent 渲染/逐段编码回程（%41 不解码）/原始入口保留/非 Axure 不受影响/版本回滚清单一致/meta 隐藏）；全量 **115/115 通过**
- **P1 播放器研究**（本地最小实验 + 静态扫描，详见 KNOWN_LIMITATIONS）：mainFrame 停留 about:blank 因 sandbox opaque origin 无法被父页驱动写入；本地 allow-same-origin 实验使 sitemap 面板部分恢复（证实根因），mainFrame 仍空白 → 完整兼容需多项被禁止的放宽，RC3 以安全预览导航替代；实验已完整还原
