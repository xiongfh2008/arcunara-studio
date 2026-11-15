# AI 工具自动发布集成指南（RC6）

让 Codex、Trae、Claude Code 等 AI 编码工具在完成 HTML 原型后自动发布到
Arcunara Studio。**不需要修改 AI 工具本身**——AI 只需能执行 shell 命令。

## 典型工作流

```
AI 生成原型 → AI 修改原型 → （可选）本地构建 → arcunara deploy → 输出预览地址
```

## 一次性准备（人工操作）

1. 在工作台打开项目详情 →「自动部署」→ 创建部署密钥（有效期可选），**立即复制**完整 `dpk_...` 密钥（只展示一次）。
2. 本地设置环境变量（不要写进任何仓库文件）：
   - PowerShell：`$env:ARCU_DEPLOY_KEY = "dpk_..."`
   - bash/zsh：`export ARCU_DEPLOY_KEY=dpk_...`
3. 保持 SSH 隧道可用（测试实例仅监听服务器回环地址）：
   `ssh -L 28088:127.0.0.1:28088 -L 28089:127.0.0.1:28089 root@<server>`
4. 项目目录初始化：`node packages/cli/arcunara.mjs init --project <uuid> --api http://127.0.0.1:28088`

## 可复用的 AI 提示词模板

把下面的提示词放进 AI 工具的系统提示 / AGENTS.md / 项目说明：

```markdown
## 原型发布约定（Arcunara Studio）

本项目的 HTML 原型保存在 ./dist（或按用户指定目录）。当你完成或修改原型后：

1. 只创建/修改 ./dist 下的静态文件（HTML/CSS/JS/图片），使用相对路径引用资源。
2. 保存所有文件后，运行发布命令（密钥已在环境变量 ARCU_DEPLOY_KEY 中，
   不要读取、打印、复制或转存该变量的值）：
   node packages/cli/arcunara.mjs deploy ./dist
3. 命令输出包含「预览地址」，把它原样告诉用户。
4. 如果输出「内容未变化，未创建新版本」，告诉用户当前预览已是最新。
5. 如果命令失败，把 stderr 的错误信息原样告诉用户，不要重试超过 2 次，
   不要修改服务器或环境变量。
6. 禁止：删除或覆盖 .arcunara.json；把密钥写入任何文件；修改 dist 之外的文件。
```

Node.js 项目（需要构建）的补充提示词：

```markdown
6. 本项目需要构建：先运行 npm run build；构建成功且 ./dist 已生成后再执行
   发布命令；构建失败则不发布，直接报告构建错误。
```

对应 `.arcunara.json` 中配置（也可用 `--build` 显式触发，`--build-command` 覆盖）：

```json
{
  "projectId": "45ec79e9-444d-4801-a71a-0439520150e6",
  "apiBase": "http://127.0.0.1:28088",
  "previewBase": "http://127.0.0.1:28089",
  "uploadDir": "./dist",
  "buildCommand": "npm run build"
}
```

CLI 只在用户显式传 `--build`（或 `--build-command`）时执行构建命令，不会
自动执行来源不可信的任意脚本。

## CI / 脚本集成示例（Node 项目）

```yaml
# 任意 CI 中（伪代码）：
steps:
  - run: npm ci
  - run: npm run build
  - run: node packages/cli/arcunara.mjs deploy ./dist
    env:
      ARCU_DEPLOY_KEY: ${{ secrets.ARCU_DEPLOY_KEY }}
      ARCU_API_BASE: http://127.0.0.1:28088
```

幂等性保证：同一内容重复发布不会产生重复版本，CI 重跑安全。

## 示例项目

- 静态原型示例：`examples/static-prototype/`（含说明）
- 命令参考：`packages/cli/README.md`

## 权限边界

部署密钥（dpk_）只能：上传本项目新版本、查询本项目状态与配额。
不能：创建/撤销分享链接、修改项目设置（含预览启停）、回滚版本、访问管理
员接口、访问其他项目。需要回滚时使用管理员 Token 的 `arcunara rollback`。
