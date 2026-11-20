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
- 版本数无上限（受 meta.json 大小自然约束）；RC16 已实现回收站项目的管理员永久删除（不可恢复；失败残留在下次启动清扫）；删除单版本的 API 尚未实现。
- `GET /api/projects` 无分页。

## RC17 ZIP 导出限制

- 管理员可按项目版本流式下载 ZIP（浏览器侧使用 Blob 触发下载；大文件占用客户端内存）。服务端为兼容 ZIP32 设置每次最多 6000 个文件、合计 256 MiB 的硬上限；仅使用 ZIP Store（不压缩），下载包可能大于原始上传 ZIP。
- 原样保留用户目录结构和 UTF-8 文件名；不导出任何名为 `meta.json` 的元数据文件或点文件/目录，不执行上传的 HTML、JS。
- 项目在回收站时拒绝导出；不可使用部署密钥下载；下载期间持有项目写锁，删除/版本更新等待下载结束；不支持对 .rp 文件进行编译。

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

## 真实 Axure RP11 导出验证（RC2，真实样本）

样本：POBO 付款能力扩展原型（Axure RP11 HTML 导出，9.93 MiB ZIP / 2,786 条目 / 解压 72.62 MiB / 最大 HTML 4.58 MiB / 含 2,578 个 SVG 与 1 个 .crx）。样本文件不入库，仅本地验证。

**结果（真实 Chromium，v0.3.0-rc2 测试配额）**：

- 上传：201（4.9s），2,737 文件全部解压，单层包装目录正确重定根，入口 `index.html` ✓
- 预览：索引页 200（12 脚本/7 样式表/Axure 播放器 iframe 正常）；4.58 MiB 大页 200 并完整渲染——6,328 个 Axure 元件、1,174 个 SVG、真实业务文字/表格/分页全部可见（截图验收）
- 中英混合路径（全角括号等）正确编码后全部可访问；woff2 字体 200 + CORS 头 ✓
- `.crx` 按 MIME 白名单拒绝（404），不开放下载或执行 ✓
- 外链 CDN（fonts.googleapis.com、gstatic、bootcss font-awesome）被 CSP 阻止 → 使用回退字体（预期行为）
- 样本自带 JS 使用 eval（action.js ×2）与 jQuery XHR（×2）：基础渲染未触发这些路径；依赖它们的交互会失败（见上表安全边界），未为其开放 CSP

**配额调整**：测试环境（compose）放宽为 files 5000 / HTML 8 MiB / 解压 128 MiB；**生产默认不变**（2000 / 2 MiB / 80 MiB）。会话数据目录内存限制 192 MiB 下流式解压实测正常。

**仍待完成**：跨页面交互（按钮跳转、面板动作）的系统性回归仅做了抽样；未覆盖 Axure 播放器全部功能。

## 原生 Axure 播放器（index.html）空白根因研究（RC3）

真实 POBO 样本在沙箱下播放器现象：页面壳渲染（缩放控件），**内容区域 mainFrame 空白**、站点地图面板为空、Console 出现 localStorage SecurityError / XHR 失败 / Google Fonts 拦截。逐项定位：

