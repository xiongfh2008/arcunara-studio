# RC14 — GitHub Actions 自助自动部署向导

## 用户操作

1. 打开 Arcunara Studio 工作台，选择已有项目。
2. 在项目详情的「自动部署」页创建**项目级部署密钥**
   `ARCU_DEPLOY_KEY`（仅显示一次），妥善保存。
3. 在「GitHub Actions 自动部署」中选择静态构建目录
   `dist` / `build` / `out` / `public`，
   构建方式选择 `npm ci + npm run build` 或「已有静态产物」。
4. 点击「生成工作流」→「下载 YAML」。
5. 将文件放入**网站代码仓库**的
   `.github/workflows/arcunara-deploy.yml`。
6. 在网站代码仓库 Settings → Secrets and variables → Actions
   创建两个 Repository secrets：
   - `ARCU_API_BASE`：**已有且经授权**的 Arcunara HTTPS API 地址；
   - `ARCU_DEPLOY_KEY`：第三步从当前项目复制的部署密钥。
   项目 UUID 不是密钥，已内嵌在生成的 YAML 中。
7. 用户审核 YAML 和构建脚本后自行提交至网站仓库的 main 分支。
   未来每次 main 推送或手动触发 workflow_dispatch 时会尝试部署。
8. 以 GitHub Actions 的实际日志、Arcunara 当前版本和网站预览来
   **确认成功**，不能把生成 YAML 当作部署成功。

## 代码与接口

管理员鉴权：
`GET /api/projects/{projectUuid}/github-workflow?outputDir=dist&buildMode=npm`

返回：
`{fileName,content,outputDir,buildMode,requiredSecrets,actionCommit}`。

输入严格枚举，没有任意代码/任意路径插入；不读取、不传递、也不
持久化任何 GitHub OAuth token 或 Arcunara API 密钥。
部署密钥无权调用生成接口或修改项目设置；回收站项目不能生成。

YAML 里的组合 Action pin 到已审核过的不可变 Git 提交
`0f61b040694502d0c7a13be78f1ab5b845335b36`，而不是活动
`@main`。未来升级 Action 时，应主动复核并更新该哈希。

工作流只允许主分支推送/手动触发，不允许来自未经审核 PR 的
贡献者直接携带 Secrets 执行。用户需要确保仓库、依赖、
`package.json` 构建脚本和第三方 GitHub Actions 本身可信。

## 边界

- 只生成工作流文件，不自动注册 Github App、不拉取仓库、不运行
  自动化，也不修改用户其他 GitHub 仓库。
- 当前 VPS 测试 API 仍受 Cloudflare Access 和回环网络隔离，
  GitHub Hosted Runner **可能无法访问**；必须在独立发布阶段设计
  合适的机器身份或安全私有 Runner 连接，禁止为了 CI 直接开放
  管理员 API/绕过授权。
- 目标站点仍须完成 RC13 独立静态服务的安全发布；
  本向导本身只上传到 Arcunara 的版本数据仓库。
- 不支持 Next.js SSR、数据库或任意后端容器；不能因构建出
  JavaScript 就把不可信服务端脚本部署到 Arcunara API 内。
- GitHub Actions 若失败，现有内容版本不应被覆盖；
  用户可以检查 CLI 内容指纹与版本历史。

## 测试

`tests/rc14-github-workflow.test.mjs` 对 YAML 固定提交、私密
凭据占位符、输入安全、管理员权限和回收站禁用做自动化测试。
这不是完成 Cloudflare/VPS 端到端部署的证明。
