# 已知限制与安全边界（v0.3.0）

本文档如实记录当前版本的限制、安全边界与公网部署前必须解决的事项。**计划中的能力不会被标记为已完成。**

## 上传限制（默认值，均可用 `ARCU_MAX_*` 环境变量调整）

| 限制 | 默认值 | 生效时机 |
| --- | --- | --- |
| ZIP 压缩大小 | 20 MiB | multipart 流式传输中 |
| 请求体总量（multipart） | 24 MiB | 流式传输中 |
| 解压总量 | 80 MiB | 条目级声明大小预检 + yauzl 实际字节校验 |
| 单文件（解压后） | 20 MiB | 解压前逐条目 |
| 单 HTML 文件 | 2 MiB | 解压前逐条目 / multipart 传输中 |
| 文件数量（含目录） | 2000 | 解压过程逐条目 |
| 目录深度 | 20 | 解压过程逐条目 |
| legacy JSON `html` 字段 | 180 KB（256 KB 请求体） | 与 v0.2.0 完全一致（有意保留） |

上传期间内存占用与文件大小解耦（全部流式写入临时文件）；配额在处理过程中生效而非事后检查。

## 预览安全边界

- **隔离机制**：预览文档通过 CSP `sandbox allow-scripts allow-forms` 获得 opaque origin —— 上传内容中的脚本无法访问预览服务的同源资源、Cookie 或存储，无法读取其他项目（跨项目请求受 CORS 阻止，响应不可读）。
- **当前架构限制**：预览与工作台分属两个端口，但仍是**同一主机上的相邻源**。公网部署前必须为预览使用**独立域名/源**（如 `preview.example.com`），并确保平台主站 Cookie/Token 不出现在任何相邻源上。本阶段仅允许本地/回环地址测试，**不声明已达到公网安全标准**。
- **CSP 策略**：`default-src 'none'`；脚本/样式仅允许 `'self' + 'unsafe-inline'`；图片/字体/媒体允许 `'self' + data:`；`connect-src 'self'`；`object-src 'none'`；`base-uri 'none'`；`form-action 'self'`。
- **兼容性影响（有意保留的安全边界，不为兼容性取消）**：
  - 外部 CDN 资源（Google Fonts、CDN 脚本等）会被 CSP 阻止 —— 原型必须自包含全部资源。
  - Service Worker / Web Worker 被 `default-src 'none'` 阻止。
  - `<object>`/`<embed>` 插件被阻止。
  - 表单只能提交到预览源自身。
- **iframe 嵌入权限边界**：预览页可被外部页面 `<iframe>` 嵌入（未设置 frame-ancestors）。嵌入方的脚本与被嵌入的 sandbox 文档之间天然互相隔离（opaque origin）。公网部署时应评估是否收紧。
- **不做的事**：服务端绝不执行上传内容中的任何程序；SVG 以 `image/svg+xml` 提供但其中的脚本受同一 CSP 约束。

## 路径与文件策略

- 点文件/点目录（`.env`、`.git/` 等）与 `meta.json` 永不通过预览提供（404）。
- MIME 白名单之外的扩展名一律 404：可执行文件、`wasm`、服务端模板（`.php` 等）、压缩包、PDF 等不被提供。
- 无目录列表、无目录索引、无 Range/断点请求（大视频拖动进度条不可用）。
- ZIP 内的反斜杠路径、符号链接、加密条目在**上传时**即被拒绝（不是预览时）。
- 大小写/Unicode 规范化冲突的条目拒绝（避免在不区分大小写的文件系统上被覆盖）。

## 鉴权与 Token 管理

- 单一管理员 Token（文件注入，timing-safe 比较）。**没有用户系统、没有按项目/按用户的访问控制** —— 预览链接（UUID 不可猜测但不是密钥）对持有链接的任何人公开。
- Token 轮换需重启进程；无 Token 管理 API。工作台 `/console` 页面本身不含密钥，Token 仅存在于操作者内存中。
- 无速率限制 / 无审计日志 —— 上传限额是唯一的滥用边界。

## 版本与存储

- 每个版本完整存储（无去重/增量），磁盘占用随版本数线性增长。
- 版本数无上限（受 meta.json 大小自然约束）；删除项目 / 删除单版本的 API 尚未实现。
- `GET /api/projects` 无分页。

## Axure 导出兼容性

**v0.3.0 RC1 预检查结果**（Axure 风格夹具 + 敏感 API 探测夹具，真实 Chromium 执行；**尚未用真实 RP11 导出文件验收**）：

| 检查项 | 结果 |
| --- | --- |
| 多页面 HTML 跳转（真实点击） | ✅ 正常 |
| 相对路径资源（含 `../` 跨子目录引用） | ✅ 正常 |
| 外部 JavaScript / CSS 加载与生效 | ✅ 正常 |
| 图片 | ✅ 正常 |
| 同源自定义字体（@font-face TTF，真实字体解析） | ✅ 正常（需要 `Access-Control-Allow-Origin: *` + `font-src` 放宽 —— RC1 已修复） |
| 同项目 iframe 嵌套页面 | ✅ 加载；框架内文档同样受完整 sandbox CSP 约束 |
| `eval` / `new Function` | ❌ 被阻止（CSP EvalError）—— 依赖 eval 的 Axure 插件会失效 |
| `localStorage` / `sessionStorage` / `document.cookie` | ❌ SecurityError（opaque origin）—— Axure JS 若无保护直接访问会抛异常 |
| `fetch` / XHR（含同源） | ❌ 全部拒绝（opaque origin 下 CSP `'self'` 不匹配任何目标）—— 依赖 AJAX 的交互原型会失效；核心渲染不依赖 |
| Service Worker / Web Worker | ❌ 阻止 |
| WebSocket | 构造可用，连接受 CSP 约束 |
| `window.top` 读取 | 允许；写入导航被 sandbox 阻止 |

**结论**：以静态标记资源 + 内联/外部脚本为主体的 Axure 导出（RP11 常见形态）核心渲染兼容；依赖 AJAX、Web Storage、eval 或 CDN 资源的功能会降级或失效 —— 均为有意保留的安全边界，不为兼容性关闭 sandbox。

**真实导出验收仍未完成**：需要拿到真实 Axure RP11 导出文件后补充浏览器验收，在此之前不声明完全兼容。

## 浏览器测试

- 已用真实 Chromium（ZCode 内置浏览器）完成端到端人工验证：CSS 实际生效（computed style）、图片实际解码（naturalWidth）、按钮脚本交互、页面导航、工作台连接。
- **仓库内未包含 Playwright 自动化浏览器测试**（未安装 Playwright 依赖与浏览器二进制）；CI 目前只运行 lint + 集成测试。这是后续待办，不是已完成项。

## 公网部署前必须解决

1. 预览服务独立域名/源（绝对要求，见上文）。
2. HTTPS / 反向代理（本服务仅监听 127.0.0.1）。
3. 速率限制与基础审计日志。
4. 用户系统与访问控制（当前仅单管理员 Token）。
5. 病毒/恶意内容扫描（当前仅有结构与配额防护）。
6. 备份策略（数据目录为普通文件）。
