# RC16 回收站项目永久删除

## 操作路径

工作台 → 我的项目 → 筛选“回收站” → 选择项目 → 项目设置 → “永久删除”。系统要求输入该项目完整 UUID；取消或输入不一致均不会发起删除请求。

**不可恢复**：永久删除项目后，全部已上传的历史版本与项目元数据会被移除；原有 /p 预览、/s 分享、部署密钥和独立站点地址失效。请先在“版本”页面确认不存在需要保留的资料。

## API

`DELETE /api/projects/{uuid}`

要求管理员认证（Bearer Token 或已经配置的管理员 Session/Access）。Deploy Key 无权执行此接口。

请求 Content-Type: application/json：

```json
{"confirmProjectId":"<same-project-uuid>"}
```

响应示例：

```json
{"projectId":"<same-project-uuid>","deleted":true}
```

- 400 `DELETE_CONFIRMATION_MISMATCH`：确认 ID 与请求 URL 不一致。
- 401：管理员未认证。
- 403：部署密钥越权调用。
- 404 `PROJECT_NOT_FOUND`：项目不存在/已经删除。
- 409 `PROJECT_NOT_TRASHED`：必须先移入回收站。
- 409 `PROJECT_META_MISMATCH`/`PROJECT_PATH_UNSAFE`：元数据或目录异常，拒绝清理。
- 500 `PROJECT_PURGE_INCOMPLETE`：已经从公开存储移出但清理不完整；残留由启动清扫处理。

## 实现与安全边界

- 只处理严格校验的 UUID，且只删除确认为已移入回收站的项目。
- 使用项目级写锁串行化删除与版本上传、修改项目状态、分享操作。
- 首先把项目目录原子重命名至同磁盘 `.tmp/purge-...`，立即从普通项目读取路径消失；随后执行递归物理清理。
- 在此基础上同步清除进程内分享和部署密钥索引；验证路径每次都重新读取元数据，旧令牌不能再授权。
- 崩溃或文件清理失败可能遗留 `.tmp` 目录；`store.init()` 原有恢复清扫逻辑会在下次启动清理残留。没有自动备份或反悔恢复。
- 只操作应用目录中的项目文件，不访问 VPS 或外部站点资源。

## 回归测试

`tests/rc16-permanent-delete.test.mjs` 检验正常项目无法删除、确认码错误、匿名/部署密钥越权、回收站删除前后项目和分享状态、部署密钥失效、legacy-root 数据与工作台按钮。
