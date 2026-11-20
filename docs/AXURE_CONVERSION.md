# RC11 — Axure RP11 导出：先完成安全的转换评估

## 当前完成的能力

- 受管理员鉴权保护的 `GET /api/projects/{uuid}/axure-readiness`。
- 可选 `?version=N`，按当前/历史版本原始文件扫描，不改变版本。
- 支持普通 HTML 项目与识别出的 Axure HTML 导出项目。
- 统计页面、基本文字/表单/图片/表格/链接/iframe 等控件数量。
- 标记脚本、HTML 内联事件、网络接口、本地存储和 iframe 的映射风险。
- 分析始终在服务器读取静态文件，**不会执行**上传的 HTML 或 JS。
- 限制一次最多扫描 100 个页面，单页面扫描最多 8 MiB。
- 工作台「Axure 转换评估」按钮展示报告，可复制 JSON。

**重要：当前输出为转换评估 JSON，不是原生 `.rp`。**
界面字段 `nativeRpExportReady:false` 与 `status:analysis-only`
明确表达这一事实。完整 Axure RP11 原生导出仍需接入本地
`D:\\AI\\zee-rp` 的 RP/1 编译和导出器，并进行 Axure RP11
宿主读回验证；当前 GitHub 仓库没有该工具源代码或可执行依赖。

## RC18A：静态可编辑控件候选中间模型（已开发）

- 新增 GET /api/projects/{uuid}/axure-ir?version=N（省略 N 默认当前版本）。仅管理员，部署密钥拒绝访问；回收站项目拒绝分析。
- packages/rp-converter/ir.mjs 生成 arcunara.editable-ir.v1：页面、文本、按钮、输入、图片及同项目导航候选、部分显式样式/尺寸。
- 仅保留 HTML 内联明确设置的像素坐标/尺寸，不解析 CSS 样式表或推断 flex/grid 响应式几何；动态脚本和交互仅报告风险，不执行。
- 单次限制 50 页、32 MiB HTML 总量、每页 8 MiB、每页 350 元件、总共 3000 元件；超限拒绝，不静默截断。
- 工作台“Axure 转换评估”弹窗增加下载控件候选 JSON。该 JSON 不可直接用 Axure RP11 打开。
- 原生 .rp 仍不可导出：status=mapping-only、nativeRpExportReady=false、compiler.available=false。

### 下一阶段编译器接入

把中间模型中的页面、文字、输入、图像和导航按 Zee-RP 的实际 schema 转成 RP/1，再调用可信编译器，并在真实 Axure RP11 中打开/选中/编辑完成验证。Zee-RP 位于用户 Windows 本地 D:\AI\zee-rp，当前 GitHub 仓库没有其源码或可调用二进制。无法在没有编译器的情况下真实验证 .rp，不做虚假输出。

## RC18B — Zee-RP RP/1 源码桥接（已开发）

基于公开 [LilZeeCN/zee-rp](https://github.com/LilZeeCN/zee-rp) 的 `references/rp-language.md` 与 `scripts/proto.mjs` CLI 契约实现。公开 RP/1 JSON 规范的当前目标为 `target: 9`（Axure RP9 原生后端），**不是已验证的 RP11 原生编译**。

- `GET /api/projects/{uuid}/axure-rp1?version=N`：管理员只读获取 `{spec, report}`，不传 N 默认当前版本；部署密钥 403，回收站 409。源文件不修改当前版本、原型和分享。
- 将 RC18A 候选中间模型转换为 `language: "rp/1", target: 9` JSON：页面、标签/段落、按钮、输入框、复选/单选、已知图片路径、同项目页面跳转（`on.click: [{type:"link",page:"..."}]`）。
- 仅按明确内联坐标与尺寸映射，未指明的布局采用稳定的简易候选位置，必须在设计工具里校准。CSS、JS、表单状态、复杂交互不可保真，输出 `report.warnings`。
- 无图片文件或跨域链接等不可靠项降级，绝不把被跳过或降级的功能谎称已转换。
- 工作台“Axure 转换评估”弹框新增“下载 Zee-RP RP/1 源文件”，文件后缀 `.rp1.json`，**不是** `.rp`。
- 提供离线 `packages/rp-converter/local-cli.mjs`：本机 opt-in 的 RP/1 生成 / Zee-RP check 与 generate 编译包装器。平台 API / Preview 不执行第三方编译器。

具体 Windows 本地运行命令、资源保留方式及宿主验收要求请查看 `docs/ZEE_RP_BRIDGE.md`。

## RC18C — 本地编译准备与引擎读回校验（已开发）

- 本地 CLI 新增 `stage`，只复制 RP/1 JSON 及引用的图片，进行大小、符号链接、目录穿越和哈希检查，生成包含资源列表的 `manifest.json`。不复制上传的 JS、HTML 或隐藏文件。
- `compile` 增加输入图片校验，并固定按 Zee-RP `check → generate → decompile` 执行。生成的 .rp 在独立临时目录完成引擎读回后，通过防覆盖拷贝到目标位置，并写出 `*.rp.verification.json` 校验报告。
- 报告记录编译器名称/版本与 SHA-256、输出文件 SHA-256、图片 SHA-256，以及未完成的 Axure RP9/RP11 宿主操作检查项。
- 回读失败、找不到图片、路径异常或目标已存在时拒绝发布，避免提供看似有效但无法读回的原生文件。
- **验证分级**：本机 check+decompile 是 Zee-RP 自身的结构性检查，不代表 Axure 软件打开成功；未连接用户的 Windows Axure RP11，`nativeRp11Certified` 始终为 false。
- 仍未添加 VPS/后端原生编译 Worker，也没有在 GitHub CI 中运行真实 Axure 或 Zee-RP 原生生成；CI 仅覆盖 Mock 编译器调用路径、错误保护与资源处理。

## 原生导出器后续接入要求

1. 定义可版本化的页面/元件/交互中间模型（节点 ID、几何、文本、样式、图片资源、事件条件）。
2. 将 HTML/CSS 的可转换部分映射成**可编辑的 Axure 原生元件**。
   不能将 HTML 截图塞进 iframe 并声称支持编辑。
3. 无法可靠推断的响应式布局、条件交互、动态脚本应在转换报告中
   标记未支持，禁止静默忽略。
4. 独立的转换 Worker 做配额控制、超时、文件扫描、输出签名与清理；
   禁止在已运行的 API/Preview 服务进程执行用户代码或编译器脚本。
5. 每个版本可以独立导出；导出不能覆盖源版本目录。
6. 自动验证生成的 .rp 文件可解析，**还必须在真实 Axure RP11
   程序中打开、选中和编辑元件**，才标记为“已验收”。
7. 最终支持下载 `.rp` 与转换报告；商业化前需覆盖至少三个真实多页面项目。

## API 示例

```http
GET /api/projects/<project-uuid>/axure-readiness?version=2
Authorization: Bearer <admin-token>
```

返回的 `pages`、`elements`、`risks` 只含结构数据和风险提示，
不包含 HTML/JS 源码，供后续转换器和 UI 使用。

当前没有引入第二公网域名、VPS 配置改动或任何 AI 推理调用。
