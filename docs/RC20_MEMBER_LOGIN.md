# RC20B — 邀请激活、邮箱密码登录与安全会话

## 交付范围

RC20A 的管理员/成员 Token 和项目 viewer/editor ACL 保留；RC20B 新增 **管理员邀请式密码账号**、一次性激活/重置码、12 小时 HttpOnly Cookie 会话、退出与密码修改、账号/权限审计。不是公开注册或完整多租户产品。

默认关闭：

```env
ARCU_TEAM_ACCESS_ENABLED=0
ARCU_MEMBER_LOGIN_ENABLED=0
# 生产必须明确 HTTPS 反向代理访问源；不可设置路径、账号或查询参数：
# ARCU_MEMBER_PUBLIC_ORIGIN=https://staging.example.com
```

启用时同时设置 TEAM=1 与 LOGIN=1，API 必须绑定 `ARCU_API_HOST=127.0.0.1`；反向代理将唯一公开 HTTPS 域名流量转发到本机 Node 监听端口，并正确保留 Host。未配置公开 Origin 时仅允许从 127.0.0.1 直连 `http://127.0.0.1:<port>`（本地开发/测试）。任何公网 HTTP / 0.0.0.0 直连登录都应拒绝启用。

## 用户操作与身份

1. 管理员在「团队成员」创建用户，再点击「生成激活码」。码有效期 24 小时，仅此一次显示；由管理员通过可信渠道安全传递给成员（**暂不自动发送邮件**）。
2. 成员访问 `/console` →「成员登录」→「首次激活 / 重置」，填写受邀邮箱、激活码、12–128 字符密码。码仅能使用一次，后续使用邮箱密码登录。
3. 成员登录后浏览器获得 `HttpOnly; SameSite=Strict; Path=/api` 的 12 小时 Cookie（公开 HTTPS 自动加 Secure），工作台可恢复现有有效会话，Cookie 不暴露给 JS。
4. 成员的项目权限仍完全由 RC20A 服务端 RBAC 决定。Viewer 可以查看版本、ZIP 与转换源；Editor 可以更新版本及回滚；成员不能创建项目、改名/公开发布/删除、管理分享/密钥或管理其他成员。
5. 成员可退出登录、使用旧密码修改密码（修改后所有旧会话失效）；管理员可重新签发激活码让成员重置密码。停用成员、轮换管理员发放的成员 Token 也会撤销所有浏览器会话。

**邮件所有权未被验证。** 因没有配置 SMTP/邮件服务，管理员负责通过可信渠道确认接收人，不应宣称已发送验证邮件。正式开放自助注册/邮箱找回必须再接邮件服务、校验邮件送达与滥用防护。

## 接口（团队/登录开关打开时）

| 路由 | 方法 | 身份 | 功能 |
|---|---|---|---|
| `/api/users/{id}/invite` | POST | 管理员 | 签发 24 小时一次性激活/重置码 |
| `/api/audit/auth` | GET | 管理员 | 最近 200 条账号与权限操作，不含明文凭证 |
| `/api/auth/activate` | POST | 匿名 + Origin/CSRF | `{email,code,password}`，初次激活或重置 |
| `/api/auth/login` | POST | 匿名 + Origin/CSRF | `{email,password}`，设置 HttpOnly Cookie |
| `/api/auth/session` | GET | 成员 Cookie | 获取当前成员身份（无 Token 明文） |
| `/api/auth/logout` | POST | 成员 Cookie + Origin/CSRF | 注销本次会话，清除 Cookie |
| `/api/auth/change-password` | POST | 成员 Cookie + Origin/CSRF | `{oldPassword,newPassword}`，撤销全部会话 |

原有 `/api/me`、`/api/projects` 等接口增加可用的成员会话身份，不修改 RC20A 项目 ACL。Bearer 头的优先级始终高于 Cookie，任何错误 Token 都不会自动降级使用成员 Cookie 或管理员本地会话。

## 安全实现与约束

- 密码使用带 16 字节随机盐的 Node `crypto.scrypt`（N=16384,r=8,p=1），只存盐与派生哈希，密码不记录在日志。激活码与 Cookie 为 32 字节随机值，磁盘仅存 SHA-256。
- 成员 Cookie 设置 `HttpOnly`、`SameSite=Strict`、`Path=/api`、12 小时有效期，HTTPS 公开源增加 `Secure`。服务端逐请求读取最新成员状态和 Session 哈希，禁用/退出/修改密码后立刻失效；同时最多五个有效会话。
- 所有无身份或 Cookie 身份的变更请求必须有精确的 `Origin` 和自定义 `X-Arcunara-Member-Request: 1`，并拒绝 `Sec-Fetch-Site` 非同源请求。不会开启通配 CORS。
- 登录口令失败连续八次后单进程按邮箱+来源地址限流 15 分钟；不回显邮箱是否存在。此限制在多实例/跨主机情况下不共享，**尚不是生产级统一速率限制**。
- 审计保留最近 200 条账号创建、启停、授权、撤销、邀请、激活、登录、登出与密码变更记录，仅保存操作类型、成员/项目 ID 和时间，无明文密码、Token 或激活码。
- 当前存储仍使用 `.rc20-team.json` 与单 Node 进程写锁，没有数据库级事务、多租户 Owner 关系、自助注册、邮件发送、MFA、统一边缘速率限制、会话设备管理及账号自动找回。
- 现有不受成员会话保护的 `/p/{id}/` 原型预览仍遵循既有预览授权与分享系统策略，不因邮箱密码登录自动增加 `/p` 访问权限。

## 验收与上线门槛

- CI 必须通过 RC1–RC20 全量回归；新增测试覆盖无邀请登录、邀请码过期/重放、错误/缺失 Origin、Cookie、退出、角色隔离、旧 Token 失效、密码修改与重置。
- 单独在 Windows Edge/Chrome 验证 `1440/1024/768/390px` 登录表单、输入自动填充、退出后返回与浏览器刷新恢复。
- 开启团队账号前配置可信 HTTPS 反向代理、密钥备份、管理端 RBAC 审计及边缘限流；使用隔离测试数据与独立域名先验收。

本轮只开发并同步 GitHub，不访问 VPS、不开启新功能开关、不修改已保存的现有项目。