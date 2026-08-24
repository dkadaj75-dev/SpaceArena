# Hosting Orion's Arm online for free (testing)

How to put the game on the public internet for playtesting without paying anything. Ordered by how fast you'll be online; every option uses the same production build, so you can start with a tunnel today and move to a real host tomorrow.

## What you're deploying (read this first)

The production image is **one container = the whole game** (see `Dockerfile`): the Colyseus WebSocket transport, the REST API, the SQLite database, the content pack, **and the built client**, all served from **one port, one origin** (`server/src/staticSite.ts`). Because the browser loads the page and dials the WebSocket on the same origin, **no CORS setup is needed in production** — the client's `serverConfig.ts` resolves `location.origin` / `wss://<same-host>` automatically. Every option below leans on that.

Environment variables the server understands (`server/src/env.ts`):

| Variable | Testing value | Notes |
|---|---|---|
| `PORT` | `2567` (default) | Most PaaS hosts inject their own `PORT` — the server honors it. |
| `JWT_SECRET` | **required in production**, ≥ 32 chars | Generate: PowerShell `[Convert]::ToBase64String((1..48 \| %{Get-Random -Max 256}))` or `openssl rand -base64 48`. Weak/placeholder values are rejected. |
| `SPACE_ARENA_DB` | `/data/space-arena.db` | Point at a mounted volume if you want accounts to survive restarts. Testing without persistence is fine — accounts just reset. |
| `CORS_ORIGIN` | leave unset | Unset in production = same-origin only, which is exactly right for the single container. Only needed for a split client/server deploy (Option 5). |

Build and run locally to sanity-check before exposing anything:

```bash
docker build -t space-arena .
```

```bash
docker run -p 2567:2567 -v space-arena-data:/data -e SPACE_ARENA_DB=/data/space-arena.db -e JWT_SECRET="PASTE-A-48-CHAR-RANDOM-STRING-HERE" space-arena
```

Then open http://localhost:2567 — you should get the full game from the container (not the Vite dev server).

**No Docker?** The same thing runs bare: `npm ci`, `npm run build`, then `NODE_ENV=production JWT_SECRET=... node --import tsx server/src/index.ts` from the repo root (PowerShell: set the env vars with `$env:NODE_ENV="production"` etc. first). The Docker path is less error-prone.

---

## Option 1 — Cloudflare Tunnel from your own PC (fastest, recommended first)

Your PC keeps running the game; Cloudflare gives it a public HTTPS URL and carries the WebSocket. Nothing to sign up for in quick mode, nothing deployed, latency for you is zero because the server IS your PC.

1. Start the production container (above) so everything is on `localhost:2567`.
2. Install cloudflared: `winget install Cloudflare.cloudflared`
3. Start a **quick tunnel** (no account needed):

```bash
cloudflared tunnel --url http://localhost:2567
```

4. It prints a URL like `https://random-words.trycloudflare.com`. Open it on any phone, anywhere — that's your game. HTTPS and `wss://` websockets work out of the box; the pilots-online counter counts everyone who has it open.

Caveats:
- The quick-tunnel URL is **random and dies when cloudflared stops**. For a stable URL, make a free Cloudflare account, add a (cheap or free) domain, and create a **named tunnel** (`cloudflared tunnel create orion` + a `config.yml` mapping `play.yourdomain.com → http://localhost:2567`) — same tool, permanent URL, still free.
- Your PC must stay on, and its upload bandwidth is the game's bandwidth. For a 10-player test that's tiny (the sim sends deltas at 30 Hz), fine on any home connection.
- Don't tunnel the Vite dev server for public tests: dev is two origins (5173 + 2567) and dev has relaxed auth. Tunnel the production container.

**Alternatives in the same "expose my PC" family:**
- **Tailscale Funnel** — free, stable `https://<machine>.<tailnet>.ts.net` URL, needs a free Tailscale account and `tailscale funnel 2567`. Great if you already use Tailscale.
- **VS Code / Microsoft dev tunnels** — free with a GitHub account (`devtunnel host -p 2567 --allow-anonymous`), stable-ish URLs.
- **ngrok free** — works, but the free tier shows visitors an interstitial warning page before the game loads, which is annoying on phones. One tunnel, random URL.

