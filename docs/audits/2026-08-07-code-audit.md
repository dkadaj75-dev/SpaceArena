# SpaceArena — Code Audit

**Date:** 2026-08-07
**Scope:** Engineering. Architecture and maintainability; correctness, determinism and netcode; security, server authority and anti-cheat; performance and scalability; testing, CI/CD and release engineering; data, persistence and operational readiness.
**Method:** Eleven parallel dimension audits against the working tree at `9ce2734`, followed by adversarial re-verification of the eight most serious findings. Where re-verification refuted or reduced a claim, this document reports the corrected version and says so explicitly.
**Repo at time of audit:** 133 commits over 11 days (2026-07-27 → 2026-08-06), 55.6k production LOC, 31.7k test LOC, 1,891 tests across 168 files — all green, `typecheck` and `lint` clean, zero TODO/FIXME markers in production source.

---

## 1. Executive summary

SpaceArena is a genuinely well-engineered simulation wrapped in an under-engineered *service*. The deterministic core is the strongest part of the codebase and should be protected: one `ArenaSimulation` serves the client, the authoritative server and the CLI tools; there is no `Math.random` or wall-clock read anywhere under `shared/src/sim`; the client cannot send a position, a damage number or a kill — only throttle, turn, pitch, fire and a hardpoint index — so the classic aimbot and damage-forge cheat classes are architecturally excluded rather than merely validated away. Server tick cost is measured and healthy (20 concurrent 10v10 rooms at 0.762 ms mean against a 33.3 ms budget). The problems are almost all at the edges: the money path, the release pipeline, the client's first thirty seconds, and the operational substrate underneath a database that currently holds the entire economy on one unreplicated container volume with no backup.

Three things need to be understood together. **First, the economy is inverted at the trust boundary** — the only fair-PvP path the shipped client exposes grants zero credits and zero XP, while an unvalidated client-created bot room pays full price. **Second, there is no operational safety net at all**: no backup, no transaction ledger, no build identity, no crash reporting, no post-deploy verification — which is precisely why a cancelled GitHub Pages build served a stale site for the better part of a day and nothing in the pipeline noticed. **Third, the client's first match is hostile**: a measured 2,775 ms fully synchronous main-thread freeze on the flagship map, on a device tier (every iPhone and iPad) that is handed the Ultra quality tier with the hardware probe entirely bypassed.

None of this is architectural rot. The sim is clean, the schemas are real, the repos layer is a proper seam. The gap is roughly six to eight weeks of unglamorous service work on top of a good engine.

### Launch-blocking items

