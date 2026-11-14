# 部署说明（独立开发环境）

本文档描述使用 `infra/docker/compose.yaml` 部署一个**与现有 VPS 开发部署完全隔离**的 Arcunara Studio v0.2.0 环境。

## 适用范围与边界

- ✅ 适用于本地 Docker 或 VPS 上新的独立目录。
- ❌ 本流程**不会**触碰 `/opt/arcunara-studio-dev`（现有 v0.2.0 开发部署）、生产网站 `arcunara-web` 或任何其他 VPS 服务。
- ❌ GitHub Actions 不做自动部署；所有部署均为手动执行本文档步骤。

## 隔离性设计

| 维度 | 本环境 | 现有 VPS 开发部署 |
| --- | --- | --- |
| Compose 项目名 | `arcunara-studio-dev` | 由目录名派生 |
| 容器名 | `arcunara-studio-api-dev` | 自动生成 |
| API 端口 | `127.0.0.1:28088` | `127.0.0.1:18088` |
| 预览端口 | `127.0.0.1:28089` | `127.0.0.1:18089` |
| 数据目录 | `infra/docker/data/` | 部署目录内 `data/` |
| Token | `infra/docker/secrets/api_token` | 部署目录内 `secrets/api_token` |

端口仅绑定 `127.0.0.1`，不映射任何生产业务端口。

## 安全与资源限制（与 legacy-v02/compose.yaml 完全一致）

- 镜像 `node:24-alpine`，以 `node` 用户运行
- 根文件系统只读（`read_only: true`），`/tmp` 为 tmpfs
- `cap_drop: ALL`、`no-new-privileges:true`
- 限制：`cpus 0.30`、`mem_limit 192m`、`pids_limit 64`
- 健康检查：容器内 `fetch http://127.0.0.1:3000/health`（15s 间隔 / 5s 超时 / 3 次重试 / 10s 启动期）
- `restart: unless-stopped`

## 部署步骤

前提：Docker 与 Docker Compose v2 可用。

```bash
# 1. 在仓库根目录
cd infra/docker

# 2. 准备目录（容器内 node 用户 uid=1000，data 必须可写）
mkdir -p data secrets
sudo chown -R 1000:1000 data secrets

# 3. 生成 Token（仅存于本地文件，绝不提交）
openssl rand -hex 32 > secrets/api_token
chmod 600 secrets/api_token

# 4. 启动（在仓库根目录执行，或带 -f 任意位置执行）
docker compose -f infra/docker/compose.yaml up -d
```

## 验收检查

```bash
# 健康检查（无需鉴权）
curl -s http://127.0.0.1:28088/health
# 期望: {"ok":true,"service":"arcunara-studio-dev","version":"0.2.0"}

# 容器健康状态
docker inspect --format '{{.State.Health.Status}}' arcunara-studio-api-dev
# 期望: healthy

# 无 Token 应被拒绝（401）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28088/api/projects

# 有 Token 应成功（200）
TOKEN=$(cat infra/docker/secrets/api_token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:28088/api/projects
```

创建项目并预览：

```bash
curl -s -X POST http://127.0.0.1:28088/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke","html":"<html><body><h1>ok</h1></body></html>"}'
# 用返回的 previewPath 访问: curl -s http://127.0.0.1:28089/p/{id}/
```

日志与停止：

```bash
docker compose -f infra/docker/compose.yaml logs -f api
docker compose -f infra/docker/compose.yaml down        # 停止（保留 data/）
```

## 回滚

本环境与 legacy 部署完全独立，回滚即"停用本环境、如需旧版则使用 legacy 文件启动"：

1. 停止并移除本环境（数据保留在 `infra/docker/data/`，可按需归档或删除）：

   ```bash
   docker compose -f infra/docker/compose.yaml down
   ```

2. 如需回到已验证的 v0.2.0 原始部署，在 legacy 目录使用其自带 compose 启动
   （使用 18088/18089 端口与其自身 data/secrets，与本环境互不影响）：

   ```bash
   # 在 legacy-v02 对应的部署目录（VPS 上为 /opt/arcunara-studio-dev）
   docker compose up -d
   ```

3. 如需将本环境回退到某个历史代码版本，`git checkout <commit>` 后重新
   `docker compose -f infra/docker/compose.yaml up -d`（server.mjs 以只读挂载，重启即生效）。

## 注意事项

- `data/` 与 `secrets/` 已被 `.gitignore` 排除，任何环境的数据与 Token 都不得进入仓库。
- 端口 28088/28089 如被其他服务占用，可修改 `compose.yaml` 中 `ports` 的宿主机侧端口；容器内端口保持 3000/3001 不变。
- 不要在本环境与现有部署之间共享数据目录或 Token 文件。
