---
name: arcunara-publish
description: One-command local deployment of a prebuilt static website to an existing Arcunara Studio project.
---

# Arcunara — publish AI-generated static websites

Use only after the user asks to publish or update an Arcunara project. This Skill
does **not** create a public service, bypass authorization or deploy backends.
It runs on the user's development machine, not on the Arcunara VPS.

## Inputs to collect (only when not already configured)

- Existing Arcunara project UUID from the web workbench
- API URL (HTTPS in real use)
- Project-scoped `ARCU_DEPLOY_KEY`, supplied through the user's environment
  or credential manager **never** ask the user to paste it into chat
- Source directory containing `package.json` or prebuilt dist/build/out

## Workflow

1. Confirm `package.json` build script or an existing static `index.html`
   in dist/build/out. Refuse deployment of Node/Python servers, Next.js SSR,
   databases, .next, or arbitrary executable code.
2. Run `node <arcunara-repo>/packages/cli/arcunara.mjs init --project <uuid> --api <https-api> --preview-base <preview-base>`
   only if the local .arcunara.json is not configured. This config has no
   credential fields.
3. Build and deploy from the website root:
   `node <arcunara-repo>/packages/cli/arcunara.mjs publish`
   (automatically runs local `npm run build` if configured).
   For already built static output:
   `node <arcunara-repo>/packages/cli/arcunara.mjs publish --skip-build --dir dist`
4. Return actual result from CLI: project UUID, current version and preview URL.
   If the CLI errors, show its error; do not claim deployment succeeded.
5. Never print, log, commit or embed `ARCU_DEPLOY_KEY`, API admin tokens,
   .env files or project secrets in the website distribution.

## Security

- Build commands are executed on the user's machine only, never on the VPS.
- A deploy key can update the bound project's versions but cannot edit shares,
  project settings, other projects or roll back.
- Only plain static files (HTML/CSS/JS/assets) are supported. For React/Vue/Vite
  the local build must output an index.html inside one of the allowed folders.
- Arcunara Preview is sandboxed and is **not** equivalent to full public web
  hosting. Public website hosting requires the separate site runtime planned
  for a future release.
- In current staging, public API access for CLI may still require an approved
  secure connection; do not advise bypassing Cloudflare or exposing loopback
  ports on the internet.
