# RC21A — 单文件 HTML 原型在线编辑与安全保存

## 目标

Arcunara 已能从 AI 工具接收 HTML/ZIP 并创建版本，但修改 AI 生成的单 HTML 页面仍要人工重新上传。本阶段在工作台增加直接读取 HTML、编辑源代码、查看脚本禁用的静态草稿，以及**保存成新版本**的能力。该阶段不接入收费模型或外部大模型 API，不提供可视化拖拽编辑器，不执行用户上传的 HTML/JS。

## 范围与设计

- 工作台选择项目，点击「在线编辑 HTML」后读取**当前版本**的唯一 HTML 文件（UTF-8，最多 180000 字节）。显示当前版本、入口路径与 SHA-256 基线。
- 编辑源码使用普通文本框，不执行 HTML。刷新草稿预览使用 `<iframe sandbox="">` 且提供先行 CSP Meta：默认不加载任何网络资源、不执行脚本、不提交表单；仅允许内联 CSS 和 data: 图片/字体。预览不等于线上运行环境。
- 保存执行 `POST /api/projects/{id}/html-editor/publish`：新建版本、更新当前版本指针；历史原版、旧 ZIP 下载、旧版本对比和回滚能力继续保留。
- 使用 `baseVersion` 与 `baseSha256` 校验打开编辑器时的版本。最终检查在项目写锁内部进行；若期间其他人、CI/AI Agent 上传或回滚导致当前源版本改变，返回 409 `EDITOR_VERSION_CONFLICT`，不覆盖对方更改。草稿继续留在页面中，方便用户复制备份。
- 原始 HTML 未变化时返回 200 `unchanged:true`，不会重复创建版本。
- 对多文件 ZIP/含 CSS、JS、图片等额外文件的项目明确返回 409 `EDITOR_MULTIFILE_UNSUPPORTED`，阻止意外丢失资源；仍可使用原有「上传新版本」和 ZIP 下载流程。这是**有意的第一阶段边界**。
- 完全沿用 RC20：管理员与 editor 成员可编辑，viewer 仅查看源码，部署密钥无权访问在线编辑接口。用户代码不进入管理员 DOM 的 `innerHTML` 或 `eval`。

## API

| 请求 | 权限 | 成功结果 | 关键错误 |
|---|---|---|---|
| `GET /api/projects/{uuid}/html-editor` | admin/editor/viewer | `{projectId,version,entryPoint,sha256,html,maxHtmlBytes,singleFile:true,scriptExecution:false}` | 401/403/404/409/413 |
| `POST /api/projects/{uuid}/html-editor/publish` | admin/editor | 请求 `{baseVersion,baseSha256,html}`；返回新版本（201）或无变化（200） | 400/401/403/404/409 |

限制与版本冲突均采用现有 `{error,code}` JSON 响应，敏感 Token 不出现在查询参数、浏览器存储或工作台日志中。

## 验证方式

`tests/rc21a-html-editor.test.mjs` 使用真实本地临时目录和 HTTP 子进程验证：

1. 单文件读取、版本发布、未修改保存的去重；
2. 两个请求基于同一旧版同时保存，只有一个成功；被 AI/CI 新版本抢先更新时冲突；
3. 多文件 ZIP 被拒绝编辑，历史文件与资源不变；
4. v0.2 legacy-root 项目旧 HTML、meta 不被移动和复制，新版正确落入 `versions/2`；
5. viewer/editor/部署密钥/匿名授权边界和回收站保护；
6. 工作台代码编辑、字节计数、未保存退出确认、静态脚本禁用预览。

**独立测试/生产部署：** 本次仅 GitHub 代码开发和 CI，不触碰 VPS；正式浏览器验收仍需确认 Chrome/Edge 的 iframe 静态预览、移动端布局、脚本禁用、冲突提示及 RC19–RC20 登录完整流程。

## 后续 RC21B

在不破坏多文件目录的基础上增加 ZIP 项目的文件树、HTML/CSS/JS 独立编辑、差异预览和事务化保存；再评估浏览器可视化选择控件修改、AI 生成提示词版本记录和「草稿 → 审核 → 发布」工作流。原生 Axure RP11 实机编译仍是 RC18 独立验收项。
