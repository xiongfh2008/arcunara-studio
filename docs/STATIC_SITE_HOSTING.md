# RC13 — 独立静态网站运行环境（仅代码与本地集成测试）

> **默认关闭，未部署到 VPS。** 请勿把本功能与现有 /p/ 原型预览或
> /s/ 令牌分享混为一谈。RC13 仅支持用户已构建的 HTML/CSS/JS/字体/图片等
> 静态资源，不运行 Node/Python/数据库/SSR。

## 为什么新增第三个独立 HTTP Listener

已有原型预览为不可信用户上传内容启用 CSP opaque-origin sandbox；
其安全模型不支持普通 SPA 的持久化、本地存储和许多 JavaScript
依赖；不能直接关闭 sandbox 让原型和管理控制台共源运行。

RC13 将业务能力完全分开：

| Listener | 默认端口 | 目的 |
|---|---|---|
| API | 3000 | 管理后台、版本、分享、鉴权 |
| Preview | 3001 | 受 sandbox 保护的原型预览 |
| **Sites（新增，默认不开启）** | 3002 | 公开静态网站、每个项目独立浏览器 origin |

每个静态网站以**项目 UUID 作为子域名**：

`https://<uuid>.sites.example.com/`

- 一个网站只允许读取自己项目的**当前版本**文件。公开发布开关初始为 OFF。
- JS/CSS/图像支持以 `/assets/` 开头的根路径；CSS、JS 等普通静态文件
  会以准确 MIME 返回，不附加预览 sandbox。
- 支持 `/nested/` 的文件夹索引和 SPA 客户端路由回退（仅
  `Accept: text/html` 的无扩展名导航；不存在的图片脚本依然 404）。
- 每个项目通过固定 UUID Host 解析，**没有**按同一域名下的
  `/projects/{id}` 直接访问所有项目的入口。
- 仅读取 ZIP/HTML 经现有上传安全检查后落盘的静态文件。
  禁止 dotfiles、meta.json、符号链接、路径穿越、未允许扩展名。
- 返回基础安全头：`nosniff`、`frame-ancestors 'none'`、
  `object-src 'none'`、有限的 Permissions-Policy。
- API `PATCH /api/projects/{id}` 接受管理员布尔字段
  `siteEnabled`；部署密钥仍只允许上传版本和查询，无权发布。
  `GET /api/projects/{id}` 在已发布时返回 `siteUrl`。
- 回收站强制立即取消网站公开发布；恢复不会自动重新发布。
  归档不会撤销已公开网站。原型预览、分享及版本回滚不受影响。

## 配置（**仅说明，不代表已在 VPS 中启用**）

```dotenv
ARCU_SITE_HOSTING_ENABLED=0
# 仅当经安全审计并准备独立的站点域名后才调整为 1
ARCU_SITE_DOMAIN=sites.example.com
ARCU_SITE_HOST=127.0.0.1
ARCU_SITE_PORT=3002
```

- 必须手工设置完全独立的站点子域名后缀；程序**不会**修改 DNS、
  Cloudflare、Nginx、Docker Compose 映射或防火墙。
- 不要复用 `staging.arcunara.com`、管理 API 或 preview 域名。
- API / Preview 继续使用原端口，只有显示启用时才启动第三监听器。
- 当前测试使用 `sites.arcunara.test` 虚拟域名与临时本地端口。
- 公网域名的泛解析、TLS 和限流等属于另一次受控部署任务。

## 多租户安全注意事项

虽然 UUID 子域名区分了浏览器的 **origin / localStorage**，但在
共享注册域名下，不同子域名有可能人为设置 `Domain=.sites.example.com`
的父域 Cookie。这对多租户网站是重要的**剩余风险**，因此：

1. 部署前选择与 Arcunara 登录、付款、API 完全隔离的可控域名；
   不要使用含管理员会话的同一父域。
2. 多租户商业化发布前评估 [Public Suffix List](https://publicsuffix.org/)
   私有域注册或其他租户 Cookie 隔离机制，做跨租户安全测试；
   本阶段不能宣称已经获得完整 Cookie 隔离。
3. 网站上传可运行用户 JavaScript，严禁将其作为服务端代码执行，
   不允许挂载用户容器内命令或绕过内容安全扫描。
4. 不要将管理员 token、Access JWT、API Cookie、项目部署密钥
   注入任何公开网站页面或响应头。
5. 站点发布是**公开操作**：知道地址的访客不需要原型分享令牌。
   不要用发布网站来承载本应仅内部查看的私有原型。

## 推荐的后续验收

- 单元及本地集成：默认关闭、发布权限、不同 Host 隔离、
  SPA 路由、HTTP/HEAD、文件及元数据防泄露、关闭发布立即 404、
  归档/回收站/恢复、历史版本回滚。
- 真实浏览器：React/Vue/Vite 静态构建，绝对路径资源、前端路由，
  无 CSP opaque-origin 错误。
- Cloudflare / Nginx：确认管理后台原有 Access 保护、Preview
  sandbox、SSL、限流、域名白名单与跨租户 Cookie 边界都有效。
- 现有项目与旧 Docker Compose：不设置开关时仍然只有原两个
  Listener，不会改变 VPS 状态。

本 PR 仅交付**托管服务源代码和可在本地验证的能力**，并不是公网
域名已开通，更不是全栈云主机。
