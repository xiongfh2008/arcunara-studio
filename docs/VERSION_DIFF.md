# RC15 — 项目历史版本文件差异对比

## 已实现

受管理员权限保护的只读 API：

```http
GET /api/projects/<project-uuid>/compare-versions?from=1&to=2
Authorization: Bearer <admin-token>
```

返回新增、删除、修改文件列表及未变化文件数，示例：

```json
{
  "projectId": "<uuid>",
  "fromVersion": 1,
  "toVersion": 2,
  "added": [{"path":"new.txt","bytes":8}],
  "removed": [{"path":"old.txt","bytes":8}],
  "changed": [{"path":"assets/app.css","fromBytes":12,"toBytes":12}],
  "unchangedCount": 1,
  "counts": {"added":1,"removed":1,"changed":1,"unchanged":1},
  "readOnly": true
}
```

规则：
- 对两个版本扫描同名文件，相同路径+不同大小直接标记修改；
  若大小相同，读取 SHA-256 摘要判断是否真正相同。
- 不读取文件正文作为返回值，也不执行上传的 HTML/JS。
- 排除任何 `meta.json`、隐藏元文件，兼容旧版 v0.2.0
  只有目录根文件的项目。
- 单版本最多 6000 文件、扫描 160 MiB，超过立即拒绝，不写
  元数据、不创建版本，也不改变当前版本。
- 未授权返回 401，项目部署密钥禁止访问（403），不存在
  版本返回 404，回收站项目返回 409。
- 已回滚后仍可以独立对比任意真实历史版本；不会因当前版本指针
  变化丢失对比结果。
- 工作台版本管理面板内可以选择两版并查看文件变更清单。

## 设计边界

本功能属于**文件级**差异，不是像素级页面视觉对比，也不能推导
CSS 布局变化对最终页面截图的视觉影响。若需要 UI 视觉 Diff，
应通过浏览器截图建立独立的受限渲染 Worker，并明确允许/禁止
执行不可信脚本。本阶段不涉及运行用户 JS。

未来可在后续版本中加入跨页面 UI 回归截图、受控 Diff 结果导出、
CI 发布前差异审批等能力。未修改 VPS 或 Cloudflare 配置。
