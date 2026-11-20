# RC18B — Zee-RP RP/1 源与本地原生编译桥接

## 实际能力与边界

Arcunara 提供按版本生成的 **Zee-RP RP/1 JSON 源文件**；目标为 `language:"rp/1"`、`target:9`。生成器保留静态页面与独立可编辑控件的候选结构，部分明确的颜色/几何与内部页面跳转，标注不可可靠映射的 CSS/JS/响应式布局与外链。

目前 **不能宣称平台已经直接生成通过 Axure RP11 验收的 .rp 文件**：公开 Zee-RP RP/1 生成后端当前针对 RP9；Axure RP11 的读取、编辑和保存重开需要真实宿主验证。正式网站服务器不会执行 Zee-RP、Python、上传的 JS 或任意命令。

依据（第三方开源项目，许可为 MIT）：
- <https://github.com/LilZeeCN/zee-rp>
- <https://github.com/LilZeeCN/zee-rp/blob/main/references/rp-language.md>
- <https://github.com/LilZeeCN/zee-rp/blob/main/scripts/proto.mjs>

## 操作：Arcunara 工作台

选择项目 → “Axure 转换评估” → “下载 Zee-RP RP/1 源文件”。源文件为 `arcunara-{uuid}-v{n}.rp1.json`；如果有图片，还需在“历史版本”中下载同版本的 HTML/ZIP 并解压，保留 `assets/` 等相对路径。把下载的 RP/1 JSON 放到该解压目录根部。服务端不会把管理 Token 放进 URL。

## API

`GET /api/projects/{uuid}/axure-rp1?version={N}`

返回 `{ "spec": { "language":"rp/1","target":9,"pages":[...] }, "report": { "status":"source-only", "nativeRpExportReady":false, "hostValidated":false, "warnings":[...] } }`。只有管理员能访问；不能用部署密钥；回收站项目不能访问；不存在的历史版本返回 404；版本参数格式不合法返回 400。

## 本地 Windows CLI：两种用法

已经在工作台下载 `.rp1.json` 时，直接跳过第一步。请使用本机 Node.js 24 与你安装的 Zee-RP，并确认 Python 3、模板与依赖符合其自身要求。

1. 可选：将 RC18A 的原始 `editable-ir.json` 转为 RP/1：

```powershell
cd D:\AI\arcunara-studio
node packages/rp-converter/local-cli.mjs convert "D:\AI\examples\editable-ir.json" "D:\AI\examples\draft.rp1.json"
```

2. 显式本地编译（**仅**可用 Zee-RP 已支持的 RP9 输出；不自动部署）：

```powershell
cd D:\AI\arcunara-studio
node packages/rp-converter/local-cli.mjs compile "D:\AI\examples\draft.rp1.json" "D:\AI\zee-rp" "D:\AI\examples\draft.rp"
```

工具先检查 `zee-rp/package.json` 的 package name，执行 `node scripts/proto.mjs check --spec ...`；语义成功后执行 `node scripts/proto.mjs generate --spec ... --out-dir <temporary> --out-rp ... --backend native`。禁止覆写目标文件；出错不会输出伪造的 `.rp`。编译超时或失败会清理本次临时目录/新输出。执行编译前仍需确认 Zee-RP 本地安装可用、源文件旁图片素材存在。

**注意**：通过 CLI 或编译器的内部校验，只能标记为“引擎生成，尚未宿主验证”。使用者还需在 Axure 中打开、核查页面与独立元件、修改至少一个文字与控件、保存关闭重开，再核查跳页及受支持交互。RP11 兼容性单独记录，不推断。

## 映射与降级

- 文本：HTML 标题/标签→`label`，段落→`paragraph`。
- 普通按钮→`button`；内部 HTML 链接→带 `on.click.link` 动作的 `button`。
- 输入→`input`；支持的 checkbox/radio 保留类型；未知输入类使用输入框候选并标记降级。
- 图片：只引用安全相对路径、常见图片扩展名；缺失资源退化为占位标签。
- 布局：有明确 inline CSS 的像素值则保留；无定位时生成稳定位置并逐项标记 `LAYOUT_SYNTHESIZED`，需要人工整理。
- 外部链接与不可信路径不生成可执行动作；没有 JS/HTML 的执行或网络访问。

## RC18C：推荐的本机安全流程

本机新建工作目录，保持导出的 JSON 与同版本源 ZIP 为不同文件。使用 Node.js 24：

1. 在 Arcunara 工作台下载 `*.rp1.json` 以及对应版本的 ZIP；解压源 ZIP 至 `D:\AI\ArcunaraExports\version-source`。
2. 只将 JSON 中实际引用的图片与 RP/1 JSON 一起暂存到新目录（不会复制未引用文件、JS、HTML、隐藏文件）：

```powershell
cd D:\AI\arcunara-studio
node packages/rp-converter/local-cli.mjs stage "D:\AI\ArcunaraExports\source.rp1.json" "D:\AI\ArcunaraExports\version-source" "D:\AI\ArcunaraExports\native-stage"
```

3. 检查 `native-stage\manifest.json` 中的资源及 SHA-256，然后以本机已配置的 Zee-RP 执行编译：

```powershell
node packages/rp-converter/local-cli.mjs compile "D:\AI\ArcunaraExports\native-stage\source.rp1.json" "D:\AI\zee-rp" "D:\AI\ArcunaraExports\output.rp"
```

4. 只有完成 Zee-RP `check`、`generate`、`decompile` 后，才创建 `output.rp` 与 `output.rp.verification.json`。任何错误不会产出声称成功的 .rp；如缺少 `AXURE_BLANK_TEMPLATE_RP9` 等 Zee-RP 所需资源，必须先按 Zee-RP 的文档准备，不修改 Arcunara 服务器。
5. 在 Axure RP9（如可用）及目标 Axure RP11 **分别**测试文件是否能打开、编辑按钮/文字/输入等元件、保存关闭并重开。打开成功不代表全部事件、样式保真。把文件 SHA-256、应用版本、操作结果及截图保存为独立的验收记录。

`verification.json` 中 `hostValidation` 的每一项默认为 `null`，`nativeRp11Certified:false`。**绝不因为 CLI 成功而自动将其改为 true。**

限制：RC18C 是显式本地 CLI 工具，平台 API 不执行 Zee-RP，不提供无条件的线上“一键生成 RP11”。Mock CI 测试只验证编排/错误处理，不构成真实原生编译成功证据。

## 后续工作

正式 RC18C 再接 Zee-RP 独立 Worker，包含安装版本锁定、运行沙箱、源资源打包、后台任务队列、RP9 结构检查与真实 RP11 宿主验收。当前 RC18B 仅提供本地编译入口，不向公网站点直接暴露原生输出。
