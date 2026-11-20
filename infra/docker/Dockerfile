# Arcunara Studio API — v0.3.0
#
# Build (from repo root):
#   docker build -f infra/docker/Dockerfile -t arcunara-studio:0.3.0 .
# Run:
#   see infra/docker/compose.yaml
#
# Non-root runtime, no shell tooling beyond the base image, dependencies
# baked in (no bind-mounted source in production). Tokens and data are
# injected at runtime — never baked into the image.

FROM node:24-alpine

WORKDIR /app

# Production dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code (server, lib modules, workbench page).
COPY apps/api ./apps/api
# API routes import the Axure IR and RP/1 converter packages at startup.
COPY packages/rp-converter ./packages/rp-converter

ENV NODE_ENV=production

# Runtime identity: non-root (uid 1000 = "node").
USER node

EXPOSE 3000 3001

CMD ["node", "apps/api/server.mjs"]