| 现象 | 根因（实测证据） | 最小可行方案 | 风险 | RC3 决定 |
| --- | --- | --- | --- | --- |
| mainFrame 停留 about:blank | 播放器脚本以同源方式驱动内容 iframe（document.write / contentDocument 写入）；sandbox 使父子均为 opaque origin，父无法访问子文档（实测 `contentDocument === null`） | 无（需修改上传内容或开放 allow-same-origin） | allow-same-origin 使预览内容获得预览源同源权限，破坏平台隔离模型（被禁止放宽） | ❌ 不纳入；以安全预览导航页替代其导航职能 |
| 站点地图面板为空 | 站点地图数据经相对 XHR/初始化流程加载，opaque origin 下 `connect-src 'self'` 不匹配任何目标 → 请求被阻 | 无（同上） | 同上 | ❌ 不纳入 |
| 本地实验佐证 | 临时 `allow-same-origin`（仅本地、已完整还原）使 sitemap 面板恢复可见 → 证实根因是 origin 隔离；但 mainFrame 仍空白（还存在 XHR/驱动链路问题） | — | — | 实验性证据，不部署 |
| frame_ant.js / 播放器 localStorage SecurityError | opaque origin 下 `localStorage` 属性访问即抛 SecurityError（RC1 探测已证实） | 无（需 allow-same-origin 或注入 shim；注入违反"不修改上传内容"） | 同上 | ❌ 不纳入 |
| frame-src 缺失 | RC3 前未显式声明 frame-src；实测同源 iframe 在 default-src 回退下仍可加载；播放器空白与 frame-src 无关 | 导航页显式 `frame-src 'self'`。注意：`'self'` 指预览服务同源（协议/主机/端口），**不按项目 UUID 限定**；项目边界由代码保证——导航页 iframe 的 src 仅取自本项目的页面清单，且沙箱下 JS 无法读取跨项目响应 | 极低（同源静态资源；无跨项目读能力） | ✅ 已随导航页纳入 |
| XHR/CORS 报错 | 同 connect-src 结论；核心页面渲染与交互（表单/弹窗/下拉）不依赖 XHR，不受影响 | — | — | 无需处理 |
| Google Fonts / bootcss 外链被阻 | CSP `default-src 'none'` 阻止全部外链（预期行为） | 自托管字体/样式 | 引入第三方源扩大攻击面（被禁止） | ❌ 不纳入 |

**结论**：原生播放器完全兼容需要 `allow-same-origin` + `connect-src` 放宽 + 上传内容修改，三者均违反本项目安全模型。RC3 的安全预览导航页覆盖其导航职能（12 业务页面目录 + iframe 隔离预览 + 独立页面入口），RC21 修复已移除公开安全预览页中的原生播放器入口。对已识别的 Axure 项目，
访问 `index.html`、`start.html` 等原生播放器壳会重定向到安全页面目录；
`index.html?g=1&id=...&p=页面名` 仅在该业务页真实存在时映射到其安全导航深链，
否则进入页面目录。非 Axure 网站的 `index.html` 不受影响。
**这不是原生播放器兼容性恢复**：高级 iframe 同源访问、localStorage、XHR 和
`eval` 限制保持不变；业务页面中依赖这些能力的交互仍可能失效。

## 浏览器测试

- 已用真实 Chromium（ZCode 内置浏览器）完成端到端人工验证：CSS 实际生效（computed style）、图片实际解码（naturalWidth）、按钮脚本交互、页面导航、工作台连接。
- **仓库内未包含 Playwright 自动化浏览器测试**（未安装 Playwright 依赖与浏览器二进制）；CI 目前只运行 lint + 集成测试。这是后续待办，不是已完成项。

## RC7 单公网测试域名预览实验（尚未启用）

RC7 增加了**默认关闭**的 `ARCU_STAGING_PUBLIC_PREVIEW` 开关，可在
`staging.arcunara.com` 下通过不同路径提供管理员预览（`/p/`）和
带时效的令牌分享（`/s/`），省去管理员浏览器本地 SSH 隧道。
但它**不是独立网络 Origin**：安全性依赖每个预览文档的 opaque-origin
CSP 沙箱、每次 `/p` 请求的签名 Access JWT 认证、Nginx 的二级鉴权
和仅针对 `/s/*` 的最小范围公开策略。旧版本回滚若保留不受保护的
公网 `/p` 路由可能泄露 UUID 预览，因此部署与回滚有严格顺序。

该方案限定为**单管理员 staging 试点**，不能替代本文“公网部署前”
对**正式多租户生产环境**独立预览网络 Origin 的要求。原生 Axure
播放器的 localStorage、XHR、eval 限制不会因使用同一公网主机而消失。
具体步骤与风险：`docs/STAGING_PUBLIC_PREVIEW.md`。

## 公网部署前必须解决

1. 预览服务独立域名/源（绝对要求，见上文）。
2. HTTPS / 反向代理（本服务仅监听 127.0.0.1）。
3. 速率限制与基础审计日志。
4. 用户系统与访问控制（当前仅单管理员 Token）。
5. 病毒/恶意内容扫描（当前仅有结构与配额防护）。
6. 备份策略（数据目录为普通文件）。
