# RC21 视觉验收测试环境部署手册（准备就绪，不自动执行）

**目标：** 在现有 Contabo VPS 上使用全新目录、全新 Docker Compose 项目及 `127.0.0.1:29088/29089` 端口启动独立的 RC21 验收站。不会修改现有 v0.2 `18088/18089`、RC19/RC20 `28088/28089`、Nginx、Cloudflare 或任何其他站点。实际部署需有 VPS SSH 权限，当前提交代码本身**不会**启动容器。

## 先验证环境和端口

```bash
# 在 VPS 的 SSH 会话中运行；没有 docker/compose 就先处理环境，不修改原业务
docker info >/dev/null && docker compose version
ss -lntp | grep -E ':(29088|29089)[[:space:]]' || true
docker ps --format '{{.Names}}  {{.Ports}}' | grep -E 'arcunara|18088|28088' || true
test ! -e /opt/arcunara-rc21-preview || echo '目录已存在：不要覆盖，请先检查内容'
```

必须先人工确认 `29088/29089` 均未被占用，`/opt/arcunara-rc21-preview` 不包含其他业务数据，服务器磁盘与 Docker 可用。任何不满足时停止，不能自行停止生产服务。下列命令仅为准备说明，不代表已运行。

## 获取 GitHub 已通过 CI 的主分支代码

```bash
sudo mkdir -p /opt
cd /opt
# 新目录不存在时才执行 clone；不要用旧目录覆盖：
git clone https://github.com/xiongfh2008/arcunara-studio.git arcunara-rc21-preview
cd /opt/arcunara-rc21-preview
git rev-parse --short HEAD
```

在 GitHub PR 合并后再运行。将仓库固定在**经 CI 验证的 RC21 Commit**；不要 `git push --force`，也不要在 VPS 直接开发源代码。

## 准备完全独立的数据与密钥

```bash
cd /opt/arcunara-rc21-preview
mkdir -p infra/rc21-preview/data infra/rc21-preview/secrets
umask 077
test -s infra/rc21-preview/secrets/api_token || openssl rand -hex 32 > infra/rc21-preview/secrets/api_token
touch infra/rc21-preview/secrets/ai_api_key    # 默认留空，AI 关闭
sudo chown -R 1000:1000 infra/rc21-preview/data infra/rc21-preview/secrets
chmod 600 infra/rc21-preview/secrets/api_token infra/rc21-preview/secrets/ai_api_key
```

敏感文件均在 `.gitignore` 忽略路径内；严禁把密钥、Token、实际用户数据提交到仓库或发送到聊天。

## 启动隔离环境（AI 默认关闭）

```bash
cd /opt/arcunara-rc21-preview
npm run preflight:rc21
docker compose -f infra/rc21-preview/compose.yaml config --quiet
docker compose -f infra/rc21-preview/compose.yaml up -d --build
docker ps --filter name=arcunara-api-rc21-preview
curl -sS --fail http://127.0.0.1:29088/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:29088/console
```

若 VPS 未安装 Node.js，则 `npm run preflight:rc21` 可在开发机或 GitHub CI 上运行；Docker 构建内含 Node.js 24。绝不可因为 `npm` 不存在就使用 root 修改旧项目目录。

## Windows 本地浏览器查看效果

在 Windows PowerShell 中用已有 SSH 主机信息打开转发（保持窗口打开）：

```powershell
ssh -N -L 29088:127.0.0.1:29088 -L 29089:127.0.0.1:29089 root@YOUR_VPS_IP
```

之后浏览器访问：

- 工作台：`http://127.0.0.1:29088/console`
- 预览：`http://127.0.0.1:29089/p/{项目 UUID}/`

需要用 VPS 上 `infra/rc21-preview/secrets/api_token` 的管理员 Token 在工作台连接；不要在 URL 中添加 Token。此验收环境默认不开放成员登录，不启用独立公网静态站点。可测试项目创建、HTML/CSS/JS 文件树、修改、差异、草稿静态预览、版本保存/回滚以及现有 Axure 源文件导出。

## 可选：启用真实 DeepSeek 生成（会收费）

确认管理员同意支付 API 费用后，在 VPS 的交互 shell 中安全输入密钥：

```bash
cd /opt/arcunara-rc21-preview
read -rsp 'DeepSeek API Key: ' ARCU_KEY; echo
printf '%s' "$ARCU_KEY" > infra/rc21-preview/secrets/ai_api_key
unset ARCU_KEY
chmod 600 infra/rc21-preview/secrets/ai_api_key
ARCU_AI_ENABLED=1 docker compose -f infra/rc21-preview/compose.yaml up -d --force-recreate
```

启用后管理员重新连接工作台，应出现「AI 生成原型」入口；若密钥、额度或网络异常，将显示上游错误而非伪造页面。该功能目前每单进程每日最多 20 次、同时最多 1 次；进程重启会重置计数，尚不能视为严格财务预算。需要停用时设 `ARCU_AI_ENABLED=0` 重新创建**本测试容器**，不要停止其他容器。

## 验收顺序

1. 工作台无错误、可打开 RC21 多文件编辑器；1440px、1024px、768px、390px 均可操作。
2. 上传包含 CSS/JS/图片的 ZIP，新版本更新 CSS/JS 后图片不丢失；旧版本与 ZIP 导出不变。
3. 打开两个浏览器窗口编辑同一项目，先保存的成功，后保存的应出现 409 提醒，而非静默覆盖。
4. HTML 草稿 sandbox 不能执行脚本、表单或外部请求；保存后可通过原有预览访问新版本。
5. 启用 AI 的情况下（可选），真实生成草稿、审核、创建项目，核对 DeepSeek 消耗。
6. 正式站点版本锁定通过 CI 模拟独立站点 Listener 验证。此 Compose 默认禁用公开站点及域名路由，**不能声称公网发布验收已经完成**。
7. 验收前后比较现有 `18088/18089`、`28088/28089` 的运行状态，确保未受影响。

## 只停止 RC21 测试环境

```bash
cd /opt/arcunara-rc21-preview
docker compose -f infra/rc21-preview/compose.yaml down
```

`down` 只移除此独立 Compose 项目的容器/网络，不删除测试数据目录或任何现有服务；禁止使用 `docker system prune`、`docker compose down -v` 或覆盖旧项目数据。