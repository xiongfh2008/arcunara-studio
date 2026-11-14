# 部署说明（独立开发环境）

本文档描述使用 `infra/docker/` 部署一个**与现有 VPS 开发部署完全隔离**的 Arcunara Studio v0.3.0 环境。

## 适用范围与边界

- ✅ 适用于本地 Docker 或 VPS 上的独立新目录。
- ❌ 本流程**不会**触碰 `/opt/arcunara-studio-dev`（现有 v0.2.0 部署）、生产网站 `arcunara-web` 或其他 VPS 服务。
- ❌ GitHub Actions 不做自动部署；所有部署均为手动执行本文档步骤。
- ⚠️ 公网部署前必须先阅读 `docs/KNOWN_LIMITATIONS.md`（预览独立域名为硬性要求）。

## 与 v0.2.0 的兼容性

- **API 行为**：v0.2.0 的 `/health`、鉴权语义、项目列表、JSON 创建、预览 `/p/{id}/` 全部保持兼容（`/health` 的 `version` 字段更新为 `0.3.0`；列表/创建响应为增量新增字段）。
- **数据目录**：v0.3.0 直接读取 v0.2.0 数据目录（旧项目按隐式 v1 提供服务），**无需迁移、不修改旧文件**；首次对旧项目上传新版本时自动记录 v1 并发布 v2，可随时回滚回旧内容。
- **回滚方案**：如需回退到 v0.2.0，停止 v0.3.0 容器、用 `legacy-v02/compose.yaml` 原样启动即可 —— v0.3.0 写入的 `meta.json`/`versions/` 目录对 v0.2.0 代码不可见（它只读根目录 `index.html` 与 `meta.json` 的 id/name/createdAt 字段），旧版本功能不受影响；再次升级到 v0.3.0 后这些项目继续正常服务。

## 隔离性设计

| 维度 | 本环境 | 现有 VPS 开发部署 |
| --- | --- | --- |
| Compose 项目名 | `arcunara-studio-dev` | 由目录名派生 |
| 容器名 | `arcunara-studio-api-dev` | 自动生成 |
| API 端口 | `127.0.0.1:28088` | `127.0.0.1:18088` |
| 预览端口 | `127.0.0.1:28089` | `127.0.0.1:18089` |
| 数据目录 | `infra/docker/data/` | 部署目录内 `data/` |
| Token | `infra/docker/secrets/api_token` | 部署目录内 `secrets/api_token` |

## 安全与资源限制

- 镜像 `node:24-alpine`（由 `infra/docker/Dockerfile` 构建，依赖烘焙进镜像，非 root 运行）
- 根文件系统只读，`/tmp` 为 tmpfs
- `cap_drop: ALL`、`no-new-privileges:true`
- 限制：`cpus 0.30`、`mem_limit 192m`、`pids_limit 64`
- 健康检查：容器内 `fetch http://127.0.0.1:3000/health`
- Token 与数据运行时注入，**绝不写入镜像**；不使用 host 网络；不连接其他服务网络

## 部署步骤

```bash
# 1. 在仓库根目录
cd infra/docker

# 2. 准备目录（容器内 node 用户 uid=1000）
mkdir -p data secrets
sudo chown -R 1000:1000 data secrets

# 3. 生成 Token（仅存于本地文件，绝不提交）
openssl rand -hex 32 > secrets/api_token
chmod 600 secrets/api_token

# 4. 构建并启动（compose 自动执行 docker build）
docker compose -f infra/docker/compose.yaml up -d --build
```

## 验收检查

```bash
# 健康检查（无需鉴权）
curl -s http://127.0.0.1:28088/health
# 期望: {"ok":true,"service":"arcunara-studio-dev","version":"0.3.0"}

# 容器健康状态
docker inspect --format '{{.State.Health.Status}}' arcunara-studio-api-dev
# 期望: healthy

# 无 Token 应被拒绝（401）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28088/api/projects

# 有 Token 应成功（200）
TOKEN=$(cat infra/docker/secrets/api_token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:28088/api/projects
```

创建 ZIP 项目并预览（multipart）：

```bash
curl -s -X POST http://127.0.0.1:28088/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=Smoke" -F "description=acceptance" \
  -F "file=@prototype.zip"
# 用返回的 previewPath 访问: curl -s http://127.0.0.1:28089/p/{id}/
```

工作台：浏览器打开 `http://127.0.0.1:28088/console`，粘贴 Token 后即可管理项目。

日志与停止：

```bash
docker compose -f infra/docker/compose.yaml logs -f api
docker compose -f infra/docker/compose.yaml down        # 停止（保留 data/）
```

## 回滚

1. 停止并移除本环境（数据保留在 `infra/docker/data/`）：

   ```bash
   docker compose -f infra/docker/compose.yaml down
   ```

2. 如需回到已验证的 v0.2.0 原始部署，在 legacy 部署目录使用其自带 compose 启动
   （18088/18089 端口与自身 data/secrets，与本环境互不影响）。详见上文"与 v0.2.0 的兼容性"。

3. 如需将本环境回退到某个历史代码版本，按 **GitHub 指定 Commit → 拉取 → docker build（`-t arcunara-studio:<commit-sha>`）→ 修改 compose `image:` 标签 → up -d → 验证** 的流程操作；
   不要依赖 `latest` 标签作为唯一回滚依据。

## 注意事项

- `data/` 与 `secrets/` 已被 `.gitignore` 排除，任何环境的数据与 Token 都不得进入仓库。
- 端口 28088/28089 如被占用，修改 `compose.yaml` 中 `ports` 的宿主机侧端口即可；容器内端口保持 3000/3001。
- 不要在本环境与现有部署之间共享数据目录或 Token 文件。
