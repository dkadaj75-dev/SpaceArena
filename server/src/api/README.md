# Space Arena — REST API (Phase 3)

Base URL: same origin as the game server (default `http://localhost:2567`).
All bodies are JSON; the server caps request bodies at **64 kb** and applies a
per-IP token-bucket rate limit to every `/api/*` route (429 on exhaustion).

Request-body schemas live in `shared/src/net/api.ts` (`@space-arena/shared`) so
the client can reuse them. Colyseus wire messages are documented separately in
`shared/src/net/protocol.ts`.

## Conventions

- **Auth:** send the access token as `Authorization: Bearer <accessToken>`.
  Access tokens expire in 15 min; refresh with `/api/auth/refresh` (refresh
  tokens last 7 days and are single-use — each refresh rotates them).
- **Errors:** every failure returns `{ "error": { "code": string, "message": string } }`
  with an appropriate HTTP status. Common codes: `invalid-body` (400),
  `unauthorized`/`invalid-token`/`invalid-guest-token` (401), `level-locked` (403),
  `not-found` (404), `email-taken`/`already-owned`/`already-registered`/
  `insufficient-credits`/`id-conflict` (409), `rate-limited` (429). Economy
  writes (module/upgrade buys, match rewards) are transactional and debit via a
  guarded conditional UPDATE, so concurrent requests can never overspend.
- **CORS:** the Vite dev origins (`http://localhost:5173`, `http://127.0.0.1:5173`)
  are allowed by default; override with the `CORS_ORIGIN` env var (comma list).

## Auth — `/api/auth`

All auth responses (except `/me`) return a **token pair + profile**:

```jsonc
{
  "accessToken": "<jwt>",
  "refreshToken": "<sessionId.secret>",
  "expiresIn": 900,                 // access-token TTL seconds
  "guestToken": "<hex>",            // /guest only — durable, store in localStorage
  "profile": { "userId", "displayName", "level", "xp", "credits", "isGuest" }
}
```

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /register` | optional | `{ email, password, displayName? }` | 201 new account. If a **valid guest** Bearer token is sent, the guest is upgraded **in place** (same id, progress kept, all prior sessions revoked) → 200. A present-but-invalid/expired token → `401 invalid-token` (never a silent new account). A full-account token → `409 already-registered`. `409 email-taken` on dup. |
| `POST /login` | — | `{ email, password }` | 200 + pair. `401 invalid-credentials` otherwise. |
| `POST /guest` | — | `{ displayName?, guestToken? }` | 201 creates a guest (returns `guestToken`). A known `guestToken` restores that guest → 200. A supplied-but-**unknown** `guestToken` → `401 invalid-guest-token` (does not mint a new guest). |
| `POST /refresh` | — | `{ refreshToken }` | 200 + a fresh pair (old refresh token is invalidated). `401 invalid-refresh`. |
| `GET /me` | **required** | — | `{ profile }`. |

Passwords: 8–200 chars, hashed with **argon2id**. `JWT_SECRET` is **required** in
production — a missing secret when `NODE_ENV=production` is a hard startup failure
(a dev fallback logs a boot warning otherwise). Colyseus join **fails closed**:
tokenless/invalid-token joins are accepted only when `DEV_ALLOW_ANON=1` **and**
`NODE_ENV!=='production'`; otherwise a valid access token is required.

## Fittings — `/api/fittings` (auth required)

A fitting is `{ id, user_id, ship_id, name, hardpointMap, created_at }` where
`hardpointMap` is `{ "<hardpointIndex>": "<moduleId>" }` (missing index = empty).

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{ fittings: Fitting[] }`. |
| `POST /` | `{ shipId, name, hardpointMap }` | 201 `{ fitting }`. Validated (below). |
| `PUT /:id` | `{ name?, hardpointMap? }` | 200 `{ fitting }`. 404 if not owned. |
| `DELETE /:id` | — | 200 `{ ok: true }`. 404 if not owned. |

**Validation** (400 with a specific `code`) — a fit is rejected only if *illegal*;
*risky* fits (e.g. idle energy draw > regen) are allowed:
- `unknown-ship` / `unknown-module` — id not in the content registry.
- `bad-hardpoint` — index out of range for the ship.
- `family-mismatch` — module family not in `hardpoint.accepts`.
- `not-owned` — user does not own the module.
- `level-locked` — module `requiresLevel` exceeds the user's level.

## Ships & upgrades — `/api/ships` (auth required)

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{ ships: [{ id, name, class, hardpoints, upgrades: { hull, engine, energy, heat } }] }`. `upgrades.*` = purchased level count per track (0 = base). |
| `POST /:shipId/upgrade` | `{ track }` | Buys the **next** level of `track` (`hull`/`engine`/`energy`/`heat`). 200 `{ shipId, track, level, credits }`. `409 insufficient-credits`, `400 max-level`. |

Upgrade level = count of purchased config levels; the next price comes from the
ship's `upgrade.<track>` config `levels[currentLevel]`. Max level = `levels.length`.

## Modules — `/api/modules` (auth required)

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{ modules: [{ id, name, family, level, price, requiresLevel, owned }] }`. |
| `POST /buy` | `{ moduleId }` | Spends `price` credits. 200 `{ moduleId, credits }`. `409 insufficient-credits`, `403 level-locked`, `409 already-owned`. |

## User configs — `/api/configs` (auth required)

Player-authored content (arenas, etc.), validated against the shared config
schemas. The server **forces** the id into the collision-proof namespace
`user.<fullUuidNoDashes>-<slug>` (a single dot is required by the config id
pattern, so the full user id and slug are dash-joined) and returns the final id.

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{ configs: [{ id, type, visibility, updatedAt, json }] }`. |
| `POST /` | `{ json, visibility? }` | 201 `{ config }` with the rewritten `id`. `400 invalid-config` if `json` fails its schema. `409 id-conflict` if the (namespaced) id somehow belongs to another user — upsert is owner-constrained. |
| `DELETE /:id` | — | 200 `{ ok: true }`. 404 if not owned. |

## Match rewards (Colyseus, not REST)

When a match ends, the server persists a `match_results` row and grants credits +
XP to each authenticated participant (`(win|loss) + frags * perKill` from the
gamemode's `rewards`, level from the progression `xpCurve`). Each rewarded client
receives an individual `simEvent` of type `matchRewards`:

```jsonc
{ "type": "matchRewards", "credits": 120, "xp": 120, "newLevel": 2, "leveledUp": true }
```

Kill attribution uses the sim's `entityDestroyed.killerId`; asteroid kills and
team-kills do not count toward `frags`. Rewards are **anti-farmed**: a room
created with a client-supplied `practiceTarget` or `minPlayers` override (which
enable trivially-winnable solo rooms) is marked ineligible — the `match_results`
row is still written (flagged `rewards_eligible=0`) but no credits/XP are granted,
and one authenticated user may occupy only one slot per room. `finalizeMatch`
persists the result and all profile writes in a single transaction and dedupes
rewards by userId.
