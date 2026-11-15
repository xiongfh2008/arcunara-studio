# 静态原型示例 / Static prototype example

一个最小、可直接发布的 HTML 原型项目，用于验证 Arcunara CLI 的完整链路
（目录打包 → 相对路径 → 中文文件名 → 外部 CSS/JS → 预览更新）。

A minimal, directly publishable HTML prototype used to verify the full
Arcunara CLI path (directory auto-zip → relative paths → Unicode file
names → external CSS/JS → preview update).

## 发布 / Publish

```bash
# 1) 初始化（一次性；写入 .arcunara.json，不含密钥）
node packages/cli/arcunara.mjs init --project <project-uuid> \
  --api http://127.0.0.1:28088 --preview-base http://127.0.0.1:28089

# 2) 设置部署密钥（环境变量，绝不写入文件）
export ARCU_DEPLOY_KEY=dpk_...        # bash
$env:ARCU_DEPLOY_KEY = "dpk_..."      # PowerShell

# 3) 发布
node packages/cli/arcunara.mjs deploy examples/static-prototype

# 4) 持续修改 + 自动发布
node packages/cli/arcunara.mjs watch examples/static-prototype
```

发布后打开输出的预览地址：应看到样式生效、脚本状态行更新、两页相对路径
导航可用。修改 `index.html` 后再次 deploy/watch，刷新同一预览地址即可看到
新内容（版本自动递增，重复内容自动跳过）。

After publishing, open the printed preview URL: styles apply, the script
status line updates, both relative links work. Edit `index.html`, deploy
again, and the SAME preview URL shows the new content.
