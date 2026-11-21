# RC23 — Arcunara HTML/ZIP → 真正可下载的 Axure `.rp`（受控试点）

## 输出定义（不要把 JSON 伪装成 .rp）

用户将 HTML/ZIP 上传 Arcunara 后，工作台「Axure 转换评估」可按版本发起
「生成 Axure .rp（RP9）」任务。后端将静态 HTML 控件候选映射为 RP/1
`language:"rp/1",target:9`，由**单独运行、无网络的 Zee-RP Worker**
按顺序执行 `check → generate → decompile`。
只有输出真实二进制 .rp、大小、SHA-256 和引擎读回匹配时，才将任务标为 completed，
启用管理员鉴权下载；失败时**不提供** .rp。服务默认关闭。

**当前原生目标为 RP9，不是 RP11 已验收文件**。
Zee-RP 官方文档当前 RP/1 target=9，需要用户自行提供由 Axure RP9 保存的
空白 .rp 模板。完整的 Axure RP11 兼容性必须在 Windows Axure RP11 中打开、
选中编辑控件、保存关闭和重开来验收，不能靠 JSON 解析或者 Zee-RP decompile 推断。

## 转换范围 / 不能保证

- 可编辑候选：部分 HTML 静态文字、基本按钮与输入、明确的内联位置尺寸/颜色、
  资源路径受限的图片、可识别的站内页面跳转。
- 不能保证：原始 Axure 动态面板、条件表达式、变量、复杂交互、CSS/Flex/Grid
  准确还原。HTML 是单向发布产物，不能据此恢复原始 .rp 的所有语义。
- 限额：最多 50 页、每页 350 候选控件、项目总计 3000、每个 HTML 8 MiB、
  总 HTML 32 MiB；超限报 `IR_WIDGET_LIMIT` 或相应错误，**绝不截断后称转换成功**。
  当前 POBO 13 页是否能够转换必须经实际 API 测试，不可由 13 页推断一定成功。
- RP/1 JSON 仍可单独下载；同一个 UI 中的「生成 .rp」是真正的独立任务。
- 输出保留原项目及历史版本，支持历史版本按版本号转换；输出不会写入原版本目录。
- 24 小时过期、每站最多 3 个活跃任务、20 个未清理的任务记录；
  后台单 worker 串行编译。

## API（管理员，禁用时 503）

- `POST /api/projects/{uuid}/native-rp-export` JSON `{"version":2}`
  → HTTP 202 `{"id":"uuid","status":"queued",...}`。
- `GET /api/projects/{uuid}/native-rp-export/{jobUuid}`
  → queued/running/completed/failed 状态、警告、是否通过引擎读回。
- `GET /api/projects/{uuid}/native-rp-export/{jobUuid}/download`
  → HTTP 200 `application/octet-stream` 与真正的 `...-rp9.rp`；
  未完成、校验失败、不存在、过期则分别拒绝。不存在直接下载 JSON 的兼容路径。
- 成员 Token 和部署密钥一律不能管理、查询或下载此类任务；
  未认证 HTTP 401；不把管理 Token 放在下载 URL。

## 编译环境安全边界

- 主 API **不执行** Zee-RP、用户 JS/HTML，也不导入 Worker 启动模块。
- Worker 是单独容器，`network_mode: none`、非 root、只读根文件系统，
  cap_drop ALL、no-new-privileges，项目原始数据以只读卷挂载。
  只有 `.rp-jobs` 任务目录读写，临时文件位于 tmpfs；不转发任何 API Token。
- 用户自行提供 RP9 空白模板，不能向 GitHub、聊天或客户端公开软件模板。
- Worker build 从 `LilZeeCN/zee-rp` 获取固定 SHA
  `6cc2b8695b1b148548eac4fd776c2f47be358335`；依赖打包在 Worker 镜像。
  升级 SHA 必须单独审查、构建测试；主 API 镜像不加入 Python 编译依赖。
- RC23 自动化测试用假的 `.rp` 字节仅测试**下载门禁**，不是 RP 编译成功证据。
  必须在有真实 Zee-RP、合法模板的环境完成 `generate`/读回与 GUI 验收。

## VPS 配置（不影响现有 staging / Nginx / Cloudflare）

**不要在还没准备好空白模板和 Worker 前开启 API 开关。**
提供以下三个文件：
- `infra/rc21-preview/compose.yaml`（现有 API）
- `infra/rc21-preview/staging.local.yaml`（保留现有安全覆盖，不提交）
- `infra/rc21-preview/native-rp-worker.compose.yaml`（新增可选 Worker）

1. 检查 VPS 资源；Worker 约预留 2 GB RAM、必要磁盘空间，以及较大的临时内存空间。
   先确认固定 SHA 的 Zee-RP 在当前主机可成功 `check` 与编译。
2. 从自己拥有使用权的 Axure RP9 新建并保存一个**单页空白 .rp**，
   安全传到 `infra/rc21-preview/secrets/rp9_blank.rp`。避免将模板传入聊天或 GitHub。
   需保证 UID 1000 可读取模板（例如 root:1000，权限 0640）。
3. 确保 `infra/rc21-preview/data/.rp-jobs` 存在且 UID 1000 可读写（权限 0700）。
4. 运行（命令仅为文档，需要你在 VPS 完成上面的前置检查后执行）：
   ```bash
   cd /opt/arcunara-rc21-preview
   docker compose \
     --env-file infra/rc21-preview/secrets/staging-access.env \
     -f infra/rc21-preview/compose.yaml \
     -f infra/rc21-preview/staging.local.yaml \
     -f infra/rc21-preview/native-rp-worker.compose.yaml \
     --profile native-export config --quiet

   docker compose \
     --env-file infra/rc21-preview/secrets/staging-access.env \
     -f infra/rc21-preview/compose.yaml \
     -f infra/rc21-preview/staging.local.yaml \
     -f infra/rc21-preview/native-rp-worker.compose.yaml \
     --profile native-export up -d --build api native-rp-worker
   ```
5. 检查 worker 运行、API 29088/health 返回 200、旧 28088 返回 200；
   用一个**小型自建 HTML**先完成一笔编译、读回和本机 Axure 打开测试，
   再尝试 POBO 13 页项目。不要为了突破超限直接删除检查。
6. 若要关闭在线原生导出，使用原来的三套配置（不加载 worker override）
   重建 API；停止 worker 容器但**不删除** data、版本或 `.rp-jobs`。

## 尚待完成才能称为 RP11 正式版

- 大型 Axure HTML 的语义解析和 >350 元件页面的完整重建；
- 原版复杂交互、动态面板与母版的映射与逐页对比；
- 真实 RP11 的打开/编辑/保存/重开截图与审计；
- 每项目独立限流、租户隔离、Worker 多节点队列和任务恢复；
- 线上构建 Worker 镜像及合法空白模板到位后的真实全链路验收。

这些条件未满足前应显示「RP9 实验性生成／RP11 未验证」，不要宣传「RP11 100% 保真」。
