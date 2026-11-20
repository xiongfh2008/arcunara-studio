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

## 后续工作

正式 RC18C 再接 Zee-RP 独立 Worker，包含安装版本锁定、运行沙箱、源资源打包、后台任务队列、RP9 结构检查与真实 RP11 宿主验收。当前 RC18B 仅提供本地编译入口，不向公网站点直接暴露原生输出。
