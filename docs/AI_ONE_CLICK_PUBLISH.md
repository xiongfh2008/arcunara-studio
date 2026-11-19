# RC10 — AI 网站一键发布（本地开发完成，公网发布尚待独立环境）

## 已实现

`arcunara publish` 是 CLI 的新增一键命令，面向 Codex、Trae、Cursor、
Claude Code 和开发者本人。它按照以下顺序执行：

1. 从 `.arcunara.json`、`--project`/`--api`、环境变量读取项目信息和
   项目级部署密钥（**密钥不写入本地配置文件**）。
2. 自动识别本地 `package.json` 的 `scripts.build`，执行
   `npm run build`。如果配置了 `buildCommand`，则优先执行。
   `--skip-build` 用于现有静态产物。
3. 只识别明确含有常规 `index.html` 的 `dist`、`build` 或 `out` 目录；
   多个目录必须用 `--dir` 指定；没有静态输出时拒绝发布。
4. 复用现有 `publishOnce`，执行客户端配额检查、排除敏感文件、
   内容哈希去重、上传并自动形成新版本。
5. 显示真实部署结果、版本号与预览 URL。同一内容重复提交不重复建版。

### 使用

以下示例在生成网站的本地项目根目录执行。

```bash
# 在环境中设置 ARCU_DEPLOY_KEY（不要将密钥粘贴到终端历史、代码或聊天记录）
node /path/to/arcunara-studio/packages/cli/arcunara.mjs init --project <项目UUID> --api https://your-api.example --preview-base https://your-preview.example
node /path/to/arcunara-studio/packages/cli/arcunara.mjs publish
# 如果已提前构建：
node /path/to/arcunara-studio/packages/cli/arcunara.mjs publish --skip-build --dir dist
```

Windows 示例将 CLI 路径替换为
`D:\\Project\\arcunara-studio\\packages\\cli\\arcunara.mjs`。
请将域名占位符替换为**真实的、已获授权的 API 和预览地址**；
本功能不会自行创建这些地址。

### 安全与限制

- 仅支持**前端静态产物**：Vite/React/Vue 的静态构建与纯 HTML 网站。
- 明确不支持 Next.js SSR、Node/Python 服务端、数据库或 Docker 项目；
  不会在服务器运行用户上传的程序。
- 现有安全预览使用 CSP sandbox，不能视作正常生产网站托管；
  真正生产网站发布还需独立 Site Runtime/Origin 与自定义域名能力。
- 当前未自动开通公网 CLI API，Cloudflare Access/VPS 部署与配置仍需
  另行验收；这次只开发并测试本地 CLI 代码。
- 后续 GitHub 自动构建应由用户主动配置仓库 Secret、触发条件和权限，
  不得默认允许无授权 CI 公开发布。

## AI 代理安装与提示词

将 `integrations/skills/arcunara-publish/SKILL.md` 加入 AI 开发
工具支持的 Skill 目录，或直接把工作流要求提供给 AI 代理。

示例任务：

> 当前网站构建并通过检查后，使用 Arcunara Studio CLI 的 publish
> 命令部署到当前已绑定的项目。不要打印或提交部署密钥。
> 确认服务端返回新版本号之后再报告发布成功。
> 如果项目是 SSR/带数据库，停止并列出不支持的部分。

## 验收

新增 `tests/rc10-publish.test.mjs` 覆盖静态目录识别、SSR 拒绝、
构建脚本执行、项目级部署密钥、静态 HTML 正常发布、内容去重、
多个输出目录歧义拒绝以及失败后不改变已有版本。
