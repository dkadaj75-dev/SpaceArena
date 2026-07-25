# Space Arena

Fast-paced arcade 3D space arena combat in the browser — one finger is enough. Built as a data-driven engine (Babylon.js client, Colyseus server, shared TS sim) plus a constellation of designer-facing editors, so ships, arenas, modules, and bots are authored as JSON content rather than hardcoded logic. See `ROADMAP.md` for the full architecture and phase plan.

## Dev commands

- `npm install` — install all workspace dependencies
- `npm run dev` — start the Vite client dev server
- `npm run dev:server` — start the placeholder server with `tsx watch`
- `npm run test` — run the Vitest suite
- `npm run lint` — run ESLint
- `npm run typecheck` — typecheck all workspaces
- `npm run build` — production client build (`client/dist`)
- `npm run bundle:budget` — enforce the initial-payload budget on that build
- `npm run validate:content` — run the content pack through every schema
- `npm run test:e2e` — Playwright smoke test (boots both servers itself)
- `npx tsx tools/generate-pwa-icons.ts` — regenerate the PWA icons in `client/public/`

## Production

One container is the whole game (ROADMAP §11 6.3): the Colyseus WebSocket
transport, the REST API, SQLite, the content pack **and** the built client all
answer on a single port and a single origin. Same-origin means the browser never
needs CORS, and `client/src/core/serverConfig.ts` dials the page's own origin in
a production build rather than a hardcoded `:2567`.

```sh
docker build -t space-arena .
docker run -p 2567:2567 -v space-arena-data:/data \
  -e JWT_SECRET="$(openssl rand -base64 48)" space-arena
```

### Environment

Every variable is parsed and validated once, at boot, by `server/src/env.ts`.
Problems are collected and reported together, and in production a fatal one
stops the process **before** it binds a socket or opens the database.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on every strict check below, and turns **off** the `/monitor` dashboard and the `/api/auth/dev-login` route. |
| `PORT` | `2567` | Must be an integer 1–65535. Serves HTTP + WebSocket. |
| `JWT_SECRET` | insecure dev fallback | **Required in production**, ≥ 32 characters, rejected if it is a known placeholder or has fewer than 8 distinct characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `SPACE_ARENA_DB` | `<cwd>/data/space-arena.db` | SQLite file (`:memory:` for throwaway runs). In the image this is `/data/space-arena.db` on a mounted volume; the directory is created at boot. |
| `CORS_ORIGIN` | dev: any `*:5173` | Comma-separated bare origins (`https://play.example.com`). **Unset in production means same-origin only**, which is what the single-container deploy wants; set it only when the client is hosted elsewhere. `*` is refused in production. |
| `CONTENT_DIR` | repo `content/` | Content pack served at `/content/*` and loaded by the simulation. Must contain `manifest.json`. Point it at a mounted volume to swap packs without rebuilding. |
| `CLIENT_DIR` | repo `client/dist` | Built client to serve. |
| `SERVE_CLIENT` | on iff `CLIENT_DIR` has an `index.html` | Set `0` to run API-only (e.g. behind a separate CDN). |
| `COLYSEUS_MONITOR` | off in production | `1` re-enables `/monitor` in production. Put it behind admin auth first (ROADMAP §11 6.4). |
| `VITE_SERVER_URL` | same origin | **Build-time**, client-side. Only for split deploys where the static client and the game server live on different origins. |

### Caching

`server/src/staticSite.ts` sets exactly two policies: `immutable, max-age=1y`
for `/assets/*` (Vite writes content-hashed filenames there, so a URL's bytes
never change) and `no-cache` for everything else — `index.html`, `sw.js`, the
manifest, the icons and all of `/content/*`. Content packs therefore go live
without a redeploy, which the service worker reinforces by treating
`/content/*.json` as network-first.
