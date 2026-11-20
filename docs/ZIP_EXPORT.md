# RC17 项目 ZIP 导出与历史版本下载

**目标**：管理员在“版本管理”中选择指定历史版本并下载可再次托管的 ZIP，方便备份、迁移和跨工具处理。此能力只导出静态文件，**不等于**将 HTML 原生转换为 Axure RP11 的 `.rp`。

## 使用方式

打开 `/console` → 选择项目 → 版本管理 → 选中需要的版本 → **下载选中版本 ZIP**。无需切换当前生效版本，原来的预览、分享链接保持原状。为避免管理员 Token 出现在 URL，工作台通过带内存中 Bearer 头的同源 `fetch` 接收 ZIP，再用浏览器 Blob 下载。浏览器大文件会占用客户端内存。

## API

`GET /api/projects/{uuid}/export?version={positive-integer}`

- 省略 `version` 默认导出当前版本。允许下载回滚前后的任一历史版本，但不能访问不存在的版本。
- 认证：只有管理员 Bearer Token 或符合现有规则的管理员 session；项目部署密钥（`dpk_`）**403**，匿名访问 **401**。
- 正常返回：`Content-Type: application/zip`，`Content-Disposition: attachment; filename="arcunara-{uuid}-v{n}.zip"`，`Cache-Control: private, no-store`。
- 无效/重复版本参数 → 400 `INVALID_VERSION`；不存在 → 404 `VERSION_NOT_FOUND`；项目在回收站 → 409 `PROJECT_TRASHED`。
- 不可安全导出的非常规/符号链接条目 → 409 `EXPORT_UNSAFE_ENTRY`；文件过多/过大 → 413 `EXPORT_FILE_LIMIT` / `EXPORT_SIZE_LIMIT`。

## 技术要点

- 原生 ZIP32 method 0 (store) + data descriptor：单次流式读取文件，不将全部 ZIP 写到内存或磁盘临时文件，也不增加第三方依赖。
- ZIP 内保留文件原有相对路径、UTF-8 中文等文件名；只打包项目文件，不包含 `meta.json`、隐藏文件或管理凭证。
- 预扫描拒绝符号链接、非普通文件、危险路径，最多 6000 个文件，总文件体积最多 256 MiB；不输出无效/空包。
- 导出全过程使用项目级写锁，防止同一项目的版本发布、删除与导出交错。发生连接中断或流错误时终止响应，不把 JSON 错误拼入 ZIP。
- 支持 legacy-root v0.2.0 项目的隐式 v1，同时不改变旧项目磁盘布局。
- 本功能不会执行上传代码，也不包含任何原生 `.rp` 转换。

回归测试：`tests/rc17-version-export.test.mjs` 验证 ZIP 实际可解压、中文与嵌套文件、版本内容区分、身份鉴权、回收站门禁、legacy 内容过滤、软链接与大小限制。