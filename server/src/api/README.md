# Orion's Arm — REST API (Phase 3)

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
| `GET /me` | **required** | — | `{ profile, inventory }`. `inventory` is `{ ships, modules, cosmetics, selections }` — the WHOLE inventory in one read (the Shop and the Hangar need all four together). Ownership is **derived**: the starter hull, every `price: 0` module, and each owned hull's target-scoped base skin are computed from content on every read, never seeded rows. `selections` maps each owned ship id to its equipped cosmetic id, defaulting to that hull's base skin. |

Passwords: 8–200 chars, hashed with **argon2id**. `JWT_SECRET` is **required** in
production — a missing secret when `NODE_ENV=production` is a hard startup failure
(a dev fallback logs a boot warning otherwise). Colyseus join **fails closed**:
tokenless/invalid-token joins are accepted only when `DEV_ALLOW_ANON=1` **and**
`NODE_ENV!=='production'`; otherwise a valid access token is required.

## Loadouts — `/api/fittings` (auth required)

A pilot has exactly **one loadout per hull** (owner 2026-08-22): fitting a module
*is* saving it, so there are no named fittings to create, select, rename or
delete. A loadout is `{ id, user_id, ship_id, hardpointMap, created_at }` where
`hardpointMap` is `{ "<hardpointIndex>": "<moduleId>" }` (missing index = empty).

The row `id` is **derived**, never chosen by a client:
`loadout:<userId>:<shipId>` (`loadoutFittingId()` in `shared/src/net/api.ts`).
That is why the write route takes a **ship** id and why a client cannot address
another pilot's row — it cannot mint the user half of the key.

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{ fittings: Loadout[] }`, at most one row per ship. |
| `PUT /:shipId` | `{ hardpointMap }` | 200 `{ fitting }`. Upsert. Validated (below). `404 not-found` for a path that is not a ship (an old client's stale row id lands here). |

Rows are created and repaired by `ensureImplicitLoadouts()` (`db/seed.ts`), which
runs on every auth: a hull with no row takes the account's most recent *named*
fitting for that hull if one survives from before the change, otherwise the
hull's stock `defaultFitting`; every other row for that hull is then dropped.

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
| `POST /buy` | `{ shipId }` | Spends the hull's `price` (absent = 0). 200 `{ shipId, credits }`. **Idempotent** — buying a hull you own succeeds with an unchanged balance. `404 unknown-ship`, `409 insufficient-credits`. |
| `POST /:shipId/upgrade` | `{ track }` | Buys the **next** level of `track` (`hull`/`engine`/`energy`/`heat`). 200 `{ shipId, track, level, credits }`. `409 insufficient-credits`, `400 max-level`. |

Upgrade level = count of purchased config levels; the next price comes from the
ship's `upgrade.<track>` config `levels[currentLevel]`. Max level = `levels.length`.

## Modules — `/api/modules` (auth required)

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{ modules: [{ id, name, family, level, price, requiresLevel, owned }] }`. |
| `POST /buy` | `{ moduleId }` | Spends `price` credits. 200 `{ moduleId, credits }`. `409 insufficient-credits`, `403 level-locked`, `409 already-owned`. |

## Cosmetics — `/api/cosmetics` (auth required)

Paints are content (`cosmetic.*`, `content/cosmetics/*.json`), so there is no
catalog route — every client already holds the pack. Only ownership and the
per-hull selection are server state.

| Method & path | Body | Notes |
|---|---|---|
| `POST /buy` | `{ cosmeticId }` | Spends `price` credits. 200 `{ cosmeticId, credits }`. **Idempotent**. `404 unknown-cosmetic`, `409 insufficient-credits`. |
| `POST /select` | `{ shipId, cosmeticId }` | Equips a paint on its target hull. 200 `{ shipId, cosmeticId }`. `cosmeticId: null` clears the explicit row; the next inventory read derives that hull's base skin. `404 unknown-ship`/`unknown-cosmetic`, `403 not-owned` (the hull **or** the paint), `400 not-applicable` when the cosmetic targets another item. |

The equipped paint also travels into a match: `ArenaRoom` accepts a `cosmeticId`
join option, falls back to the saved selection for the spawned hull, and
re-validates ownership + applicability server-side — anything else flies as the
authored look rather than refusing the join. It replicates as
`PlayerState.cosmeticId` (`""` = standard), protocol version 5.

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

## Admin content packs — `/api/admin/content` (admin required)

Export / import / roll back the **live content pack** with no redeploy
(ROADMAP §11 6.7, criterion S6). Full workflow, curl examples and the honest
account of what happens to in-flight matches: [`docs/CONTENT.md`](../../../docs/CONTENT.md).

