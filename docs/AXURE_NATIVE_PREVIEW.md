# RC22 — Axure 原生播放器隔离兼容模式（staging）

## 为什么不能只在 `staging.arcunara.com/s/` 放开 CSP

Axure RP 导出的 `index.html` 通过同源 JavaScript 控制嵌套 iframe，可能使用
`localStorage`、`XMLHttpRequest`、`eval`、`contentDocument` 与 DOM 写入。
当前安全预览通过响应头 `Content-Security-Policy: sandbox allow-scripts allow-forms`
给每个页面独立的 opaque origin，Axure 原生播放器的主画布因此空白。
直接为 staging/admin 同域加 `allow-same-origin` / 取消 sandbox，会使用户上传的
任意脚本与工作台共享网络 Origin，**不可接受**。

RC22 使用两种互不混淆的模式：

| 页面 | Origin | 内容和保护 |
| --- | --- | --- |
| 工作台、管理 API | `https://staging.arcunara.com` | 原有 Cloudflare Access、认证及管理员策略不变 |
| 安全预览（默认） | `https://staging.arcunara.com/s/{token}/` | 保留旧有 opaque-origin sandbox；适合查看业务页面 |
| Axure 原生预览（按需） | `https://axure-staging.arcunara.com/s/{token}/index.html` | **不同 HTTPS Origin**，允许同源 iframe / localStorage / XHR / eval，仅提供已验证 Axure 共享文件 |

> 兼容模式 **仅单管理员 staging 测试**：同一 native hostname 下多个原型并非
> 互相独立 Origin，用户上传内容可能读取该 native hostname 的 localStorage。
> 切勿用它直接承载正式多租户任意上传内容；正式版应采用**每项目独立 Origin**
> （例如具有专门证书与 Cookie 策略的 project-id 子域名）、恶意文件扫描、
> 访问审计与更严格资源配额。此模式仍不保证所有 Axure 插件或外部服务兼容。

## 代码约束

- `ARCU_AXURE_NATIVE_ORIGIN` 默认为空（禁用），启用时要求是与工作台不同的**纯 HTTPS origin**（没有路径、查询、凭据），且已启用 staging Cloudflare Access 模式。
- 原生模式通过请求 Host 精确判断；在原管理域名上的 `/p/`、`/s/` 仍保留原 sandbox。
- 原生 hostname 只允许 `/s/{shareId}.{secret}/...`，每个请求都校验签名或有效期、停用、撤销和项目归属；`/p/{uuid}`、`/api`、`/console` 都返回 404。
- 原生模式仅允许已识别的 Axure 导出（检测 `data/document.js` 和 `resources/scripts/axure/` 且有业务页面）；普通 HTML 项目不能获得原生策略。
- 原生资源保留已有 MIME 白名单、路径穿越、符号链接和 `meta.json` 保护。
- 允许 `unsafe-eval`、同源脚本及 iframe 是**有意的兼容性例外**；不修改源 ZIP，也不运行服务器端上传代码。
- 工作台可以通过原先的十分钟预览票据获得 `/s/{token}/`，在安全预览页点击「Axure 原生播放器（独立隔离）」即可打开原始播放器。
- Nginx 的 Host 必须固定为 `axure-staging.arcunara.com`；不接收管理 Token / Cookies，不能套用原 staging 的 `arcunara-rc7-preview.conf`，因为它会再次添加 sandbox CSP。

## VPS 部署前置（需要手工完成）

1. 在 Cloudflare DNS 将 `axure-staging.arcunara.com` 指向同一 VPS，保持 `staging.arcunara.com` 不变。建议为新子域名配置独立的 Cloudflare Access 管理员验证；即使 Access 关闭也必须依靠服务端有效的 share capability，且不能泄露 URL。
2. 确认现有 TLS 证书是否覆盖新域名；若没有，先单独签发或配置对应证书，**不要修改现有 staging 证书路径或默认站点**。
3. 在 `/opt/arcunara-rc21-preview/infra/rc21-preview/staging.local.yaml` 的 `services.api.environment` 下增加：
   ```yaml
   ARCU_AXURE_NATIVE_ORIGIN: "https://axure-staging.arcunara.com"
   ```
4. 通过 `docker compose --env-file infra/rc21-preview/secrets/staging-access.env -f infra/rc21-preview/compose.yaml -f infra/rc21-preview/staging.local.yaml up -d --build api` 仅更新 RC21 容器（数据卷不动）。
5. 为新子域名增加**独立** Nginx `server`，HTTPS 配置使用有效且覆盖该子域名的证书。参考**仅 location 内容**：
   ```nginx
   # 置于独立 server_name axure-staging.arcunara.com 的 443 server 内
   location ^~ /s/ {
       limit_except GET { deny all; }
       proxy_pass http://127.0.0.1:29089;
       proxy_set_header Host axure-staging.arcunara.com;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header Cookie "";
       proxy_set_header Authorization "";
       proxy_set_header Cf-Access-Jwt-Assertion "";
       proxy_hide_header Set-Cookie;
       proxy_read_timeout 60s;
       add_header Cache-Control "no-store" always;
       # 重要：不要添加 CSP sandbox，不要 include arcunara-rc7-preview.conf
   }
   location / { return 404; }
   ```
   80 端口单独跳转 HTTPS 或用于 ACME challenge；其他站点配置不变。执行 `nginx -t` 成功后再 `systemctl reload nginx`。
6. 针对两个主机名分别验证：未认证的 `/s/不存在的令牌/index.html` 应返回 404；
   新子域名的 `/api/projects`、`/p/{uuid}/` 必须 404；工作台域名仍保留沙箱；
   打开真实有效的 `/s/{token}/index.html` 时响应不含 `CSP: sandbox`。
   **不要将完整 share token、管理员 Token 或 Cookie 发到聊天。**
7. Edge/Chrome 手工验收真实 POBO 原型：播放器左侧树和右侧 mainFrame 同时渲染、
   页面切换、动态面板、条件交互、表单、弹窗；在开发者工具查看 404、CSP/CORS
   与 JavaScript 错误。当前 CI 的 Node.js 测试不能替代这项真实浏览器验收。

## 回滚

仅移除新子域名 Nginx 的启用项并恢复其独立配置备份；
原 `staging.arcunara.com` 不需修改。若需要关停原生模式，删除
`ARCU_AXURE_NATIVE_ORIGIN` 配置后重新创建 RC21 容器即可。
**不要**停止旧 staging 28088/28089，也不要使用 `docker compose down -v`。