## Option 2 — Render.com free web service (a real host that stays up while you sleep)

Free tier: 750 instance-hours/month for one web service, WebSockets supported, deploys straight from a GitHub repo with a Dockerfile.

1. Push the repo to GitHub (private is fine).
2. On render.com: New → Web Service → connect the repo. Render auto-detects the `Dockerfile`.
3. Environment: add `JWT_SECRET` (generate as above). Render injects `PORT` — the server honors it. Leave `CORS_ORIGIN` unset.
4. Deploy. You get `https://your-name.onrender.com` — the whole game, websockets included.

Caveats:
- **Free instances sleep after ~15 min idle** and take ~30–60 s to cold-start on the next visit. Fine for scheduled playtests, annoying for drive-by testers.
- **The disk is ephemeral on the free tier**: the SQLite file resets on every deploy/restart, so accounts and unlocks vanish. For testing that's usually acceptable; persistent disks are paid.
- Free instances are small (0.1 CPU / 512 MB). The server is light, but don't expect a 20-room load test.

## Option 3 — Oracle Cloud "Always Free" VM (genuinely free forever, most capable)

Oracle's always-free tier includes real VMs (up to 4 ARM OCPUs / 24 GB RAM split across instances) with a public IP — the only option here that's both free *and* a real, always-on server with a persistent disk.

1. Sign up (needs a credit card for identity, never charged on always-free shapes), create an **Ampere A1** instance with Ubuntu.
2. Install Docker, clone the repo, `docker build`, `docker run` with a volume for `/data` (accounts persist!).
3. Open port 443/80 in the VCN security list, and put TLS in front — easiest is **Caddy** (`caddy reverse-proxy --from yourdomain.com --to localhost:2567`, automatic Let's Encrypt) or run cloudflared on the VM to skip ports/DNS entirely.

Caveats: the signup and network-security-list steps are the least beginner-friendly of the bunch, and ARM capacity in popular regions sometimes takes a few tries to grab. Worth it if the test phase will last weeks.

## Option 4 — Koyeb / Fly.io (honourable mentions)

- **Koyeb**: one free "nano" web service, Docker deploys from GitHub, websockets fine, sleeps on idle like Render. A solid Render alternative if you hit its limits.
- **Fly.io**: excellent for this shape of app (`fly launch` reads the Dockerfile, gives you `wss://` and volumes), but its free allowance has shifted to a small trial credit rather than a permanent free tier — check current pricing before relying on it.

## Option 5 — Split deploy (static client on a CDN + server elsewhere) — only if you must

Cloudflare Pages / GitHub Pages host the **client** for free, but they cannot run the Colyseus server — Workers/Functions don't run a long-lived stateful WebSocket process like this one. So a "Cloudflare Pages" deploy still needs the server from Option 1–4, and now you have two origins:

- Build the client with `VITE_SERVER_URL=https://your-server.example` so it dials the right server (`client/src/core/serverConfig.ts` resolution order).
- Set `CORS_ORIGIN=https://your-pages-site.pages.dev` on the server.
- The client also has a `?server=` query override for ad-hoc pointing.

More moving parts, no cost advantage over the single container — use it only when you specifically want the CDN (e.g. many testers far from the server, or the offline-vs-bots mode served even when the server is down: the client handles an unreachable server by offering local bot play).

---

## Testing notes, whatever you pick

- **The PWA caches aggressively.** The service worker only registers in production builds, and it precaches the shell — after you deploy an update, testers may need a reload (the worker auto-updates, but an open tab can be one version behind). The red failure banner and `?diag=1` strip include the **build id**, so a screenshot always tells you which build a tester is actually running.
- **Renderer self-healing is live**: if a tester's device black-screens on WebGPU, the game auto-falls back to WebGL2 and reloads itself; a persistent failure shows the diagnostic banner — have them screenshot it.
- **Dev conveniences are hard-absent in production**: no dev-login, no editor save endpoints. Testers register real (throwaway) accounts — first registered account data lives in that deploy's SQLite.
- **The pilots-online counter** counts every open client via the health probe, so you can watch testers arrive from the main menu.
- **Latency expectations**: the sim runs server-side at 30 Hz. A tunnel from your PC gives your own region great pings; Render/Koyeb pick a region at deploy time — choose the one nearest your testers.
