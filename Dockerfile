# Space Arena — production image (ROADMAP §11 6.3).
#
# One container is the whole game: the Colyseus WebSocket transport, the REST
# API, the SQLite database, the content pack, AND the built client — all on one
# port, one origin (see server/src/staticSite.ts). That is what makes 6.4's
# single-container deploy possible and why the browser never needs CORS.
#
# Three stages:
#
#   deps    — production node_modules only. Gets the C toolchain so
#             better-sqlite3 and argon2 can compile if a prebuilt binary is
#             missing for the target architecture; the toolchain never leaves
#             this stage.
#   builder — every dependency, then `npm run typecheck` (a broken build must
#             fail here, not at 3 a.m. in prod) and `vite build`.
#   runtime — slim node:22, no compilers, non-root, just the app.
#
# Why the server ships as TypeScript run through tsx rather than compiled
# JavaScript: `@space-arena/shared` is consumed as source (its package exports
# point at `src/index.ts`), which the client's bundler and the server's loader
# both handle natively. Emitting JS for the server alone would mean emitting and
# re-pointing shared too, and buying a dev/prod divergence in exchange for a
# startup cost tsx already amortizes. `tsx` is therefore a runtime dependency of
# @space-arena/server, not a dev one — see server/package.json.
#
# Build:  docker build -t space-arena .
# Run:    docker run -p 2567:2567 -v space-arena-data:/data \
#           -e JWT_SECRET="$(openssl rand -base64 48)" space-arena

# ---------------------------------------------------------------------------
# Stage 1 — production dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# node-gyp's fallback path for better-sqlite3 / argon2. Both ship prebuilt
# linux binaries, so this is normally unused — but a missing prebuild would
# otherwise turn into an obscure install failure instead of a slow success.
# Confined to this stage: the runtime image has no compiler in it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Manifests first, so `npm ci` re-runs only when a dependency actually changes.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Server + shared, runtime dependencies only. The client's 3D toolchain is a
# build-time concern and belongs in the builder stage, not in the image.
RUN npm ci --omit=dev \
  --workspace @space-arena/server \
  --workspace @space-arena/shared \
  --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2 — build the client
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY content ./content

# Gate: a type error must fail the image build. Cheap here, expensive in prod.
# The three workspace projects only — the root `npm run typecheck` also covers
# tools/ and the Playwright suite, neither of which is in the build context.
RUN npm run typecheck --workspace @space-arena/shared \
  && npm run typecheck --workspace @space-arena/server \
  && npm run typecheck --workspace @space-arena/client

# Vite build → client/dist (hashed chunks + PWA manifest + service worker).
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=2567 \
    CONTENT_DIR=/app/content \
    CLIENT_DIR=/app/client/dist \
    SPACE_ARENA_DB=/data/space-arena.db

# tsx resolves tsconfig relative to the CWD, and the Colyseus state schema needs
# `experimentalDecorators` from server/tsconfig.json. Without this the process
# dies at import time on the first `@type(...)` with a bare
# "Cannot read properties of undefined (reading 'constructor')".
ENV TSX_TSCONFIG_PATH=/app/server/tsconfig.json

# `node` (uid 1000) ships with the base image. /data is the SQLite volume mount
# point and must be writable by it — the app opens the DB and creates the WAL
# sidecar files there at boot.
RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node server ./server
COPY --chown=node:node content ./content
# Only the client's BUILD OUTPUT ships. The deps stage installed just the server
# and shared workspaces, so node_modules has no @space-arena/client link to
# leave dangling — client/ exists in the runtime purely as static files.
COPY --from=builder --chown=node:node /app/client/dist ./client/dist

USER node

# Persist SQLite across container replacements. `docker run -v space-arena-data:/data`
VOLUME ["/data"]

# Informational. The listen port is PORT; publish whatever it is set to.
EXPOSE 2567

# Hits the Express /health endpoint through the real port, so a server that
# booted but failed to bind is reported unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `npm run start` would fork an extra process between the init system and node;
# calling tsx directly keeps node as PID 1's only child so SIGTERM reaches the
# graceful-shutdown handler in server/src/index.ts.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
