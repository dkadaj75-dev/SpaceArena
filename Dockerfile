# Space Arena — authoritative Colyseus server (Phase 2).
# Multi-stage: an install stage for cacheable deps, then a slim runtime.
# The server runs TypeScript directly via tsx (no separate build step yet).
# Client static serving is added in Phase 6; this image serves the game server
# (WebSocket + /health + optional /monitor) only.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies (cache on manifests before copying source)
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# Copy only manifests first so `npm ci` is cached until a package.json changes.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install the server + shared workspaces (skip the client's heavy 3D deps).
RUN npm ci --workspace @space-arena/server --workspace @space-arena/shared --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=2567

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY content ./content

EXPOSE 2567

# Lightweight healthcheck against the Express /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "--workspace", "@space-arena/server"]