Gating is `requireAdmin`: **401** for a missing/invalid token, **403** for a
valid token whose user is not `users.role = 'admin'`. The role is read from the
database per request, so a demotion takes effect immediately rather than at the
next token expiry. Create an admin with
`npx tsx tools/create-admin.ts <email> <password>`.

| Method & path | Notes |
|---|---|
| `GET /export` | The live pack as one bundle: `{ kind, protocolVersion, packId, packVersion, generatedAt, sourceHash, manifest, files }`. `Content-Disposition: attachment`, `Cache-Control: no-store`. |
| `GET /status` | `{ protocolVersion, pack }` — the same `pack` object `/health` exposes (`packId`, `packVersion`, `sourceHash`, `files`, `loadedAt`, `rollbackAvailable`). |
| `POST /import` | Validates the **whole** pack through `ConfigService` (schemas + typed references + relational rules) **before** writing anything, then swaps the content directory atomically and reloads in place. 200 `{ ok, packId, packVersion, sourceHash, files, counts, rollbackAvailable }`. `422 pack-validation-failed` / `pack-swap-failed` with `errors: [{ file, path, message }]` — the editor's error shape. `413 pack-too-large`, `400 invalid-json`. |
| `POST /rollback` | Restores the pack the last import replaced (symmetric — calling it twice returns to the start). 200, or `409 rollback-failed` when there is nothing to restore. |

Two extra limits apply here, both tighter than the game API's: an unauthenticated
caller is rate-limited *before* the auth check (20 burst / 1 per s), and the two
mutating routes carry a second bucket (6 burst / 1 per 10 s). `POST /import` also
has its own body cap — `CONTENT_IMPORT_MAX_BYTES`, default 8 MB — instead of the
global 64 kb, which is why the router is mounted ahead of the global JSON parser.

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
created with a client-supplied `minPlayers` override (which can enable
trivially-winnable solo rooms) is marked ineligible — the `match_results`
row is still written (flagged `rewards_eligible=0`) but no credits/XP are granted,
and one authenticated user may occupy only one slot per room. `finalizeMatch`
persists the result and all profile writes in a single transaction and dedupes
rewards by userId.

## Telemetry — `/api/telemetry` (ROADMAP §11 6.8)

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /client` | **none** | `{ sessionHash, fpsBucket, deviceClass, qualityTier }` | `204 No Content`. Fire-and-forget, called once per finished match (offline or online). `400 invalid-body`; `429 rate-limited` past 240 reports/hour for one session hash. |

Schema: `clientMetricBodySchema` in `shared/src/net/telemetry.ts`. It is
**strict** — an unknown key is a 400, so a future client cannot quietly start
attaching an identifier.

- `sessionHash` — 32–64 lowercase hex characters. Random per page load, held in
  memory only, never persisted client-side and never linked to an account. There
  is deliberately no foreign key from `client_metrics` to `users`.
- `fpsBucket` — `<20` | `20-30` | `30-45` | `45-60` | `60+`, from the match's
  frames ÷ seconds (not a mean of per-frame readings).
- `deviceClass` — `mobile` | `desktop`, from the UA hint.
- `qualityTier` — `low` | `med` | `high`, the tier that was actually active.

Unauthenticated on purpose: the payload gains nothing from an identity, and
requiring a token would drop reports from exactly the sessions worth measuring
(guests bouncing off a slow device). It still shares the per-IP token bucket that
guards the rest of `/api/*`, and the per-session cap blunts the slow trickle the
IP limiter would let through.

Two further tables back this up, written server-side and not exposed over REST:
`match_results` (extended in migration 004 with `room_id`, `player_count`,
`bot_count`) and `server_metrics` (room count, tick avg/p95/max and RSS, sampled
every 10 s while rooms are live — see `SPACE_ARENA_TELEMETRY`). Read all three
with `npm run telemetry:report`.

## Operations — `/metrics`

`GET /metrics` returns the live metrics registry as JSON: per-room tick
histograms, patch/egress byte counters, room and client counts, process memory,
and lifetime room create/dispose totals. Counters are **cumulative**, so a poller
derives windows by diffing consecutive responses.

Mounted only when `env.devTools` is on (development, or production with
`COLYSEUS_MONITOR=1`), alongside `/monitor`, and it belongs behind the same admin
auth that §11 6.4 puts in front of that dashboard. `?gc=1` forces a collection
before sampling — a no-op unless the process was started with `--expose-gc`,
which only the load-test harness does.
