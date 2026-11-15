# 部署说明（独立 v0.3.0 测试环境）

部署目标：在一台 Docker 主机上启动与现有部署完全隔离的 Arcunara Studio v0.3.0 测试环境。

**所有命令一律从 GitHub 仓库根目录执行**（即 `arcunara-studio/` 目录，包含 `package.json` 的那层）。
本环境绝不触碰 `/opt/arcunara-studio-dev`（现有 v0.2.0 部署）、18088/18089 端口，或任何其他服务。

## 硬性禁止事项

- ❌ **禁止**使用与现有 v0.2.0 部署相同的 Compose 项目名（其项目名为 `arcunara-studio-dev`，由目录名派生）。本项目名固定为 **`arcunara-studio-v03-test`**。
- ❌ **禁止**占用 18088/18089 或任何现有业务端口。
- ❌ **禁止**部署到 `/opt/arcunara-studio-dev` 或在其目录内运行任何命令。
- ❌ **禁止**停止、重建、修改任何现有生产容器（WallHaze、VidSavey、Tarot 等）。
- ❌ **禁止**执行 `docker system prune` 或任何全局清理命令。
- ❌ **禁止**将 Token、data/ 目录内容提交到 Git。

## 与 v0.2.0 的兼容性

- v0.3.0 直接读取 v0.2.0 数据目录（旧项目按隐式 v1 提供服务），无需迁移、不修改旧文件。
- 回滚 = 停止 v0.3.0 容器 → 在 legacy 部署目录用原 compose 启动；v0.3.0 写入的
  `meta.json`/`versions/` 对 v0.2.0 代码不可见，双向安全。详见下文"回滚"。

## 隔离性设计

| 维度 | 本环境（v0.3.0 测试） | 现有 VPS v0.2.0 部署 |
| --- | --- | --- |
| Compose 项目名 | `arcunara-studio-v03-test`（compose 文件内显式声明） | `arcunara-studio-dev`（目录名派生） |
| 容器名 | `arcunara-studio-api-v03-test` | 自动生成 |
| API 端口 | `127.0.0.1:28088` | `127.0.0.1:18088` |
| 预览端口 | `127.0.0.1:28089` | `127.0.0.1:18089` |
| 数据目录 | `<仓库根>/infra/docker/data/` | 其部署目录内 `data/` |
| Token | `<仓库根>/infra/docker/secrets/api_token` | 其部署目录内 `secrets/api_token` |

运行前执行 `npm run preflight`（CI 亦运行）自动校验：项目名不冲突、宿主端口不相交、
数据/Token 卷为栈内相对路径、无 host 网络、预览链接配置存在。

## 部署前检查（在仓库根目录逐条执行）

```bash
# 1. 确认 Docker 引擎可用
docker info

# 2. 确认目标宿主端口空闲（两条都应无输出）
netstat -ano | grep ":28088" | grep LISTEN
netstat -ano | grep ":28089" | grep LISTEN

# 3. 确认现有部署仍在运行且不受影响（示例端口；有输出即为在运行）
docker ps --format '{{.Names}}\t{{.Ports}}' | grep 18088

# 4. 确认当前不存在同名 Compose 项目（无输出 = 无冲突）
docker compose ls --format json | grep arcunara-studio-v03-test || echo "项目名可用"

# 5. 静态隔离预检（项目名/端口/卷/安全姿态）
npm run preflight

# 6. 确认工作目录正确（应显示 arcunara-studio 仓库根）
pwd
```

## 部署步骤（仓库根目录逐条复制执行）

```bash
# 1. 准备数据与 Token 目录
mkdir -p infra/docker/data infra/docker/secrets

# 2. 生成 Token（仅存于本地文件，绝不提交）
openssl rand -hex 32 > infra/docker/secrets/api_token

# 3. 设置权限（容器内 node 用户 uid=1000/gid=1000；Linux 上必须 chown，本地 Docker Desktop 可跳过）
sudo chown -R 1000:1000 infra/docker/data infra/docker/secrets
chmod 600 infra/docker/secrets/api_token

# 4. 构建镜像并启动（--build 保证使用当前代码；不要用不受控的 latest）
docker compose -f infra/docker/compose.yaml up -d --build

# 5. 等待健康检查（约 10–30s）
docker inspect --format '{{.State.Health.Status}}' arcunara-studio-api-v03-test
```

## 验收检查（仓库根目录逐条执行）

```bash
# 健康检查（无需鉴权）
curl -s http://127.0.0.1:28088/health
# 期望: {"ok":true,"service":"arcunara-studio-dev","version":"0.3.0"}

# 无 Token 应被拒绝（401）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28088/api/projects

# 有 Token 应成功（200）
TOKEN=$(cat infra/docker/secrets/api_token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:28088/api/projects

# 创建 ZIP 项目（multipart）
curl -s -X POST http://127.0.0.1:28088/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=Smoke" -F "description=acceptance" \
  -F "file=@prototype.zip"
# 用返回的 previewPath 验证预览（28089）:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28089/p/{id}/

# 工作台页面（200）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28088/console

# 确认 Compose 项目名与容器名正确
docker inspect arcunara-studio-api-v03-test \
  --format '{{index .Config.Labels "com.docker.compose.project"}} / {{.Name}}'
# 期望: arcunara-studio-v03-test / /arcunara-studio-api-v03-test

# 确认现有部署端口未被占用（18088 应仍有响应）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18088/health
```

**远程访问（SSH 本地端口转发）**：在本地笔记本执行

```bash
ssh -L 28088:127.0.0.1:28088 -L 28089:127.0.0.1:28089 <user>@<vps>
```

然后本地浏览器访问 `http://127.0.0.1:28088/console`。工作台的预览链接默认指向
`http://127.0.0.1:28089`（由 compose 的 `ARCU_PREVIEW_PUBLIC_BASE_URL` 控制），
转发后可直接点击。如需更换公网预览域名，设置该环境变量并
`docker compose -f infra/docker/compose.yaml up -d` 重建容器即可，工作台代码无需改动。

日志与停止：

```bash
docker compose -f infra/docker/compose.yaml logs -f api
docker compose -f infra/docker/compose.yaml down        # 仅停止本环境（保留 infra/docker/data/）
```

`down` 只移除本项目名（`arcunara-studio-v03-test`）的容器与网络，不会影响任何其他容器。

## 回滚

1. 停止本环境（数据保留）：

   ```bash
   docker compose -f infra/docker/compose.yaml down
   ```

2. 如需回到已验证的 v0.2.0 原始部署，在其部署目录使用其自带 compose 启动（18088/18089
   与其自身 data/secrets，与本环境互不影响）。
3. 如需将本环境回退到历史代码版本，按 **GitHub 指定 Commit → 拉取 → docker build（`-t arcunara-studio:<sha>`）→
   修改 compose `image:` 标签 → `up -d` → 验证** 执行；不要依赖 `latest` 作为唯一回滚依据。

## 注意事项

- `data/` 与 `secrets/` 已被 `.gitignore` 排除，任何环境的数据与 Token 都不得进入仓库。
- 端口 28088/28089 如被占用，修改 `compose.yaml` 中 `ports` 的宿主机侧端口，并同步设置
  `ARCU_PREVIEW_PUBLIC_BASE_URL` 为新的预览端口；容器内端口保持 3000/3001。
- 不要在本环境与现有部署之间共享数据目录或 Token 文件。