| # | Item | Severity | Effort | Section |
|---|---|---|---|---|
| 1 | Reward eligibility inverted — matchmade PvP pays zero, client-created bot rooms pay full | Blocker | M | [§4.1](#41-the-economy-is-inverted-at-the-trust-boundary) |
| 2 | No backup or restore of any kind — the entire economy is one volume loss from gone | Blocker | M | [§6.1](#61-no-backup-no-restore-no-rpo) |
| 3 | No transaction ledger — no record of any grant, debit or ownership change | Blocker | L | [§6.2](#62-no-transaction-ledger) |
| 4 | Rate limiter keys on `req.ip` with no `trust proxy` — collapses to one global bucket behind any TLS terminator | Blocker | S | [§4.2](#42-the-rate-limiter-does-not-survive-first-contact-with-a-reverse-proxy) |
| 5 | Lunar Crater terrain generation is a measured 2,775 ms synchronous main-thread freeze at every CTF match start | Blocker | M | [§5.1](#51-a-28-second-freeze-at-every-ctf-match-start) |
| 6 | Safari (all iOS) gets the Ultra tier with the device probe bypassed; auto-demote can fire once per match | Blocker | S | [§5.2](#52-every-iphone-and-ipad-is-handed-the-ultra-tier-with-no-hardware-check) |
| 7 | Pages deploy is not gated on CI — measured live 1–6 min before tests finish, on 7 of 7 recent merges | High | S | [§7.2](#72-the-deploy-is-not-gated-on-ci) |
| 8 | Stale-site incident: a cancelled build served an old site unnoticed; nothing can detect a repeat | High | M | [§7.3](#73-the-stale-site-incident-2026-08-06) |
| 9 | No build identity anywhere — you cannot tell what is live, and there is no rollback path | High | S | [§7.4](#74-no-build-identity-no-rollback) |
| 10 | Zero crash/error reporting in client or server; `/metrics` is dev-gated off in production | High | M | [§7.5](#75-no-crash-reporting-anywhere) |
| 11 | The balance-regression bench records the attacker's death as "defender unkillable" — 3 of 5 matrix rows are vacuous | Blocker | M | [§7.1](#71-the-balance-bench-certifies-a-game-that-cannot-be-won) |

Items 1–4 and 11 must be fixed before money is involved. Items 5–6 must be fixed before a public launch on the strength of retention alone. Items 7–10 are the release pipeline, and they are cheap.

---

## 2. What is genuinely well built here

This section exists because the owner needs to know what to *protect* as much as what to fix. Every item below was verified against source, not taken from documentation.

**The deterministic core.** `grep -rn "Math.random|Date.now" shared/src --include=*.ts` returns only doc comments saying not to use them. `shared/src/sim/rng.ts:45` gives every out-of-sim consumer — bot drivers, respawn placement — its own `deriveRng(seed, salt)` stream so it cannot desync `World.rng`. Deterministic iteration is enforced at the data-structure level: `World.shipIds/asteroidIds/projectileIds/decoyIds/flagIds` (`World.ts:162-183`) all sort ascending. `ArenaSimulation.tick` (`:432-453`) documents and enforces a fixed system order, and the frozen countdown carries a real float-error rationale with `COUNTDOWN_EPSILON = 1e-9` rather than a magic guess. This is the asset that makes every other claim in the codebase testable — including every measurement in this audit, which was reproducible in a 40-line script against shipped content.

**One simulation, three consumers.** `new ArenaSimulation(...)` appears exactly three times outside tests: `client/src/game/GameSession.ts:133` (offline), `server/src/rooms/ArenaRoom.ts:216` (authoritative), `tools/bot-ctf-review.ts:90` (headless analysis). `NetGameSession extends GameSession` rather than duplicating the loop. Layering is currently spotless: zero Babylon or DOM references in `shared/`, zero cross-imports between client and server.

**Server authority is real and minimal-surface.** There is no client-supplied position, damage, hit or kill message anywhere in the protocol. Loadouts are re-validated server-side at join — `ArenaRoom.resolveFitting` (`:320-353`) loads the fitting from the DB, confirms `fit.user_id === userId`, and runs the same `validateFitting` the REST API uses, throwing to reject the join rather than spawning an illegal ship. Bots are pushed through the identical `validateOrder` and per-second order budget as humans (`ArenaRoom.ts:543-557`), so a hostile content pack cannot author a bot that issues an order a player could not.

**The stat pipeline is genuinely data-driven.** `shared/src/sim/resolveStats.ts:95-131` folds upgrade tracks and module `passives: StatOp[]` (`{target, op: add|mul, value}`) over a fixed `STAT_PATHS` list with a deterministic add→mul→clamp order. Internal modules (engine/generator/transformer/heatsink/sensors) change the hull purely through authored ops, with no per-family code. Across all of `shared/src/sim/**` there are only 5 module-level numeric constants.

**Cross-reference validation at load.** `shared/src/schemas/index.ts:188-268` `collectReferences()` builds a real reference graph (ship→upgrade/module/effect, module→action, arena→asteroid/notification, gamemode→arena/botprofile/ship, theme→notification) validated at load. `npm run validate:content` runs it in CI over 116 configs; dangling ids fail fast.

**Wire format and bandwidth.** Precision is content-gated: `WIRE_POSITION_LIMIT = 3276.7` is enforced by the arena zod schema for both shell radius and radius+projectile margin, and the largest shipped arena is r=360 — ~9x headroom. Measured egress is 7.28 KB/s patch + 9.54 KB/s total per client at 19.7 patches/s in a 20-ship room, about 76 kbps and ~5.7 MB over a ten-minute match. `encodePitch`/`decodePitch` correctly get a separate *signed* int16 codec from heading, with the wrap boundary round-tripping exactly.

**The load/soak harness.** `tools/loadtest.ts` runs the server in a child process so RSS is honest, diffs cumulative `/metrics` counters into windows, and performs an explicit teardown audit. `server/src/telemetry/soak.ts` does least-squares RSS trend analysis with r² to distinguish drift from a leak, excludes a warm-up window, and issues explicit "cannot tell" verdicts for short runs — backed by 20+ unit tests over synthetic curves. This is real engineering, not a stub.

**Test discipline where it counts.** Zero snapshot tests in the entire repo. `server/src/rooms/ArenaRoom.test.ts` is adversarial: malformed orders rejected without disturbing a legitimate client, rate-limit kick plus burst forgiveness, malformed messages counted against the budget, join with an unowned module rejected, content-edited "hot-rod" bots held to the human order budget. Several tests are tagged with prior-review finding numbers — the review loop feeds back into tests.

**Two CI gates most teams never build.** `validate:content` loads all 116 configs through ConfigService. `tools/bundle-budget.ts` checks for editor leakage *twice* — by chunk name and by scanning minified chunk bytes for the `/__editor/` literal that survives minification.

**Security hygiene above the bar for this scale.** Every query in `db/repos.ts` is prepared with `?` placeholders; the only two template literals are a fixed column whitelist and a two-literal join. Passwords are argon2id. Refresh tokens are opaque `sessionId.secret` with only `sha256(secret)` persisted, rotated and deleted on every use. `env.ts:163-236` rejects a production boot with a missing, short, low-entropy or placeholder `JWT_SECRET`, rejects `CORS_ORIGIN=*`, and collects every problem at once. All 17 `innerHTML` uses in `client/src` are static icon markup; player display names go through `textContent`.

**Credit debits are race-free.** `profilesRepo.tryDebit` puts the funds check in the WHERE clause (`repos.ts:216-221`) and asserts `info.changes === 1`, wrapped with the grant in one transaction. `finalizeMatch` wraps the result insert and every per-user grant in a single transaction and dedupes by userId. The primitive is correct; what is missing is the ledger on top of it (§6.2).

**Honest operational documentation.** `docs/CONTENT.md §7` ("What is live-reloadable — honestly") states plainly that in-flight rooms pin their ConfigService, that open tabs stay stale until reload, and that no server→client content-invalidation push exists. That kind of honesty prevents 3 a.m. incidents.

---

## 3. Correctness, determinism and netcode

The core is disciplined. The periphery is where the defects live.

### 3.1 `jettisonHeatsink` is rejected at the trust boundary — the entire decoy path is dead online
**High · S · verified (holds)**

`orderSchema` in `shared/src/net/protocol.ts:163-185` is a `z.discriminatedUnion("kind", [...])` containing only `"flight"` and `"moduleToggle"`. `ArenaRoom.handleOrder` (`:573-577`) parses every inbound order with it and acks `"malformed"` on failure, so the `case "jettisonHeatsink":` arm at `ArenaRoom.ts:640-644` is unreachable from the wire. The client sends it unconditionally: `FlightControls.ts:565` → `NetGameSession.order` → `room.send(MSG_ORDER, …)`, and `NetGameSession.ts:541-548` forwards every order verbatim with no kind filter. Reproduced directly: `orderMessageSchema.safeParse({ seq: 1, order: { kind: "jettisonHeatsink" } })` returns `success: false`; the equivalent `flight` order returns true. Meanwhile `shared/src/sim/orders.ts:36` declares `| { kind: "jettisonHeatsink" }` as a first-class sim `Order` — the wire schema and the sim type have diverged with nothing asserting they agree.

Affected paid content: `content/modules/heatsink-ablative.json` (price 1500, purgeAmount 180) and `heatsink-cryo.json` (price 2600, purgeAmount 240) — the only two of seven heatsinks with a `jettison` block. The shop advertises the dead feature: `moduleSummary.test.ts:106` asserts the ablative heatsink's `Jettison` value renders as `"25s"`.

**Correction from verification:** the original finding claimed server bots could still trigger this because they bypass zod. That is wrong, and wrong in the direction that makes it worse — `BotDriver` emits only `flight` (`:570`, `:707`) and `moduleToggle` (`:591`); grep for `jettison` under `shared/src/bots/` returns nothing. **Nothing at all triggers jettison in an online room.** The entire replicated decoy chain — `DecoyState`, the decoy sync at `ArenaRoom.ts:814-830`, `decodeDecoys`, and the missile re-seek `ProjectileSystem.retargetToDecoy` — is dead code online, exercised only by unit tests and the offline session.

Severity is High rather than Blocker because the heatsinks' dominant value is their passives (`heat.dissipation +41/+66`), which replicate and apply normally, and jettison works in offline practice. What fails is the advertised active ability on the two most expensive heatsinks, with a user-visible "Order rejected: malformed" toast (`main.ts:486`).

**Fix:** one line — add `z.object({ kind: z.literal("jettisonHeatsink") })` to the union. Then add a test that enumerates `Order["kind"]` and asserts each member parses, so the two definitions cannot drift again.

### 3.2 No in-match disconnect handling on either side
**Medium (downgraded from High) · M · verified (holds, impact corrected)**

`NetClient.onStateChange` (`client/src/net/NetClient.ts:42`) is fired from `room.onLeave` (`:55-58`) and **is never assigned anywhere in production code**. `grep -rn "onStateChange" client/src server/src` returns four hits: the declaration, the two invocation sites, and one unrelated Colyseus patch subscription at `NetGameSession.ts:517`. No code anywhere uses `reconnectionToken` or `client.reconnect`. On the server, `onLeave` (`ArenaRoom.ts:1015-1032`) sets `ps.connected = false` and awaits `allowReconnection(client, 30)`; nothing zeroes the disconnected ship's `FlightState`, which `navigationSystem` keeps integrating because flight orders are level-triggered — including `fire`, restored from `world.flightFireLevels` every tick, so a ghost with the trigger held keeps shooting. On the client, once patches stop, `bracket()` clamps `t` to 1 (`interpolation.ts:18-20`) and the world freezes with no message.

**Corrections from verification** (all three reduce the impact):
- "No way back except a page reload" is false. The HUD gear is wired for every session (`Hud.ts:140-149`, `main.ts:478`) and match-context settings offers Quit to Menu (`main.ts:632-639`). The player is stranded without an *explanation*, not without an *exit*.
- "In CTF, hold the flag hostage" is unreachable. The only CTF gamemode declares a `bots.roster`, and `Lobby.ts:153-158` files every roster-bearing gamemode under offline Practice. There is no online CTF.
- "Flies on for 30 s" is worst-case, not typical. `duel-1v1` sets `respawn.enabled: false` with `eliminationEndsMatch` defaulting true, so the first kill on the ghost ends the match; `boundaryRule: damageAndBounce` at 8 dps keeps it inside the arena.

Net effect: a mid-match drop in the only online mode silently freezes the client and costs the player the duel plus its rewards, while the server's 30-second reconnection window is dead weight nothing can consume. Worth fixing before taking money; not a launch blocker.

### 3.3 Spawn pads are picked from the total ship count
**Medium · S**

`ArenaSimulation.spawnPlayer` (`:334-336`) filters spawn points to the requested team but indexes with the global count: `const used = this.world.shipIds().length; const sp = spawns[used % spawns.length]`. Reproduced against `arena.lunar-crater` (10 pads per team) replaying the exact `ArenaRoom` join sequence — 3 humans via `assignTeam()`'s alternation, then `backfillBots()`'s team-0-then-team-1 loop: 20 ships land on 18 distinct pads, with two co-located pairs. Fully interleaved join order collapses 20 ships onto 10 pads. `processRespawns` (`:507-511`) has the same shape of bug — it picks a pad with `respawnRng()` and never checks occupancy.

Co-located ships are shoved apart by `CollisionSystem`'s push-out, which moves positions without touching velocity, so they scrape apart into the boundary or the colossal rock at match start. Offline practice is currently safe only because the shipped bot roster happens to be block-ordered by team; the room path already reproduces it.

### 3.4 Boost lockout guard was refactored away from the keyboard path
**Medium · S**

`FlightControls.ts:173-175` calls `this.toggleBoost(...)` straight from `onKeyDown`, and `toggleBoost` (`:560-562`) is a bare `session.order({ kind: "moduleToggle", … })` with no `blocked` check. The carrier-blocked state is computed only for the button (`refreshBoostState`, `:555`) and the guard lives only in `BoostButton.onPointerDown` (`:91-92`). The comments added by the refactor assert the opposite of the code — `:213` "Same order path as the Shift shortcut below" and `:559` "The single boost order path: the touch control and Shift both come here." A keyboard player carrying the flag presses Shift, the boost deploys, the power rail sheds a weapon or shield to make room, and `NavigationSystem.resolveBoostMult` returns 1. This is the same defect the 2026-08-04 review filed, now harder to spot because the code reads as fixed.

### 3.5 Rendered ground and collision plane are different surfaces
**Medium · S**

`createTerrainDisc` displaces every vertex (`SceneBuilder.ts:756`, `terrainHeight` at `:781-787` summing two noise layers at amplitudes 1.35 and 0.55) while collision remains a flat plane (`CollisionSystem.ts:164-170`, `bounds.floorY + col.radius`). Measured over the exact shipped geometry (r = 360×1.005, 40 rings × 112 segments): vertices span **−1.725 to +1.766** around `floorY = 0`; at the two flag bases the terrain sits at −0.793 and −0.496. Interceptor collider radius is 1.4. A ship resting on the collision plane is buried under visible regolith over a rise and hovers ~1.7 units above the ground over a depression — including over both capture points.

**Recommendation:** emit a flat disc and move the undulation entirely into the normal/bump and albedo textures the material already carries. That preserves `floorY`'s planar contract at no runtime cost, and it composes with the fix in §5.1.

### 3.6 Smaller correctness items

| Item | Evidence | Sev |
|---|---|---|
| CTF flags never interpolated | `EntityView.ts:622-628` passes `(prev, cur, alpha)` to ships/decoys/projectiles but calls `syncFlags(cur, frameDtMs)`; `:894` writes the raw snapshot position. Offline lag 0.9 units against a 1.4-unit collider; online, `NetGameSession.interpolate` (`:1050-1073`) returns `{ ...b, ships }` so flags, decoys and projectiles step at `PATCH_RATE_MS = 50` — up to 5.25 units per step for a 105 u/s round. | Medium |
| Ship velocity not replicated | `ArenaState.ts:77-79` declares `vx`/`vz` (no `vy`); grep finds **only those two declaration lines** — never written, never read. Client derives velocity by differencing quantized positions, carrying ±2 u/s noise against a 27 u/s nominal. Online explosions throw debris with no inherited motion (`EntityView.ts:544,672` `?? 0`). | Low |
| Quantization docs describe the wrong unit and arena | `quantize.ts:22-32` multiplies by 10 (deci-units) but exports `encodeCenti`/`decodeCenti`, whose docstring says "centi-units"; `ArenaState.ts` repeats it in three field docs. `quantize.ts:8` says "deep-field is a radius-300 bubble" — the file is `radius: 210`, and the largest arena is 360. A future author reading "centi" sizes a headroom calculation 10× wrong. | Low |

---

## 4. Security, server authority and anti-cheat

The authority model is strong (see §2). The failures are in *who decides a match is worth paying for*, and in the deployment surface.

### 4.1 The economy is inverted at the trust boundary
**Blocker · M · verified (holds)**

`ArenaRoom.ts:213` reads:

```
this.rewardsEligible = options.minPlayers === undefined;
```

The matchmaking queue creates its rooms at `server/src/matchmaking/roomReservations.ts:19`:

```
matchMaker.createRoom("arena", { gamemode, minPlayers: 2, matchmaking: true });
```

It passes `minPlayers`. So **every matchmade duel gets `rewardsEligible = false`**, and `progression/service.ts:95` (`if (!eligible) return [];`) grants zero credits and zero XP for the only fair-PvP path the shipped client exposes. Conversely a client calling `joinOrCreate("arena", { gamemode: "gamemode.duel-1v1", botBackfillMs: 0 })` omits `minPlayers` → `rewardsEligible = true`, backfills a `bot.rookie` opponent, and collects the full `duel-1v1` payout. The repo's own `server/src/rooms/RewardEligibilityRepro.test.ts:33-46` asserts this inversion; `ArenaRoom.test.ts:766` only covers the opposite case.

The blocker half is the *matchmade* side, not the farm side. A legitimate player who presses the only Online button never progresses at all — independent of whether anyone ever scripts the exploit.

**Fix:** `rewardsEligible` should be true only when `options.matchmaking === true` (the trusted matchmaker flag that already exists), never inferred from a client-supplied field. Separate room-capacity config from reward policy entirely. Add regression tests asserting a matchmade room pays out and a `joinOrCreate` room does not.

**Related, downgraded to Medium:** `CreateOptions` (`ArenaRoom.ts:68-80`) is populated verbatim from client join options, and only `gamemode` and `arena` get existence validation. `options.botBackfillMs` overrides the authored 20,000 ms wait (`:237`) and `options.botProfile` overrides the gamemode's `defaultProfile` (`:236`). Verification substantially reduced the exploit value: `duel-1v1`'s authored default is already `bot.rookie`, the weakest of the four profiles (decisionIntervalMs 950 vs 250/300/800; aimErrorRad 0.42 vs 0.28/0.32/0.36), so `botProfile` can only make the opponent *harder*; in every mode with an authored roster, `ArenaRoom.ts:483` prefers the roster slot's profile over the override; and `options.seed` only matters when `bots.randomizeLoadouts` is set, which `duel-1v1` does not set. The real amplifier is `botBackfillMs: 0` removing one fixed 20-second term — an accelerant on §4.1, not a standalone High. It remains worth closing: room creation happens before any auth (`onAuth` runs at join, not create) and Colyseus serves `/matchmake/*` from its own HTTP listener, so it never touches the Express rate limiter.

### 4.2 The rate limiter does not survive first contact with a reverse proxy
**Blocker · S · verified (holds)**

`server/src/api/rateLimit.ts:28` keys buckets on `req.ip ?? req.socket.remoteAddress`. A repo-wide grep for `trust proxy`/`trustProxy` returns **zero hits**, and `createHttpApp` (`httpApp.ts:43-59`) never calls `app.set("trust proxy", …)`. The container terminates no TLS, so the HTTPS/WSS the deploy requires means a reverse proxy is mandatory — at which point `req.ip` is the proxy's address for every request.

Two failures at once, with zero attacker effort. **(1) Self-DoS:** all players worldwide share one bucket of 30 burst / 10 req-per-sec, so the API starts returning 429 at trivial concurrency — hangar, shop and matchmaking all fail while WebSocket gameplay survives, making it look like "the menus are broken" rather than an outage. **(2)** The per-attacker limit that is supposed to blunt credential stuffing ceases to exist as a per-attacker limit.

**Fix:** `app.set("trust proxy", …)` driven by a `TRUST_PROXY` env var validated in `env.ts` (never a bare `true` in production), plus a test asserting two different `X-Forwarded-For` values get independent buckets.

### 4.3 Auth endpoint hardening
**Medium (downgraded from High) · S · verification substantially refuted the original claim**

`httpApp.ts:82` mounts auth with the comment "own rate limiter, slightly stricter to blunt credential stuffing" — but the call is `createRateLimiter()` with **no arguments**, i.e. the identical 30/10 defaults as every other route. The comment documents a protection the code does not implement. There is no account lockout, failed-attempt counter, captcha or backoff anywhere (`passwordSchema` is `min(8)`), so 10 req/s/IP is ~864,000 guesses/day against accounts that will hold purchased currency.

**What verification refuted**, and it matters:
- The original claim that `verifyPassword` runs "on every attempt including unknown emails" misread the code. `auth/routes.ts:130` is `if (!user || !user.pass_hash || !(await verifyPassword(...)))` — `||` short-circuits, so an unknown email costs one indexed lookup and zero argon2 work. The attacker must target a registered email.
- The claimed "~30 concurrent argon2 hashes → ~1.9 GB → OOM" is wrong. argon2's native work runs as a libuv AsyncWorker, so the default 4-thread pool caps concurrency at 4 × 64 MiB. Measured peak RSS against this repo's argon2 build: N=1 → 111 MiB, N=10 → 303 MiB, N=30 → 303 MiB, N=100 → 310 MiB. Memory **plateaus**; the absence of `UV_THREADPOOL_SIZE` is what bounds it, not what worsens it.
- "Stalls the event loop / matches tick-starve" is also refuted. Measured max event-loop lag: 12 ms at N=10, 16 ms at N=30, 15 ms at N=100 on 4 vCPU; 35 ms at N=30 pinned to a single core. Against a 33 ms tick budget that is jitter on a 1-vCPU box, not starvation.

**What the original missed, and is the stronger sibling:** `auth/routes.ts:54` runs `hashPassword` on `/register` for any email not already taken — needing no valid account at all — then writes `users` + `profiles` rows and a full free starter kit via `seedNewUser`. Same 10 req/s bucket, unbounded account growth into a single-writer SQLite file. The same is true of `POST /api/auth/guest` with an empty body (`:141-170`): no captcha, no proof of work, no auth.

**Fix:** give `/api/auth` the strict bucket its comment already promises (e.g. `createRateLimiter(10, 0.2)`), add per-email failed-attempt lockout with backoff, and cap guest/account creation per IP per day well below the generic bucket.

### 4.4 Observability is an all-or-nothing security tradeoff
**Medium · S**

`index.ts:48-54` mounts `@colyseus/monitor` at `/monitor` and the metrics registry at `/metrics` behind `env.devTools`, which is `!isProduction || COLYSEUS_MONITOR === true` (`env.ts:266`). Neither has any auth — `metrics.ts` has no middleware and `monitor()` is mounted bare. So the only way to get observability in production is to expose live room state, player session ids and room-disposal controls to anyone who guesses the path. The code admits it: `api/metrics.ts:19-21` says it "belongs behind the admin auth that §11 6.4 puts in front of /monitor", and that ROADMAP item is unchecked. `requireAdmin` already exists (`api/http.ts:52`) and is used correctly by `adminContent.ts:53`. This is a two-line change.

### 4.5 Other security items

| Item | Evidence | Sev |
|---|---|---|
| No security headers at all | grep for `helmet`, `Content-Security-Policy`, `X-Frame-Options` across server, client and vite config returns zero hits; `createHttpApp` sets only CORS. Access and refresh tokens live in localStorage. No XSS sink exists today (all `innerHTML` is static icon markup), so this is defense-in-depth — but `/content/*` is admin-importable and served same-origin. | Medium |
| No server-side logout | `AuthService.logout()` only clears localStorage; there is no `POST /api/auth/logout` route. `sessionsRepo.deleteForUser` exists but is called from exactly one place (guest upgrade). Refresh tokens are valid 7 days. Clicking "Log out" on a shared machine leaves a fully valid token behind. Expired session rows are never pruned. | Medium |
| dev-login gated on raw `process.env.NODE_ENV` | `auth/routes.ts:96` mounts an unauthenticated route that calls `usersRepo.setRole(user.id, "admin")` whenever `process.env.NODE_ENV !== "production"`, bypassing the validated `getEnv().isProduction`. In that same state `jwtSecret` falls back to `"dev-insecure-secret-change-me"` (`env.ts:35`), a constant published in this repo. The Dockerfile does set `NODE_ENV=production`, so the shipped container is safe — but `docker run -e NODE_ENV=staging` opens an unauthenticated admin endpoint *and* makes every JWT forgeable. | Medium |
| nanoid advisory in the production tree | `npm audit --omit=dev`: 3 moderate, all tracing to nanoid <3.3.8 via `@colyseus/core <=0.16.24`. `fixAvailable` is `@colyseus/core@0.17.47`, semver-major. Practical exposure is near nil (requires a non-integer size, which Colyseus does not pass); the cost is procedural — it appears on every dependency report a payment processor asks for. | Low |
| Content-pack import is well defended | Admin-only, separate strict limiter, staged-write + atomic double-rename, path traversal blocked by `isSafeContentPath` with explicit tests for `../`, absolute, backslash and non-json paths. *(Strength, listed for completeness.)* | — |

---

## 5. Performance and scalability

**The server is not the constraint.** `npx tsx tools/loadtest.ts --rooms 20 --duration 90 --gamemode gamemode.practice-ctf-10v10` on a 4-core 2.8 GHz Xeon: 20 rooms × 20 ships, tick avg **0.762 ms**, p50 0.730, p95 1.262, p99 1.467, max 6.659 ms against a 33.3 ms budget, 53,222 ticks, 100% duty cycle. That is ~2.3% of a core per room — roughly 40 rooms/core in theory, a comfortable 25–30 in practice. Teardown audit passed cleanly (rooms 0, heapUsed +2.3 MB of a 24 MB budget) after 20 create/dispose cycles. The client is where launch risk lives.

### 5.1 A 2.8-second freeze at every CTF match start
**Blocker · M**

`SceneBuilder.ts:631` sets `textureSize = lowTier ? 256 : 1024` (verified in source) and `:806` sets `makeCraters(0xc0ffee, size >= 512 ? 52 : 34)`. The pixel loop at `:808-845` runs 1024×1024 = 1,048,576 iterations, each doing four `valueNoise()` calls and an inner loop over 52 craters with `Math.hypot` — 54.5 M crater evaluations — then a second full 1024² pass for the normal map. Extracting that exact code into a standalone Node benchmark on a 2.8 GHz Xeon: size=256 → 142 ms, size=512 → 699 ms, size=1024 → **2,775 ms**.

It is reached from `rebuild → SceneBuilder.ts:539 if (arena.bounds.floorY !== undefined)`. Only `content/arenas/lunar-crater.json` has `floorY`, and it is the `defaultArena` of `gamemode.practice-ctf-10v10`. `main.ts:353 setArena()` calls `buildArena` when a match resolves the arena, so this runs at **every CTF match start, uncached** — the textures are rebuilt fresh each time. The prior review flagged this at 512×512 / 34 craters; the tree now runs 4× more work.

This is a hard freeze: no input, no animation, no spinner motion. It lands between "I pressed Play" and "I am in a match", on the target device class, on the flagship map. Mid-range phones will be materially worse.

**Fix:** the textures are deterministic from a fixed seed — pre-generate the albedo/normal pair once and ship them as content assets under `content/arenas/`. If runtime generation must stay, move it to a Worker with an OffscreenCanvas and cache by `(seed, size)`. Add a regression assertion that `buildArena('arena.lunar-crater')` completes under a budget.

### 5.2 Every iPhone and iPad is handed the Ultra tier with no hardware check
**Blocker · S**

`client/src/core/qualityTier.ts:146-148`:

```
if (preferUltra && tierConfig(tiers, "ultra")) return { tier: "ultra", fromOverride: false };
```

This returns **before** `selectInitialTier`, so `probePasses()` — and therefore `ultra.json`'s `minCores: 8` / `minMemoryGb: 8` floors — never runs. `QualityManager` passes `preferUltra = isSafari(options.navigator)`, and `platform.ts:11-15` matches any UA containing `Safari/` without a Chromium/Firefox token, i.e. every iPhone and iPad. `ultra.json` then applies `maxDevicePixelRatio: 3`, `hardwareScalingMultiplier: 1`, `glow.blurKernelSize: 48`, `particles.budgetMultiplier: 1.2` / `maxEmitterCapacity: 120`, `starfieldPoints: 850`, `dust.count: 560`. Separately, `userSettings.ts:154` independently defaults Safari to `"webgpu"`.

The only backstop is `sampleAutoTier` (`:196-235`), which sets `state.adjusted = true` after one decision and returns `NO_CHANGE` forever after; `stepTier(..., -1)` moves exactly one rung, so an A10-class iPad reaches at most `high` (still DPR 2, blur kernel 32, 340 dust) in its first match. Thermal throttling arrives long after the sampler spent its single adjustment at t≈8 s. And the one demote it can make triggers the §5.1 rebuild freeze, mid-match.

**Fix:** make `preferUltra` a tie-breaker *inside* the probe, not a bypass — resolve `selectInitialTier(tiers, probe)` first and only upgrade to ultra when the probe already cleared `high` (Safari's missing `deviceMemory` is already correctly handled as "unknown" at `probePasses:99-105`, so cores alone would gate it). Allow the sampler to demote repeatedly with a cap on total demotions, re-arm on a sustained-FPS trigger, and never let a demote trigger a full arena rebuild.

### 5.3 The LOD system built during the mobile-perf sprint is switched off by content
**High · M**

All four of `content/quality/{low,med,high,ultra}.json` set `"lodMediumDistance": 0` and `"lodLowDistance": 0`. `AssetRegistry.ts:810-811` reads `const addLevel = (distance, subs, suffix) => { if (distance <= 0) return; … }`, so `addLODLevel` is **never called** for either detail level in any tier. The cull level is also inert on three tiers (high = 0, med = 3000, ultra = 6000, against a max in-arena distance of 720). Ship LOD does not exist at all: `addLODLevel` appears only in the asteroid path, while `content/ships/interceptor.json` names `human_light_lod0.glb` and `human_light_lod1/2/3.glb` sit unused in the same directory.

Parsed triangle counts from the GLB accessors: `human_light_lod0` = 44,271 tris (lod1 22,029 / lod2 10,423 / lod3 3,641), `human_medium_lod0` = 19,844, `LShip01` = 9,996. Lunar Crater's 39 placements resolve to 195,423 triangles of rock, permanently drawn. A 10v10 averages ~494 k triangles of hulls (885 k if everyone flies the Interceptor). `SceneBuilder.ts:652-656` documents that the GlowLayer "roughly doubles the frame's draw calls, because every emissive submesh is re-rendered into the blur target." Also dead: `ultra.asteroids.thinInstances: true` has no consumer anywhere — grep returns only the two type-default declarations.

So: ~700 k–1.1 M triangles per frame, doubled by glow, at up to 3 MP on a phone, against a stated bar of ≥30 FPS on a mid-range phone. The `QualityManager.ts:251` built-in fallback already carries sensible 150/340/900 values — the shipped JSON simply does not. **The optimisation work is already paid for; it is switched off.**

### 5.4 The production deploy serves 6.59 MB of JS uncompressed
**High · S**

`npm run build`: `babylon-core-CnXDp0hj.js 6,102.80 kB │ gzip: 1,331.17 kB`. `npm run bundle:budget` reports INITIAL (3 chunks) **6.59 MB raw / 1.48 MB gzip** and passes at 29.7% of budget. But `server/package.json` has no `compression` dependency, `httpApp.ts:59-93` registers no compression middleware, and `staticSite.ts:88-98` serves the client through bare `express.static` with no pre-compressed variant lookup. The Dockerfile contains no nginx/Caddy front. **The number CI validates is not the number users experience** — a 4.5× penalty, roughly 10 extra seconds on 4G before anything renders. On top of that, ~8.8 MB of assets follow: all three ship GLBs preloaded (3.84 MB) plus Lunar Crater's four asteroid GLBs (4.99 MB, of which ~3.7 MB is embedded 512² PNG rather than KTX2/Basis).

**Fix:** add `compression` to the Express app, or emit `.br`/`.gz` siblings at build time and serve them via a static-precompressed handler. One-line change, reclaims 5.1 MB per cold load. Make `bundle:budget` gate the bytes `staticSite.ts` actually serves.

### 5.5 Allocation churn on the hot paths (all unfixed from the 2026-08-04 review)

| Item | Evidence | Sev |
|---|---|---|
| Three full snapshots per server tick, plus flag-trail cloning of data that is never replicated | `ArenaRoom.ts:558` `driveBots()` calls `sim.snapshot()`; `:713 writeState()` calls it again at `:776`; `:714` calls it a third time. `ArenaSimulation.ts:777-790` builds `flags` with `trail: f.trail.map(p => ({x,y,z}))`, and `CtfSystem` bounds the trail by arc length (`trailLength: 100`, `MIN_TRAIL_STEP = 0.5`) → up to 200 points. 2 flags × 200 × 3 snapshots × 30 Hz = **36,000 object allocations/sec/room** — and `FlagState` has no trail field, so none of it is sent. `writeState` also builds fresh `Set`s and spread arrays every tick. | Medium |
| Client rebuilds flag-trail geometry every frame | `EntityView.ts:917-923` runs `resampleTrail` then `MeshBuilder.CreateLines(..., { instance })` unconditionally per flag per render frame with no dirty check. `flagTrail.ts:53-56` allocates a fresh `cumulative` array per resample. `NetGameSession.ts:995` returns `trail.map(p => ({...p}))` — a full clone of up to 200 points per flag per 20 Hz patch. `EntityView.ts:928-932` allocates a closure per view per frame. | Medium |
| 80–100 always-updating particle systems in a 10v10 | Interceptor and Support declare 4 emitter sockets each, Brawler 5. `ShipSocketRig.ts:201-259` creates one `ParticleSystem` per socket per ship and calls `start()` unconditionally — no frustum or distance gating. With ultra's `maxEmitterCapacity: 120` × `budgetMultiplier: 1.2`, `fx.engine-trail` yields 144 slots → up to ~14,400 additive-blended CPU particles plus 560 dust and 850 starfield points. These budgets were sized against a 2v2. | Medium |
| Every CTF room overflows the Colyseus encode buffer on first full state | Running the loadtest against the CTF gamemode prints, once per room: `@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE`. The library warns, `Buffer.alloc`s and **re-runs the entire encode**; it never updates the static `Encoder.BUFFER_SIZE`, so every new room repeats it. Nothing in `server/src` sets it. | Medium |
| Load harness never measures the shipped shape | `tools/loadtest.ts:20` documents its unit as a `duel-1v1` room and `:83` generates its own `gamemode.loadtest`; the `npm run loadtest` default has no `--gamemode`, so the CI-shaped gate exercises 2-ship rooms. Even with the CTF gamemode passed, `RoomDriver.createRoom` (`:365-372`) joins exactly **one** client per room and lets bots supply the other 19 — so the 20-socket fanout, broadcast amplification and 20× egress of a real match are never exercised. No client FPS assertions exist either. Server also runs single-process: `grep -rn "cluster\|numCPUs\|fork(" server/src` returns nothing, so one container = one core. | Medium |

---

## 6. Data, persistence and operational readiness

The SQLite layer itself is well-built and is not the bottleneck. The migration runner is ordered by filename, tracked in a `migrations` table, applied per-file inside its own transaction, and idempotent at every boot (`db/index.ts:44-69`). A `finalizeMatch`-shaped transaction (1 insert + 20 profile read/updates) measures **0.10 ms avg / 0.84 ms worst** in WAL with `synchronous=FULL`. The reason to eventually move off SQLite is the single-process topology, not the engine.

What is missing is everything *around* the database.

### 6.1 No backup, no restore, no RPO
**Blocker · M**

`grep -rn "backup|VACUUM|checkpoint" server/ docs/ tools/ .github/ Dockerfile` returns zero operational hits. There is no `fly.toml`, no compose file, no Terraform, no Procfile anywhere in the repo. The only durability mechanism in existence is `Dockerfile:125 VOLUME ["/data"]` pointing at `SPACE_ARENA_DB=/data/space-arena.db`. No Litestream, no `db.backup()` call, no cron, no restore procedure, no documented RPO/RTO. ROADMAP §11 6.4 — the item that carries "SQLite persistent volume + nightly backup, health checks, @colyseus/monitor behind admin auth" — is unchecked and entirely unstarted.

A single volume loss, a mis-issued `docker volume rm`, or host failure destroys every account, every credit balance and every purchase with no path to recovery. Post-monetization that is a mass refund event, not a data incident. And because there is no backup, there is nothing to *test* a restore against — you would discover it was broken on the day you needed it.

**Fix:** Litestream (or a `better-sqlite3` `.backup()` job) streaming to object storage continuously, plus a nightly full snapshot with 30-day retention, plus a `tools/restore-check.ts` that pulls the latest backup into a scratch container and asserts row counts. Check off ROADMAP 6.4 only after a restore has succeeded end to end.

### 6.2 No transaction ledger
**Blocker · L**

`001-init.sql` defines users, profiles, ship_upgrades, owned_modules, fittings, user_configs, match_results, sessions — and nothing else. `profiles.credits` is a mutable scalar overwritten in place by `setProgress` (`repos.ts:223-227`) and `tryDebit` (`:216-221`). `owned_modules` stores `(user_id, module_id, qty)` with no `acquired_at`, no source, no price paid; `grant` is a blind upsert accumulating qty. `grep -rin "ledger|audit" server/src` returns only unrelated soak-test teardown code. ROADMAP.md:623 lists "transaction table" as a *future* extension.

Consequences: you cannot reconcile a chargeback against a grant, prove an item was delivered, detect after the fact that an exploit minted credits, or reconstruct a player's inventory after restoring an older backup. Every support ticket becomes "we have no record." This is also the substrate every later feature — refunds, gifting, seasonal resets, anti-fraud — has to sit on, so it gets more expensive the longer it is deferred.

**Fix:** an append-only `transactions` table `(id, user_id, kind, sku_id, credits_delta, balance_after, source, idempotency_key UNIQUE, external_ref, created_at)` indexed on `(user_id, created_at)`. Make `tryDebit`/`grant`/`setProgress` private to a `ledger.ts` module that writes the row in the same transaction as the balance mutation, so a balance change without a ledger row is **structurally impossible**. Add a reconciliation test asserting `sum(credits_delta) == profiles.credits` for every user.

### 6.3 No idempotency on the upgrade purchase
**Medium · M**

`api/ships.ts:51-93` — `POST /api/ships/:shipId/upgrade { track }` accepts no idempotency key. It reads `current = trackLevel(...)`, picks `upgrade.levels[current]`, debits `nextConfig.price` and writes `current + 1`. A duplicate delivery therefore charges again **at the next price tier** (upgrade configs price levels 2–5 at 200/500/900/1400 credits). The only protection is the client's `this.busy` flag. By contrast `POST /api/modules/buy` is naturally idempotent — it returns 409 `already-owned` before debiting — so the asymmetry shows idempotency was never a design requirement. On mobile, a retried request silently spends up to 1400 credits, and with no ledger neither the player nor support can prove it.

**Fix:** require an `Idempotency-Key` header on every state-changing purchase endpoint, persisted with a UNIQUE constraint in the `transactions` table, replaying the stored response on a repeat. Additionally accept the `expectedLevel` the client believes it is buying and 409 on mismatch.

### 6.4 Single-process topology with no horizontal path
**High · XL**

`index.ts:42-44` constructs `new Server({ transport: new WebSocketTransport({ server: httpServer }) })` with **no `presence` and no `driver`** — Colyseus therefore uses LocalPresence + LocalDriver, per-process only. The matchmaking queue is documented as "Process-local" (`MatchmakingQueue.ts:69-76`) and constructed once in-process. The database is a process-local file opened by `better-sqlite3`. `allowReconnection` exists but is in-process, so it does not survive a restart.

Capacity is hard-capped at one machine; every content deploy, crash or host migration ends every in-flight match simultaneously; zero-downtime deploys are impossible. Adding a second process would *fragment the queue* — two players searching simultaneously could never meet.

**Fix (staged):** short term, decide the ceiling explicitly and write it down — document the max concurrent rooms actually measured, add a drain mode that stops accepting new rooms and waits before SIGTERM, and schedule deploys off-peak. Medium term, move to Redis presence + driver and managed Postgres, keeping the repos layer as the seam (it is already the only thing touching SQL), so the swap is one module rather than a rewrite.

### 6.5 Content-pack imports have no referential guard against player data
**High · M**

`grep -c getDb server/src/content/packStore.ts` = 0 — the import path is entirely DB-unaware. If an imported pack drops or renames a module id, `owned_modules` rows referencing it are orphaned (the table has no FK to content, by design), and every stored fitting containing it fails at match join with `unknown-module` (`fittingValidation.ts:32-33`).

Worse, `fittings.hardpoint_map` keys are **positional indices** (`db/seed.ts:54-55`, `hardpointMap[String(i)]`) into `hardpointsOf(ship)`, which is plain array order. `content/ships/brawler.json` interleaves hardpoints and internals (hp-nose-l, hp-nose-r, hp-spine, hp-core, in-engine … in-auxiliary, hp-chin, hp-utility), so **inserting one socket mid-list silently re-points every stored fitting at different sockets.**

This directly undermines the headline value proposition — "Content packs deploy as data — no rebuild" and "Seasonal balance patches → export pack → import to prod. No deploy." A seasonal pack that reorders one ship's sockets corrupts loadouts for the players who bought those modules, and pack rollback restores content, not player state.

**Fix:** two-phase import — before swapping, query `SELECT DISTINCT module_id FROM owned_modules` plus the ids inside `fittings.hardpoint_map`, and refuse (422, with the list) any import that removes or renames an id players hold unless an explicit `allowBreakingIds` flag is supplied. Separately, migrate `hardpoint_map` keys from indices to stable socket ids (`"hp-nose-l": "module.laser-mk1"`), which alone removes the entire reordering class of bug.

### 6.6 Account durability and data lifecycle

| Item | Evidence | Sev |
|---|---|---|
| Guest accounts hang off one localStorage string | `AuthService.ts:8` `const LS_GUEST = "guestToken"` is the only durable handle. An unrecognized token is a hard 401 that deliberately never re-mints (`auth/routes.ts:156-159`). No password reset, no email verification, no recovery code — grep for `forgot|password.reset|emailVerif` returns zero across server, client and shared. Clearing site data or Safari's storage eviction permanently destroys the account and everything in it. | High |
| Emails are case-sensitive with no normalization | `001-init.sql:8` `email TEXT UNIQUE` uses SQLite's default BINARY collation; `emailSchema` applies no `.toLowerCase()`. Verified against better-sqlite3: inserting `Alice@Example.com` then `alice@example.com` both succeed as separate rows, and a lookup for one does not find the other. Registering with one casing and logging in with another produces "email or password is incorrect" with **no reset path**, and the player can then register again on the same mailbox — two accounts, split purchases, unresolvable support case. | High |
| No retention, session pruning, deletion or export | `sessions` rows are deleted only by rotation; there is no expiry sweep and no index on `expires_at` to support one. `server_metrics` writes ~8,640 rows/day; `client_metrics` and `match_results` grow unbounded. No `DELETE FROM` sweep for any of them, no VACUUM, and no account-deletion or data-export route (`grep -rn "deleteUser\|DELETE FROM users\|gdpr" server/src` returns nothing). `ON DELETE CASCADE` is already in place on every user-scoped table, so the plumbing for erasure is cheap. | Medium |
| `match_results.participants` is an opaque JSON blob | `001-init.sql:59-67` stores `participants TEXT`, written as `JSON.stringify`. The complete index set across all four migrations contains nothing linking a user to a match. "Show me every match this player played" — the first query of every refund investigation, cheat report and ban appeal — requires a full scan plus a JSON parse of every row, and gets slower every day the game is live. | Medium |
| Display names unindexed and non-unique | `profiles.display_name TEXT NOT NULL` with no UNIQUE and no index. `displayNameExists` is an unindexed scan, and `generateGuestPilotName` calls it once plus up to 12 more times in a collision loop on **every guest signup** — so signup latency degrades exactly as you succeed. The name pool is 12 × 12 = 144 bases; the final fallback appends a timestamp and is not collision-checked at all. Two concurrent signups can race to the same name. | Medium |

---

## 7. Testing, CI/CD and release engineering

The unit-test layer is strong (see §2). The release side is where this falls apart, and the two are connected: the pipeline is designed so nobody has to remember anything, and then the things that actually protect the product depend on someone remembering.

### 7.1 The balance bench certifies a game that cannot be won
**Blocker · M**

`shared/src/sim/balanceRegression.test.ts:558-576` — `timeToKill()` loops `for (tick…) { sim.tick(DT); if (!sim.hasShip(defender)) return tick/TPS } return Infinity`. **It never checks whether the attacker is still alive.** Its docstring's claim of "a stationary `defender` whose modules stay offline" is stale — weapons have spawned ONLINE since 2026-07-31, so the defender shoots back.

Re-running the identical bench instrumented to report who dies: `interceptor→interceptor` **attacker** dies at t=20.0 s (defender still at 20.3% hull); `interceptor→brawler` **attacker** dies at t=20.0 s (defender at 66.6%); `brawler→brawler` **attacker** dies at t=53.4 s (defender at 5.7%). All three are pinned in the shipped MATRIX as `Infinity` (verified in source at `:564-567`). Knock-on effects:

- The test "an active shield measurably extends survival" (`:614-640`) asserts `expect(shieldedTtk).toBe(Infinity)` — but the identical *unshielded* pair is already `Infinity` in the matrix, so the assertion passes with or without a shield and proves nothing.
- "keeps the class fantasy…" (`:605-612`) asserts `lightKillsHeavy === Infinity` and `brawler-vs-brawler === Infinity`; both are attacker-death artifacts.
- `TTK_HARD_CEILING_S = 300` sits under a doc comment still stating "120 s is the narrowest whole-minute ceiling."
- Separately, `runEngagement` (`:207-208`) restores both hulls **every tick** ("Immortal sparring partners: the bench measures upkeep, not lethality"), so critical-heat hull burn is invisible to the entire scripted-engagement suite. The test at `:395` titled "a 60 s all-on engagement stays survivable: pool heat never goes critical" is implemented as `expect(t.peakPoolHeat).toBeLessThan(6.5)` — accepting a pool at 650% of the critical threshold and reporting it as never critical.

The suite is 20/20 green. It is the only guard between a tuning request and shipped content, and it certified five successive heat multiplications (`laser-mk1 fire.heatPerShot` went 6 → 18 → 30 → 60 → **120** across five commits, verified in `content/modules/laser-mk1.json`, while `interceptor.core.heat.capacity` stayed at 100 throughout). The result is measurable: a stock Interceptor holding fire at a disarmed target kills *itself* at 20.0 s.

**Fix:** make `timeToKill()` return a discriminated result — `{killedAt}` | `{attackerDied, at}` | `{neither, defenderHullPct}` — and fail on `attackerDied` instead of collapsing it to `Infinity`. Stop restoring hull in `runEngagement`; track it as an output and assert it never falls without an attributable enemy source. Re-record the matrix and forbid `Infinity` anchors (`expect(recorded).toBeFinite()`). Fix the `TTK_HARD_CEILING_S` comment/value mismatch. *(The underlying content balance is a separate conversation; this finding is about the instrument being blind, which is the engineering defect.)*

**Related, Medium:** the anchors are exact-equality pins on emergent counts. `balanceRegression.test.ts` was modified in 13 of 133 commits; the interceptor overheat pin has been re-recorded 3→2→0→12→13→14→18→36 across seven commits. An exact pin on an emergent count has near-zero signal — every intentional change forces a paste-the-measured-value edit, and that same edit is how an unintentional change gets laundered into the baseline. Which is exactly how the TTK matrix drifted to all-`Infinity`. The file already contains the assertions that *do* hold across all that churn (`sustained.energyFloor <= disciplined.energyFloor`, `brawler.overheats > interceptor.overheats`, ±0.06 band forms). Keep those; delete the exact pins.

### 7.2 The deploy is not gated on CI
**High, launch-blocking · S**

`.github/workflows/deploy-pages.yml:22-24` triggers on `push: branches: [main]` with **no `needs:`, no `workflow_run:` gate, and no test/typecheck/lint/validate-content/bundle-budget step of its own** — it runs `npm run build`, `cp -r content client/dist/content`, and deploys. Measured across every recent merge via the GitHub Actions API, the deploy finished before CI on **7 of 7**:

| Commit | Deploy done | CI done | Δ |
|---|---|---|---|
| 9ce27348 | 01:44:03Z | 01:47:06Z | −3m03s |
| 528de94d | 02:24:54Z | 02:28:35Z | −3m41s |
| aba23e35 | — | — | −3m13s |
| 8ac95e6a | — | — | −2m44s |
| 46b90051 | — | — | −1m01s |
| 160f6a05 | — | — | −6m10s |
| 0dd76c0d | — | — | −5m01s |

There is a 1–6 minute window on every merge in which a build that fails typecheck, tests, the content gate or the bundle budget is already live — and if CI then goes red, nothing rolls the site back. Content is the worst case: `cp -r content client/dist/content` ships all 116 JSON configs to the static host with `validate:content` never having run in that workflow.

### 7.3 The stale-site incident (2026-08-06)
**High, launch-blocking · M**

GitHub Actions run 31128092207 (`pages build and deployment`, head_sha `d93ad1d5`, triggered 2026-08-06T21:07:16Z — two seconds after PR #42 merged at 21:07:14Z): job `build` **cancelled** (21:07:18→21:22:21), job `report-build-status` **cancelled** (→21:37:31), job `deploy` **skipped**; run conclusion `failure`.

No push-triggered `Deploy to GitHub Pages` run exists for `d93ad1d5` at all. Run #50 is `528de94d` (push, completed 2026-08-06T02:24:54Z); run #51 is `d93ad1d5` via **workflow_dispatch** — hand-fired — at 2026-08-07T01:26:13Z→01:27:11Z; run #52 is `9ce27348` (push).

**Measured:** the live site served `528de94d`'s build continuously from 2026-08-06T02:24:54Z to 2026-08-07T01:27:11Z — **23 h 02 m** on one artifact, of which **4 h 19 m** was actively stale relative to merged code (from d93ad1d's 21:07 merge until the hand-fired dispatch landed). The owner spent that window testing fixes against a build that did not contain them.

Nothing about this is self-correcting. `deploy-pages.yml` has no post-deploy verification step, no `if: failure()` notification, and does not surface `steps.deployment.outputs.page_url` to any check. The only signal was a red X on a workflow named `pages build and deployment` that the owner does not own and did not write. Post-launch this is worse: a bad-but-deployed build and a good-but-not-deployed build are indistinguishable from the browser.

**Fix:** add a `verify` job with `needs: deploy` that fetches `${{ needs.deploy.outputs.page_url }}version.json` and fails unless it reports the just-deployed SHA (requires §7.4). Add `if: failure()` notification on both jobs — anything that reaches a phone.

### 7.4 No build identity, no rollback
**High, launch-blocking · S**

`grep -rn "BUILD_ID|__BUILD|commitSha|GITHUB_SHA|buildVersion|APP_VERSION" client/ server/ shared/ tools/` returns nothing. All four packages are `"version": "0.0.0"`. `git tag | wc -l` = 0. `client/index.html` carries no version marker; the built `dist/index.html` references only content-hashed chunk names. The only version-shaped thing is `PROTOCOL_VERSION = 3`, a hand-bumped wire constant that does not change between builds. `workflow_dispatch` declares no `inputs`, so a manual dispatch always builds the selected ref's tip — and with zero tags there is no preserved good build to dispatch from.

A player bug report cannot be correlated to a build. "Is my fix live?" is unanswerable without diffing chunk hashes by hand — which is exactly the failure mode of §7.3. Rollback is `git revert` on main plus a full rebuild cycle, with no way to pin or re-serve a known-good artifact.

**Fix:** inject `GITHUB_SHA` and run number via a Vite `define` (`__BUILD_SHA__`, `__BUILT_AT__`), emit `version.json` next to index.html, log the SHA on boot, show it in a settings/about corner, and add `/version` on the server. Tag every deployed main commit (`v0.1.<run_number>`) so `workflow_dispatch` against a tag is a real one-click rollback. Write the four-line rollback runbook into README next to the content-pack one.

### 7.5 No crash reporting anywhere
**High, launch-blocking · M**

`grep -rn "uncaughtException|unhandledRejection|window.onerror|addEventListener(\"error\"|unhandledrejection|Sentry|captureException" client/src server/src shared/src` returns **zero hits**. Client telemetry sends exactly one payload per match — an FPS bucket, a device class, a quality tier. `server/src/index.ts:92-93` registers only SIGINT/SIGTERM; the only error path is `main().catch` at `:95` for boot failures. `/metrics` is mounted only when `env.devTools`, so a default production container exposes `/health` and nothing else.

When a published player's session white-screens on a device you do not own, you learn nothing — not the exception, not the browser, not the frequency. WebGL/Babylon init failures, asset-load failures and content-pack decode failures are exactly the class of bug that only shows up in the wild. On the server, an unhandled rejection inside a room tick kills the Node 22 process by default with no record.

The hook is one line away: `e2e/smoke.spec.ts:76-80` already attaches `page.on("pageerror")` and `page.on("console")` and asserts the journey produces no errors — that instrumentation exists only in the test.

**Fix:** a `window.addEventListener('error'|'unhandledrejection')` handler POSTing `{buildSha, message, stack, userAgentClass, sessionHash}` to a rate-limited `/api/telemetry/error` (the existing `/api/telemetry/client` route has per-session caps and tests to copy). `process.on('uncaughtException'|'unhandledRejection')` on the server logging structured JSON and exiting non-zero so the container restarts. Expose `/metrics` in production behind the `requireAdmin` that already exists.

### 7.6 Other release-engineering gaps

| Item | Evidence | Sev |
|---|---|---|
| E2E never loads the artifact that ships | `playwright.config.ts:118` runs the Vite **dev** server, and the test depends on `window.__debug`, installed only inside `if (import.meta.env.DEV)`. The production bundle, the service worker, the PWA manifest and the `SPACE_ARENA_BASE` subpath rewrite — precisely what the Pages deploy produces — are never loaded by any test. There is exactly one real e2e test. No online/matchmaking coverage (`grep -n "matchmak\|online\|Ranked" e2e/smoke.spec.ts` → no matches); registration/login never exercised; the module picker deliberately clicks only free modules, so `POST /api/modules/buy` and the upgrade endpoint are never covered end to end. Only `devices["Desktop Chrome"]` is configured. | Medium |
| No coverage measurement | No `@vitest/coverage-*` in any package.json, no `coverage` key in any of the three vitest configs, no coverage flag in CI. 1,891 is a count, not a coverage number; nothing reports which of the 443 TS files are exercised. | Medium |
| No dependency or supply-chain gate | `.github` contains exactly three files — no `dependabot.yml`, no `npm audit` step, no CodeQL, no `schedule:` trigger. `npm audit` today: 9 moderate, 4 high, 2 critical. Honest scope: all six high/critical resolve to dev tooling only (`npm ls --omit=dev` returns empty for each). The risk is that nothing would tell you when that stops being true — and the production runtime does carry native deps with allow-listed install scripts (argon2, better-sqlite3, msgpackr-extract, esbuild). | Low |
| Load/soak testing is manual while deploys are automatic | `tools/loadtest.ts` and `soak.ts` implement real leak/degradation analysis, and README:37-41 says "Neither script is in CI, so run one locally before a deploy." But `deploy-pages.yml` deploys on every push with no human step, so "before a deploy" has no enforcement point. Neither workflow has a `schedule:` trigger. | Low |
| Smoke assertions relaxed rather than made deterministic | Commit `d699601` ("Smoke accepts any point of the match-end flow") removed `await expect(results).toHaveClass(/hud-results--outcome/)`; `5d9892f` removed three more lines. `e2e/smoke.spec.ts` has been edited in 14 commits and is now 488 lines, ~150 of which are a hand-rolled bot pilot inside `page.evaluate` blocks that duplicates and drifts from the real bot code. `retries: CI ? 1 : 0` lets a genuinely flaky path stay green. | Low |

---

## 8. Architecture and maintainability

The core thesis holds where it matters most (§2). Where it frays is at the edges added during the last 133 commits.

### 8.1 The `shared/` layer boundary has zero enforcement
**High · S · verified (holds; scope is wider than originally reported)**

`tsconfig.base.json:4` sets `"lib": ["ES2022", "DOM"]`, and `shared/tsconfig.json` inherits it without override. npm workspace hoisting puts `@babylonjs/core` in the root `node_modules` (`shared/node_modules` is empty, so shared resolves Babylon through the hoisted root despite declaring only `zod`). Both holes were verified empirically: a probe file in `shared/src` containing `import { Vector3 } from "@babylonjs/core"` **and** `document.createElement("div").tagName + localStorage.length + window.innerWidth` passed `npm run typecheck -w shared` with exit 0 and `npx eslint` silently. `eslint.config.js` (29 lines) adds exactly one rule — `no-unused-vars` — and no `no-restricted-imports` or `no-restricted-globals`.

On this repo's Node 22.22.2 all three globals throw `ReferenceError`, and `shared/` is the authoritative server simulation instantiated at `ArenaRoom.ts:216`. So a single slipped import is a crash of the Colyseus room process in production that passes typecheck, lint and all six CI jobs.

**Verification widened the scope in two ways the original finding missed:**
1. `server/tsconfig.json` also fails to override `lib` — a probe using `document` and `localStorage` in `server/src` also passes `npm run typecheck -w server`. **Both Node-side workspaces type-check browser globals.** Only `client/tsconfig.json` sets `lib` explicitly.
2. The Docker path makes it *worse*. The runtime stage runs `npm ci --omit=dev --workspace @space-arena/server --workspace @space-arena/shared`, so Babylon (a client dep) is absent from the production image, while the builder stage runs a full `npm ci` and its typecheck gate — which provably passes the Babylon import. Result: **image builds green, container dies at boot with `ERR_MODULE_NOT_FOUND`.** `.github/workflows/ci.yml` has no docker job at all, so this dev/prod resolution divergence is invisible to every CI check.

There is currently **zero actual violation** in `shared/src` — grepping for `@babylonjs`, `localStorage`, `window.`, `document.` returns only prose in comments and unrelated identifiers like "averaging window." This is a preventive gap, not a live defect. It stays at High because the gap is total, the dev/prod divergence is uncaught by design, and this invariant is the one every other layering claim rests on.

**Fix:** add `"lib": ["ES2022"]` to both `shared/tsconfig.json` and `server/tsconfig.json`, and an eslint override for `shared/src/**` with `no-restricted-imports` banning `@babylonjs/*`, `colyseus*`, `better-sqlite3`, `express`, plus `no-restricted-globals` for `document`/`window`/`localStorage`/`navigator`. The tree passes both today. Partial existing mitigation: `shared/vitest.config.ts` sets `environment: "node"`, so a DOM access on a *covered* path would throw — but that is coverage-dependent (44 test files vs 77 source files), not a gate.

### 8.2 Authorable-but-inert surfaces
**Medium · S each**

Three schema surfaces validate, resolve in the reference graph, and then do nothing:

| Surface | Evidence |
|---|---|
| The event system | `shared/src/schemas/event.ts` defines six triggers and is registered as a first-class config type at `index.ts:58`, with reference collection at `:235-241` and a reverse edge from `notification.triggerEvent`. `grep -rln "eventSchema\|EventConfig" client/src server/src shared/src tools` returns **only** the schema file and the registry — no runtime consumer exists. `content/events/` contains only a `.gitkeep`. ROADMAP §4.3 lists an "Event Editor"; `client/src/editor/EventEditor.ts` does not exist. |
| 6 of 8 action kinds | `shared/src/schemas/action.ts:5-14` enumerates eight kinds. Only two are consumed: `show_notification` (`Notifications.ts:46-56`, `if (action.kind !== "show_notification") return;`) and `play_sound`. All nine shipped configs are one of those two. `ActionEditor.ts:22` renders `kind` as a dropdown over the **full** enum and `saveConfig` writes the file successfully — a designer can author `apply_buff`, wire it to a module's `onFire`, pass content validation, and observe nothing happen with no error anywhere. Silent success is the worst failure mode for a data-driven tool. |
| Half the progression schema | `progression.rewards` and `progression.unlocks` are never read — only `xpCurve` (`progression/service.ts:76`) and `starterCredits` (`db/seed.ts:34-37`) reach runtime. `finalizeMatch` reads `gamemode.rewards` with a hardcoded `{win:0,loss:0,perKill:0}` fallback, never the progression defaults. Level gating actually lives in a parallel field, `module.requiresLevel`. `content/progression/default.json` authors all four fields, so half that file is inert — and `unlocks` is not collected by `collectReferences`, so a typo'd module id there is caught by nothing. |

**Fix (each):** implement it or delete it in one commit. Do not leave any of them half-present. Narrow `actionKind` to the two implemented kinds and reintroduce each additional kind in the same commit that implements its dispatcher.

### 8.3 God objects in the client
**Medium–Low · L each**

`client/src/**` is 33.8k production LOC against 5.7k for the server, so client complexity is where the maintenance cost concentrates.

- **`main.ts` bootstrap()** is a single 1,074-line function (`:133-1206`) holding the entire application graph in one closure: 42 top-level `const` bindings, engine/renderer selection, auth restore with two localhost dev-login special cases, design-token publication, every screen's construction, the `EditorHost` implementation, the F10 lazy-load, the `window.__debug` export, and four nested async closures (`launchChoice`, `startMatchmaking`, `startMatch`, `prepareSessionArena`) that capture surrounding scope rather than taking parameters. Grew 1,049 → 1,229 lines over the visible history. There is no seam to unit-test any part of app startup.
- **`Hangar.ts`** is 2,168 lines: a 63-method class mixing DOM construction, a live Babylon preview stage with its own `renderObserver`, server I/O, localStorage caching, swipe gestures and an idle animation loop, plus a 342-line `HANGAR_CSS` blob at `:1826-2168`. It grew 862 → 2,168 lines (2.5×) in 11 days. This is the fitting/purchase screen — the monetization surface — and it already accounted for four of five defects in the 2026-08-01 review (refresh races, stale responses, cached failed model loads, unbounded preview motion), which is exactly what a class with this many concurrently-live concerns produces.
- **`EntityView.ts`** (1,389 lines) welds post-match cinematics into the per-frame entity renderer: `ViewManager` owns the hot render path (entity maps, projectile pools, trail buffers, explosions) *and* the MVP hero shot (`heroRoot`, `heroKeyLight`, `heroPedestal`, `showMvp`, `updateMvp`). Two lifecycles with opposite requirements — a hot per-frame path where allocation matters, and a one-shot staged cinematic — share one class, so the hot path cannot be profiled in isolation.

**Fix:** mechanical extractions with no behaviour change. From `main.ts`: `createEngine(canvas)`, `restoreAuth()`, and a `MatchLauncher` class with explicit constructor dependencies — each independently testable, each removing 100–250 lines. From `Hangar.ts`: `HangarStage` (Babylon preview), `HangarInventory` (API + cache), `Hangar` (DOM + orchestration), plus `hangarStyle.ts` matching the existing `hudStyle.ts` convention. From `EntityView.ts`: an `MvpStage` class driven directly by `matchPresentation.ts`.

### 8.4 Hardcoded presentation and bot recovery
**Medium · M each**

- **Terrain presentation is in the renderer, triggered by a collision field.** `SceneBuilder.ts:539` reads `if (arena.bounds.floorY !== undefined) this.buildTerrain(...)`, and `buildTerrain` hardcodes the regolith look (`diffuseColor 0.52/0.51/0.49`, `specularPower 4`, `bumpTexture.level 0.75`, crater counts, four fixed seeds and four noise octaves). `shared/src/schemas/arena.ts` has no terrain, ground or floor-material field — `floorY` is purely a collision bound. So **every floored arena is the moon**, and a second biome means editing the renderer. Fix: an optional `render.terrain` block on the arena schema with the current values as defaults, so existing arenas stay byte-identical and a second biome costs one JSON file. This composes with §5.1 and §3.5.
- **`BotDriver`'s stuck-recovery layer is 16 undocumented magic constants** (`:148-165`) — unlike the documented `CALIBRATION_*` block immediately above. `FLOOR_NOMINAL_SPEED = 20` hardcodes a ship speed while the three shipped hulls author 18, 22 and 27, so floor prediction is systematically mis-tuned for the fast Interceptor and slow Brawler in opposite directions. The comment at `:807-809` embeds arena-specific knowledge in the arena-agnostic driver ("normal lunar spawn/base altitude (y=8..10)"). By contrast the weighted-behaviour layer above it is fully authored. Roughly a quarter of the last 40 tracked tasks were bot-unstick work, and every iteration required a code change and a redeploy rather than a JSON edit. Fix: a `recovery` block on `botprofileSchema` mirroring the existing optional `flight` block, and read floor-prediction speed from `resolveShipStats(...).engine.nominalSpeed`.

### 8.5 Documentation drift
**Medium · M**

`ROADMAP.md` §4.1 (lines 212-270) is the canonical folder tree, and much of it is fictional. Verified non-existent: `client/src/ecs/` (components and systems live in `shared/src/sim/`), `server/src/sim/`, `server/src/bots/BotDriver.ts` (it is `shared/src/bots/`), `shared/src/messages.ts`, and five of eleven listed editor files (`ShipFittingEditor.ts`, `EventEditor.ts`, `ProgressionEditor.ts`, `BehaviorEditor.ts`, `PackIO.ts`). `docs/CONTENT.md:18` states "two arenas" — there are 5. `:31` states "40 modules" — `ls content/modules/*.json | wc -l` returns 60.

`README.md` links only `ROADMAP.md` and `docs/CONTENT.md`; it never mentions `docs/FLIGHT.md`, `docs/BUBBLE.md` or `docs/COMBAT-REWORK.md`, which are the actual current contracts. So a second engineer's first hour follows README to a 61 KB document whose own banner says it is "PARTIALLY SUPERSEDED," whose folder tree does not match the repo, and whose §2.1/§2.2 describe a retired control model. Across the docs there are 17 amendment blocks and 32 retired/superseded markers — correct behaviour is the union of a base document plus up to six stacked amendments (six each for FLIGHT.md and BUBBLE.md). There is no `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING.md`.

**Fix:** regenerate the §4.1 tree from the actual tree and mark unbuilt editors explicitly; have `validate-content.ts` print the catalogue/arena counts so they cannot drift; add a short `docs/README.md` listing which document is authoritative for which subsystem in reading order; fold the settled amendment stacks into their base sections.

### 8.6 The editors are dev-only by construction
**Low · M**

The F10 handler sits inside `if (import.meta.env.DEV)`, and `tools/bundle-budget.ts:66-71` enforces that the `/__editor/` marker never appears in a production chunk. Every editor save goes through `saveConfig.ts:8` to `POST /__editor/save`, implemented only as Vite dev middleware (`client/vite.config.ts:29-50`); `/__editor/list-models` is likewise dev-only. **Neither endpoint has any authentication.** So the editor loop exists only on a machine with the repo checked out and `npm run dev` running; a live balance change on the shipped game is edit-locally → `npm run content:export` → admin import. That is a coherent workflow and it is documented in `docs/CONTENT.md` — it is simply not what ROADMAP §1.2/§1.3 describes. Fix: state the dev-only constraint plainly in ROADMAP §4.3 and the README, or move persistence behind the existing authenticated `adminContent.ts` API so the same save path works in both environments.

---

## 9. Findings that did not survive verification

Reported here for completeness, so they are not re-raised later.

| Original claim | Verdict | Why |
|---|---|---|
| **"Team size is a closed enum with three contradictory sources of truth; a shipped 5v5 mode declares `teams: \"2v2\"`"** — originally High | **Refuted; reduced to Low** | There is exactly one consumer, not three: `grep -rn "\.teams"` excluding tests returns one hit on the gamemode field (`shared/src/bots/roster.ts:59`); every other hit is `world.teams`, an unrelated ECS map. `teamSizeOf` has two callers, both in `ArenaRoom`. The claimed player-facing impact is unreachable: `Lobby.ts:154-170` files every roster-bearing gamemode under offline Practice, and `practice-bots-5v5.json` has a roster — the offline path uses the explicit roster and correctly produces 5v5 (4+5 bots + human), and `ring-nebula.json` ships exactly 10 spawn points, 5 per team. The "#1 High finding, still unfixed" attribution is also wrong: the 2026-08-04 review named `practice-ctf-5v5.json`, which no longer exists — it became `practice-ctf-10v10.json` with `teams: "10v10"` and matching roster, and the enum and `teamSizeOf` were both widened. What genuinely remains: one config file carries a value contradicting its own name, and `gamemodeSchema`'s `superRefine` never cross-checks roster/spawn counts against `teams`. A latent authoring trap worth a validation rule; not a defect anyone can hit today. |
| **"Room creation options are fully client-controlled, so the attacker picks the bot difficulty and the farm rate"** — originally High, launch-blocking | **Mechanism holds; impact refuted; reduced to Medium** | `botProfile` can only make the opponent *harder* (`duel-1v1`'s authored default is already the weakest of four profiles), and in every roster mode `ArenaRoom.ts:483` prefers the roster slot's profile anyway. `options.arena` must exist and does not affect payout; `options.seed` only matters when `bots.randomizeLoadouts` is set, which `duel-1v1` does not set. The real exploit value is `botBackfillMs: 0` removing one fixed 20-second term — an accelerant on §4.1, not a standalone finding. Retained at Medium because room creation is unauthenticated and bypasses the Express rate limiter. |
| **"POST /api/auth/login is an unbounded argon2id amplifier that OOM-kills the process and tick-starves live matches"** — originally High | **Two of three mechanisms refuted; reduced to Medium** | `verifyPassword` does not run for unknown emails — `||` short-circuits at `routes.ts:130`. Memory does not amplify: measured peak RSS plateaus at ~310 MiB from N=10 through N=100, because argon2 runs on the 4-thread libuv pool. Event-loop lag maxes at 15 ms on 4 vCPU and 35 ms pinned to one core — jitter, not starvation. What survives is real but smaller: the auth limiter's comment promises a stricter bucket the code does not implement, there is no lockout, and `/register` (which the original missed) hashes unconditionally for any unused email. See §4.3. |
| **"An online disconnect leaves the player with no way back except a page reload, holds CTF flags hostage, and flies a ghost for 30 s"** — originally High | **Core defect holds; impact overstated; reduced to Medium** | The HUD gear → Quit to Menu path exists for every session. There is no online CTF (the only CTF mode has a bot roster and is therefore offline-only). `duel-1v1` sets `respawn.enabled: false` with `eliminationEndsMatch` defaulting true, so the first kill on the ghost ends the match, and `damageAndBounce` keeps it in the arena. See §3.2. |
| **"jettisonHeatsink is dead online, but server bots can still trigger it"** | **Finding holds at High; the mitigating clause was wrong** | Bots emit only `flight` and `moduleToggle`. Nothing triggers jettison online at all, so the entire replicated decoy path is dead code — worse than reported, not better. See §3.1. |

---

## 10. Technical risk register

Ordered by expected cost. "Detectability" is whether the current pipeline would tell you it happened.

| # | Risk | Likelihood | Impact | Detectability | Mitigation |
|---|---|---|---|---|---|
| R1 | Volume loss destroys all accounts, balances and purchases | Low | Catastrophic — unrecoverable, mass refund | N/A (nothing to detect) | §6.1 Litestream + nightly snapshot + tested restore drill |
| R2 | Matchmade players earn nothing; the fair-PvP loop is dead on arrival | **Certain — happening now** | Severe — total churn of legitimate players | None (no funnel analytics) | §4.1 gate on `matchmaking === true` |
| R3 | Rate limiter collapses to one global bucket on first proxied deploy | **Certain on first real deploy** | Severe — API-wide 429s at trivial concurrency; looks like "menus are broken" | Low (WebSocket play survives, masking it) | §4.2 `trust proxy` + `TRUST_PROXY` env |
| R4 | 2.8 s freeze + Ultra tier on iOS destroys first-session retention | **Certain on the flagship mode** | Severe — retention-hostile at the exact conversion moment | None (no client FPS or timing gate) | §5.1 pre-generate textures; §5.2 probe-gate ultra |
| R5 | A bad build reaches players and cannot be identified or rolled back | Medium (recurring) | High — extended outage, wasted debugging | **None** — the 2026-08-06 incident proves it | §7.2 gate deploy on CI; §7.3 verify job; §7.4 build identity + tags |
| R6 | Credit/entitlement dispute with no record to resolve it | High once monetized | High — chargebacks, unresolvable support, processor risk | None (no ledger) | §6.2 append-only `transactions` table |
| R7 | Balance regression ships green because the bench cannot see it | **Certain — already occurred** | High — core loop unwinnable in shipped content | Inverted (the test asserts the failure) | §7.1 discriminated `timeToKill`, no `Infinity` anchors |
| R8 | Content-pack import bricks saved fittings via id rename or socket reorder | Medium (rises with content velocity) | High — corrupts data players paid for; pack rollback does not restore it | Low (fails at match join with `unknown-module`) | §6.5 two-phase referential check + stable socket-id keys |
| R9 | A browser global or Babylon import slips into `shared/`, crashing the room process | Low today, rises with velocity | High — production server crash | **None** — passes typecheck, lint and all six CI jobs; Docker makes it build-green/boot-dead | §8.1 `lib` override on both Node tsconfigs + eslint restrictions |
| R10 | Client white-screens in the wild and you learn nothing | High | Medium-High — silent, unbounded churn | **None** | §7.5 error sink + process handlers |
| R11 | Account lost with no recovery (case-sensitive email, localStorage guest token) | High | Medium-High — refunds, one-star reviews, no support lever | Low (arrives as a support ticket) | §6.6 NOCASE migration + reset flow + guest recovery code |
| R12 | Single-process deploy: every restart kills every live match; queue cannot shard | Certain on every deploy | Medium — worst at peak | High (obvious) | §6.4 drain mode now, Redis presence + Postgres later |
| R13 | LOD off + 100 particle systems puts mid-range phones under 30 FPS | High in 10v10 | Medium — mode-specific | Low (no FPS gate in CI) | §5.3 populate tier LOD distances; gate emitters by distance |
| R14 | Dev-login/JWT fallback opens on a `NODE_ENV` typo | Low | Catastrophic if it fires — full admin compromise | None | §4.5 route through `getEnv().isProduction` + explicit opt-in |
| R15 | An unauthenticated `/monitor` is the only way to get production metrics | Medium (operator turns it on) | High — anyone can enumerate and destroy live matches | None | §4.4 `requireAdmin` on both mounts (two lines) |

---

## 11. Sequenced plan

Effort: **S** ≤ half a day · **M** 1–3 days · **L** ~1 week · **XL** multi-week.

### Phase 0 — This week (unblocks everything else, ~3 days total)

Do these first because they are cheap, they are prerequisites for the rest, and two of them are the reason you cannot currently tell whether anything else worked.

| Task | Effort | Ref |
|---|---|---|
| Inject `GITHUB_SHA` + run number, emit `version.json`, add `/version`, tag deployed commits | S | §7.4 |
| Gate `deploy-pages.yml` on CI (`workflow_run` + success guard) | S | §7.2 |
| Add a `verify` job fetching `version.json` and asserting the SHA; `if: failure()` notification on both jobs | M | §7.3 |
| `app.set("trust proxy", …)` via a validated `TRUST_PROXY` env var + per-`X-Forwarded-For` test | S | §4.2 |
| `requireAdmin` on `/monitor` and `/metrics`; mount unconditionally in production | S | §4.4 |
| Add `compression` to the Express app | S | §5.4 |
| Add `"lib": ["ES2022"]` to `shared/` and `server/` tsconfigs + eslint `no-restricted-imports`/`no-restricted-globals` on `shared/src/**` | S | §8.1 |
| Add `jettisonHeatsink` to `orderSchema` + a test enumerating `Order["kind"]` | S | §3.1 |

### Phase 1 — Before public launch (~2 weeks)

| Task | Effort | Ref |
|---|---|---|
| Fix `rewardsEligible` — derive from `matchmaking === true`, never from a client field; regression tests both ways | M | §4.1 |
| Pre-generate Lunar Crater terrain textures as content assets; add a `buildArena` timing assertion | M | §5.1 |
| Make `preferUltra` a tie-breaker inside the probe; allow repeated demotes; never rebuild the arena on a demote | S | §5.2 |
| Client + server error sink (`/api/telemetry/error`, `uncaughtException`/`unhandledRejection`) | M | §7.5 |
| Rewrite `timeToKill` as a discriminated result; stop restoring hull in `runEngagement`; re-record the matrix; forbid `Infinity` anchors; delete exact-count pins | M | §7.1 |
| Populate `lodMediumDistance`/`lodLowDistance` per tier; wire ship LOD to the existing lod1/2/3 GLBs; delete or implement `thinInstances` | M | §5.3 |
| Strict `/api/auth` limiter + per-email lockout; cap guest/register creation per IP per day | S | §4.3 |
| Wire `NetClient.onStateChange` → reconnect overlay + `client.reconnect` within the 30 s window; handle `visibilitychange` | M | §3.2 |
| Spawn-pad selection by per-team count; occupancy-aware respawn; 10v10 alternating-join test | S | §3.3 |
| Boost lockout guard inside `toggleBoost` + regression test on both input paths | S | §3.4 |
| Flat terrain disc with relief in the normal/albedo textures (composes with §5.1) | S | §3.5 |
| Set `Encoder.BUFFER_SIZE = 32 * 1024` at startup | S | §5.5 |
| Email `NOCASE` migration + normalization in `emailSchema` | S | §6.6 |
| `dependabot.yml` + `npm audit --audit-level=high --omit=dev` CI step + CodeQL default setup | S | §7.6 |
| Nightly scheduled `loadtest` workflow (60 s, 20 rooms) failing loudly | M | §7.6 |
| Production-build Playwright project (`vite preview`, `SPACE_ARENA_BASE`, SW, no `window.__debug`) + a mobile device project | L | §7.6 |

### Phase 2 — Before taking money (~3 weeks, partly parallel with Phase 1)

| Task | Effort | Ref |
|---|---|---|
| Backup: Litestream to object storage + nightly snapshot + `tools/restore-check.ts` + executed restore drill | M | §6.1 |
| Append-only `transactions` ledger; `ledger.ts` as the sole writer of credits and entitlements; reconciliation test | L | §6.2 |
| `Idempotency-Key` on all purchase endpoints + `expectedLevel` on the upgrade route | M | §6.3 |
| Two-phase content-import referential check; migrate `hardpoint_map` to stable socket-id keys | M | §6.5 |
| Password reset + email verification; guest recovery code; block purchases on unverified guests | L | §6.6 |
| `DELETE /api/auth/me`, `GET /api/auth/me/export`, session-expiry sweep + retention windows + VACUUM window | M | §6.6 |
| `match_participants` join table indexed on `(user_id, match_id)`, backfilled | S | §6.6 |
| Unique `NOCASE` index on `profiles.display_name`; widen the name pool; random-suffix fallback | S | §6.6 |
| `POST /api/auth/logout` + `logout-all`; route dev-login and `DEV_ALLOW_ANON` through `getEnv().isProduction` with an explicit opt-in | S | §4.5 |
| `helmet()` with explicit CSP + HSTS | S | §4.5 |
| Server-side validation of `CreateOptions` (accept `botProfile`/`botBackfillMs`/`seed` only from the internal matchmaker) | S | §4.1 |
| Drain mode: stop accepting new rooms, wait for in-flight, then SIGTERM; document the measured room ceiling | M | §6.4 |
| Coverage measurement in CI with a ratchet-only floor | S | §7.6 |

### Phase 3 — After launch (ongoing)

| Task | Effort | Ref |
|---|---|---|
| Extract `MatchLauncher`, `createEngine`, `restoreAuth` from `main.ts` bootstrap | L | §8.3 |
| Split `Hangar.ts` into `HangarStage` / `HangarInventory` / `Hangar` + `hangarStyle.ts` | L | §8.3 |
| Extract `MvpStage` from `ViewManager` | M | §8.3 |
| Resolve the three inert surfaces: implement or delete the event system, narrow `actionKind`, resolve `progression.rewards`/`unlocks` | S each | §8.2 |
| `render.terrain` block on the arena schema; `recovery` block on `botprofileSchema`; read floor speed from resolved stats | M each | §8.4 |
| Reuse one snapshot per server tick; drop trails from the server snapshot; generation marks instead of per-tick `Set`s | M | §5.5 |
| Version the flag trail; skip resample + `CreateLines` when unchanged; return a readonly view instead of cloning | M | §5.5 |
| Distance/visibility gating on emitter particle systems; scale `maxEmitterCapacity` by expected ship count | M | §5.5 |
| Teach `RoomDriver` to open `maxClients` connections; add a 20-client CTF gate with tick and egress budgets | M | §5.5 |
| Interpolate flags; blend projectiles/decoys/flags by id in `NetGameSession.interpolate` | S | §3.6 |
| Write or delete `vx`/`vy`/`vz`; rename `encodeCenti`→`encodeDeci`; fix the arena references in the quantize docs | S | §3.6 |
| Regenerate ROADMAP §4.1 from the real tree; auto-print catalogue counts from `validate-content`; add `docs/README.md`; fold amendment stacks | M | §8.5 |
| Redis presence + driver, managed Postgres, multi-process behind a load balancer | XL | §6.4 |
| Plan the `@colyseus/core` 0.16 → 0.17 semver-major upgrade as scheduled work | M | §4.5 |

---

## 12. Bottom line

The engine is good. The determinism, the server authority model, the schema/reference-graph layer and the measured server performance are all above the bar for a project of this age, and the test suite is genuinely adversarial where it counts. Protect those.

What is missing is the ring of service infrastructure that turns a good simulation into a product someone can safely pay for: a backup, a ledger, a build identity, a crash sink, a deploy gate, and a reward path that pays the players who play fairly. Every one of those is well-understood work with a clear fix, and eight of them are half-day changes. The single most alarming pattern in the audit is not any individual defect — it is that **four separate load-bearing mechanisms (the layer boundary, the deploy, the balance bench, the reward gate) are currently protected by nothing at all, and in two cases the code or the comment asserts the opposite of what is true.** Fixing the detectability gap is worth more than fixing any single finding, because it is what stops the next one from lasting 23 hours.
