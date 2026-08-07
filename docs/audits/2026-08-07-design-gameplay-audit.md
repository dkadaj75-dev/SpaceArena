# SpaceArena — Design & Gameplay Audit

**Date:** 2026-08-07
**Scope:** core loop and combat feel, progression and economy, monetization design and readiness, UX/onboarding/retention/accessibility, multiplayer health and the bot strategy at low population.
**Method:** eleven parallel dimension audits against the working tree, followed by adversarial verification of the most serious findings. Every claim below carries a file:line, a config value, or a measured number. Findings that did not survive verification have been dropped or downgraded, and the downgrade is stated.

**Out of scope, tracked elsewhere:** infrastructure and platform security (no backups, no `trust proxy`, no crash reporting, ungated Pages deploy). Those are real and several are launch-blocking, but they belong to the ops audit. Two of them are referenced here only where they change a design decision.

---

## Executive summary

SpaceArena is a well-engineered game that currently does not work as a game. The engine underneath is genuinely strong — a deterministic, environment-neutral simulation shared verbatim by client, server and headless tools; server-authoritative netcode where the client can only send throttle/turn/pitch/fire and a module index, so the entire aimbot and damage-forge class of cheat is architecturally excluded; bots held to the identical order-validation and rate budget as humans; 1,891 tests across 168 files, green, with zero snapshot tests; and a 20-ship 10v10 room costing 0.762 ms of a 33.3 ms tick budget. That foundation is worth protecting and is not the problem.

The problem is the authored content sitting on top of it, and it is severe. Over five successive tuning commits, weapon heat was multiplied roughly twentyfold (`laser-mk1` `heatPerShot` 6 → 18 → 30 → 60 → 120) while ship heat capacity was never touched (interceptor `heat.capacity` still 100, unchanged across all ten commits that touch the file). The result is arithmetic, not opinion: **one shot from the free starter laser puts the ship 20% over its entire heat capacity, and one missile puts it 140% over.** Holding the fire button at a target that does not shoot back kills your own ship — interceptor at 20.0 s, support at 36.7 s, brawler at 53.4 s, from full hull. In a real shipped five-minute practice match, 58.8% of all hull damage and 13 of 19 deaths are self-inflicted, and the two ships fire 70 shots between them across 300 seconds. The balance regression bench that exists to catch exactly this passes green, because it restores both hulls every tick and therefore cannot observe hull loss at all.

Around that, the product layer is missing rather than broken. There is no monetization surface of any kind — no payment dependency in any workspace, no transactions table across all four migrations, no store route among the 26 API endpoints. Five of six gamemodes award zero credits and zero XP, so the flagship 10v10 CTF content is progression-dead and the entire economy hangs off a single 1v1 duel. That duel queue pairs only two waiting humans, has no timeout and no bot fallback, so at low population the modal outcome of pressing the only Online button is an unbounded wait. There is no onboarding of any kind — a repo-wide grep for tutorial/how-to-play/onboard returns nothing — while the throttle initialises to 0 and the lock-zone circle that tells you why your guns will not fire is switched off in the shipped theme.

The gap to a monetizable launch is roughly **two to three months of focused work**, almost all of it content, design and product rather than engine. The engine is ready before the game is.

### Launch-blocking items

These are ordered by what they block, not by effort. Nothing else should be worked on until 1–4 are done.

1. **The starter loadout kills its own pilot.** `laser-mk1` `heatPerShot: 120` against interceptor `heat.capacity: 100`; `criticalDamagePerSec: 4` burns hull whenever the pool exceeds capacity, which it does from the first shot. Measured self-kill at 20.0 s / 36.7 s / 53.4 s for the three hulls with no enemy present. **(§1.1)**
2. **No starter fitting can secure a kill.** TTK is literally unbounded for four of five stock matchups, and the shipped balance bench records and asserts `Infinity` as correct. `gamemode.duel-1v1` is first-to-5 and `practice-bots-1v1` is first-to-10; neither win condition is reachable through combat. **(§1.2)**
3. **The 10v10 CTF flagship cannot resolve a match.** Three full ten-minute matches produced 1 capture and 51 kills between them against a `captureLimit: 3`; all nine recorded carrier runs ended in death, the longest lasting 5.5 s of a 536-unit run home. A fifth distinct stuck-bot mode leaves ships frozen nose-down in mid-air for an entire match. **(§5.2, §5.3)**
4. **Reward eligibility is inverted: matchmade PvP pays nothing.** `ArenaRoom.ts:213` sets `rewardsEligible = options.minPlayers === undefined`, and the matchmaker passes `minPlayers: 2` — so every legitimate matchmade duel grants zero credits and zero XP, while an unvalidated client-created room does not. The repo's own `RewardEligibilityRepro.test.ts` asserts this inversion. **(§2.1)**
5. **The matchmaking queue has no low-population story.** `while (active())` with a 2 s poll and no elapsed-time branch; the server-side 90 s TTL never fires because the poll heartbeats it. No wait estimate, no bot fallback, no cancel prompt. **(§5.1)**
6. **There is no onboarding, and the shipped defaults make the first 30 seconds unplayable.** Zero tutorial content in the repo; throttle starts at 0; `reticle.showZone: false` hides the lock indicator; weapons require a lock the player is never told about; the entire curriculum is one 2,200 ms toast shown once per match. **(§4.1)**

Items 7–9 block *monetizing*, not launching, and are covered in §3: there is no payment surface at all, everything currently sellable is combat power in a PvP game with no rating system, and there is no legal or account-recovery surface.

---

## 1. Core loop and combat feel

This is the most important section in the document. Everything else is downstream of it.

### 1.1 The heat economy kills the player — quantified

The heat model has two layers, and both are well built. Heat accumulates **per module rack** (`EnergySystem.ts:57-65`) and locks that rack out at `overheatThreshold` for `overheatCooldown`. Separately, rack heat sums into a **ship pool**, and whenever the pool exceeds the hull's `heat.capacity` the ship burns `criticalDamagePerSec` hull per second (`EnergySystem.ts:98-99`). Dissipation is shared proportionally across all hot racks including locked ones. This is a good design. The numbers authored into it are not.

The arithmetic, from shipped content:

| Value | Source | Number |
|---|---|---|
| Interceptor heat capacity | `content/ships/interceptor.json` `core.heat.capacity` | **100** |
| Interceptor dissipation | ship 9 + `heatsink-basic` +21 | **30/s** |
| Critical hull burn | `core.heat.criticalDamagePerSec` | **4/s** |
| `laser-mk1` heat per shot | `fire.heatPerShot` | **120** (120% of capacity) |
| `kinetic-mk1` heat per shot | `fire.heatPerShot` | **180** (180%) |
| `missile-mk1` heat per shot | `fire.heatPerShot` | **240** (240%) |
| Measured steady-state pool, interceptor holding fire | instrumented sim | **485 / 100 (485%)** |

Critical burn is a flat 4 hull/s and the pool is pinned above capacity from the first shot, so **time-to-self-kill is simply hull ÷ 4**. Measured against shipped content on an asteroid-free bench with the target immortal *and fully disarmed* — it never fires a single shot:

| Ship | Hull | Dies at | Self-damage taken | Shots fired |
|---|---|---|---|---|
| `ship.interceptor` | 80 | **20.0 s** | 80.1 | 6 |
| `ship.support` | 110 | **36.7 s** | 110.1 | 9 |
| `ship.brawler` | 160 | **53.4 s** | 160.1 | 20 |

How it got here is visible in git history. `laser-mk1` `heatPerShot` went **6 → 18 → 30 → 60 → 120** across commits ad327ff, 0e2ae94, 18db782, 5418e09, 041e554. Across the same window, `interceptor.json` `core.heat.capacity` is unchanged at 100 across all ten commits that touch the file. The weapon half of the heat model was rescaled roughly twentyfold and the ship half was not rescaled at all.

**The rack-level consequence compounds it.** `laser-mk1` has `overheatThreshold: 121.5` against `heatPerShot: 120`, so the second shot lands at 240 and locks the rack out for 3 seconds. The effective starter duty cycle is **two shots, 11 damage, then three seconds of nothing** — roughly 3.2 sustained DPS against an 80-hull target. `missile-mk1` is `heatPerShot: 240` against `overheatThreshold: 241`; the margin is one point. These thresholds read as artifacts of the successive multiplications rather than as design choices.

### 1.2 The combat economy is inverted, and no starter fitting can kill

Single trigger tap, full-health interceptor versus a brawler:

| Weapon | Damage dealt | Self-damage | Net |
|---|---|---|---|
| `missile-mk1` | 13.1 | 18.7 | **−5.5** |
| `kinetic-mk1` | 5.6 | 10.7 | **−5.0** |
| `laser-mk1` | 4.7 | 2.8 | +1.9 |

Over a 60-second hold with a single weapon fitted, none of the three discrete starter weapons can deplete one 80-hull interceptor before killing its own pilot: `laser-mk1` fires 8 shots for 37.4 damage and dies at 27.1 s; `kinetic-mk1` fires 4 shots for 22.5 damage and dies at 20.0 s; `missile-mk1` fires 4 shots for 52.5 damage and dies at 20.0 s.

The one exception is instructive. **`beamlaser-mk1` (level 1, price 0) sustains 182.3 damage over a 60-second hold with zero self-damage and never goes critical**, on a ~1.1 s-fire / ~3 s-cool duty cycle. `fire.heatPerShot` does not apply to `mode: "continuous"`, so the beam escaped the multiplications entirely. It is the only weapon in the game with a real trigger rhythm and a real decision in it, and it demonstrates that the simulation produces a good game when the numbers are sane.

The consequence at match level, measured on a full five-minute `gamemode.practice-bots-1v1` on `arena.ring-nebula` with two `bot.rookie` interceptors on shipped default fittings, through the same code path the client uses:

- **6 deaths caused by an enemy, 13 deaths caused by critical heat.**
- 635.0 damage from weapons, 912.8 damage from critical heat — **58.8% of all hull damage is self-inflicted.**
- **70 shots fired total across both ships over 300 seconds** — one shot per ship per 8.6 seconds.
- 85 overheat events.

And this is with bots that already compensate: `bot.rookie.fireDiscipline` uses `heatHeadroom: 0.98` / `rearmHeatBelow: 0.45`, which is why they tap-fire. A human holding the hold-to-fire button does strictly worse. **The diagnosis already exists in the repo — it was applied to the bot AI instead of to the content.**

### 1.3 The balance bench is structurally blind to this

`shared/src/sim/balanceRegression.test.ts` is the only guard between a tuning change and shipped content. It cannot see the failure.

- **Line 207-208 restores hull every tick** on both ships (`subjectCore.hull = subjectCore.hullMax`), under the comment "Immortal sparring partners: the bench measures upkeep, not lethality." Critical-heat hull burn is therefore invisible to the entire scripted-engagement suite.
- The test at line 395, titled *"a 60 s all-on engagement stays survivable: pool heat never goes critical"*, implements that assertion as `expect(t.peakPoolHeat).toBeLessThan(6.5)` — **it accepts a pool at 650% of the critical threshold and reports it as never critical.**
- The TTK matrix (line 563-568) records `Infinity` for interceptor→interceptor, interceptor→brawler and brawler→brawler, and line 597 hard-asserts `expect(lightKillsHeavy).toBe(Infinity)`.
- The `timeToKill()` helper (line 558-576) loops until the *defender* dies and returns `Infinity` otherwise — **it never checks whether the attacker is still alive.** Re-running the identical bench instrumented to report who dies: interceptor→interceptor, the **attacker** dies at t = 20.0 s with the defender still at 20.3% hull; interceptor→brawler, attacker dies at 20.0 s, defender at 66.6%; brawler→brawler, attacker dies at 53.4 s, defender at 5.7%. All three are recorded as "the defender is unkillable."
- `TTK_HARD_CEILING_S` has been widened 60 → 120 → **300**, under a doc comment still stating "120 s is the narrowest whole-minute ceiling." One kill is now permitted to consume an entire match against a design target of 3–5 minute matches.

The suite is 20/20 green. It certified five successive heat multiplications.

### 1.4 The advertised skill axes do not exist in play

ROADMAP.md:60 promises skill expression from "positioning, line-of-sight play around asteroids, and module management (energy budget, heat, deploy/retract timing)."

**Line of sight.** Monte-Carlo sampling of 95-unit engagement lines (the `laser-mk1` range) against shipped asteroid layouts:

| Arena | Radius | Rocks | Lines blocked |
|---|---|---|---|
| `arena.ring-nebula` (default practice) | 126 | 14 | **0.7%** |
| `arena.deep-field` (the only online arena) | 210 | 90 | **3.2%** |
| `arena.lunar-crater` (CTF) | 360 | 39 | **1.2%** |
| `arena.twin-titans` | 100 | — | 9.6% |

Weapon ranges were multiplied 2.5× on 2026-07-31 with no matching increase in cover density. There is effectively no line-of-sight game.

**Module management.** The interceptor's `defaultFitting` is 2 weapons plus 5 internals. Weapons re-arm straight to `active` after lockout, so the pilot never re-toggles them; internals are never sheddable (`EnergySystem.shedTier` returns `Infinity` for internal families). **The starter ship has literally zero toggleable modules.** The power rail — the mechanic `ModuleSystem.clearRailFor` implements — never binds on any default fit: interceptor draws 4.5 of 15, brawler 9.5 of 19, support 7.5 of 17.

Both of the two escape hatches are also absent at level 1:

- **JETTISON** is the sole instant heat-relief path, but requires a heatsink authoring a `jettison` block. Only `heatsink-ablative` (level 3, 1500 cr) and `heatsink-cryo` (level 5, 2600 cr) have one. All three ships ship `heatsink-basic`, which does not, so `JettisonButton.ts:112` hides the control entirely. Even at level 5, cryo's 240 purge against a measured pool of 485 leaves the ship at 245% of capacity, still burning, on an 18-second cooldown.
- **BOOST** is unfittable on every hull. Verified: no socket on `interceptor`, `support` or `brawler` lists `boost` in its `accepts` array, while `boost-mk1/mk2/mk3` (0 / 300 / 900 cr) all declare `family: "boost"`. `NavigationSystem.ts:29` gates boost strictly on a fitted boost module, so no boost module means no boost. Boost is only reachable at level 2 via a boost-carrying engine, and `SettingsScreen.ts:417` still documents a Shift binding that is inert.

So the ROADMAP §S7 exit criterion — "a player winning through module management against a stat-identical opponent" — is unreachable: the stat-identical interceptor-vs-interceptor case is recorded as `Infinity` with both pilots dying of self-heat at 20 s.

### 1.5 Heat feedback fails precisely when heat is killing you

- `Gauges.ts:185` clamps the bar with `Math.min(100, ...)`, so from the second shot of the match the heat bar is pinned full and conveys nothing, while the numeric label prints the raw pool — a measured readout of **"395 / 100"**.
- The killing damage is emitted as `{ type: "damage", sourceId: null }` once per tick: **450 self-damage events in 15 seconds**, each of amount 0.1333, which `FloatingDamageText.ts:39` renders as a red "1", saturating all 24 pooled labels.
- There is no notification for critical ship heat at all. `content/notifications/` holds only boundary-warning, fire-blocked and overheat-warning, and the last fires roughly every 1.7 s under load, degrading into noise.

Even after the balance fix, a player who overheats cannot tell how bad it is — the bar reads identically at 101% and 485%.

### 1.6 What to do

The fix is content, not code. The model is sound; the scale is wrong.

1. **Rescale the ship half of the heat model.** Either raise `core.heat.capacity` / `heat.dissipation` on all three hulls by ~10–20× (interceptor 100 → ~1200, dissipation 9 → ~120, `heatsink-basic` +21 → ~250), or divide `fire.heatPerShot` back down and express trigger discipline through `overheatThreshold` and `cycleTime`. The former preserves the intent that heat binds hard. **Effort: M.**
2. **Add the invariant that would have caught this.** A ship holding FIRE at nothing for 300 s must never lose hull. Add a content-validation rule that `heatPerShot ≤ 25%` of the smallest hull's `heat.capacity`, so no single shot can push a ship into critical. **Effort: S.**
3. **Fix the bench.** Stop restoring hull in `runEngagement`; track it as an output and assert it never falls without an attributable enemy source. Make `timeToKill()` return a discriminated result (`killedAt` | `attackerDied` | `neither`) and fail on `attackerDied` instead of collapsing it to `Infinity`. Forbid `Infinity` anchors in the matrix. Re-implement the line-395 test as `peakPoolHeat < 1.0`. **Effort: S.**
4. **Add a match-level regression.** Run a scripted bot-vs-bot practice match in CI and assert that `killerId === null` deaths are under ~10% of total, and shots-per-ship-per-minute is above a floor (e.g. 30). That single test would have caught this before the fifth multiplication. **Effort: S.**
5. **Give `heatsink-basic` a modest `jettison` block** so the mechanic and its button exist from minute one, and either add a `boost`-accepting socket to each hull or remove the boost family from the unlock table. **Effort: S.**
6. **Raise occluder density** on the two default arenas so a 95-unit line is blocked 15–25% of the time, and put at least one deliberate toggleable module on the interceptor's default fitting so the module buttons have something to do. **Effort: M.**
7. **Render pool overflow explicitly** past 100%, give critical heat its own notification and audio distinct from WEAPON OVERHEATED, and coalesce self-damage events into one per ~0.25 s window. **Effort: M.**

---

## 2. Progression and economy

### 2.1 Reward eligibility is inverted — matchmade PvP pays nothing (blocker)

`server/src/rooms/ArenaRoom.ts:213`:

```
this.rewardsEligible = options.minPlayers === undefined;
```

The matchmaking queue creates its rooms at `matchmaking/roomReservations.ts:19` with `matchMaker.createRoom("arena", { gamemode, minPlayers: 2, matchmaking: true })`. It passes `minPlayers`, so **every matchmade duel gets `rewardsEligible = false`**, and `progression/service.ts:95` (`if (!eligible) return [];`) grants zero credits and zero XP for the only fair-PvP path the shipped client exposes. The repo's own `server/src/rooms/RewardEligibilityRepro.test.ts:33-46` asserts exactly this inversion.

A player who uses the matchmaking button — the only online button in the lobby — earns nothing, ever. That is the blocker half.

The mirror-image exploit (a hand-rolled client calling `joinOrCreate` without `minPlayers` gets a rewards-eligible room that backfills a bot) is real but smaller than it first appears, and **verification downgraded the related "attacker picks the bot difficulty and farm rate" finding from high to medium**: `duel-1v1`'s authored `defaultProfile` is already `bot.rookie`, the weakest of four profiles, so a `botProfile` override can only make the opponent *harder*; `options.arena` and `options.seed` have no payout effect; and because `duel-1v1` sets `respawn.enabled: false` with the implicit elimination rule, the match ends on the **first kill**, not at `fragLimit: 5`. The real amplifier is removing one fixed 20-second backfill wait. The exploit is worth closing, but it is a rider on the eligibility bug, not a separate high finding.

**Fix:** derive `rewardsEligible` from the trusted `options.matchmaking === true` flag, never from a client-supplied field; refuse or force-ineligible any direct `joinOrCreate` on a rewarded gamemode; and set `rewardsEligible = false` whenever `botsSpawned > 0` in a rewarded mode as a backstop. **Effort: M.**

### 2.2 Five of six gamemodes pay nothing

Verified across all six shipped gamemodes:

| Gamemode | Teams | Rewards |
|---|---|---|
| `duel-1v1` | 1v1 | win 100 / loss 25 / perKill 10 |
| `practice-bots-1v1` | 1v1 | **0 / 0 / 0** |
| `practice-bots` (2v2) | 2v2 | **0 / 0 / 0** |
| `practice-bots-5v5` | 2v2 *(see below)* | **0 / 0 / 0** |
| `practice-ctf-10v10` | 10v10 | **0 / 0 / 0** |
| `practice-duel-titans-1v1` | 1v1 | **0 / 0 / 0** |

Every hour of content investment visible in the task log — 10v10 CTF, the lunar crater map, flag visuals, four bot personalities, Twin Titans — is progression-dead. A player who prefers CTF earns nothing. `arena.broken-halo` ships, is manifested and geometry-tested, and is referenced by no gamemode's `defaultArena`, so it is unreachable in play. There is no player-facing arena picker.

> **Downgraded finding — `practice-bots-5v5` declares `teams: "2v2"`.** This was originally raised as a shipped inconsistency. Verification refuted the impact: `Lobby.ts:154-170` routes every roster-bearing gamemode to offline Practice, and the offline path expands the authored roster (4 + 5 bots) to a genuine 5v5 on an arena that ships exactly 10 spawn points, 5 per team. No player can trigger the 2v2 room. This is a **low**-severity latent authoring trap — the `teams` enum cannot express 5v5, and `gamemodeSchema`'s `superRefine` never cross-checks roster counts against it — that will bite on the day someone enables an online 5v5. Fix it with a validation rule, not a fire drill.

### 2.3 The curve is exhausted in under an hour, then it is a 68-hour treadmill

`content/progression/default.json`: `xpCurve: [0, 100, 250, 500, 900, 1500]` — six levels, cap 1500 XP. Credits and XP are the same number (`progression/service.ts:110-111`). `duel-1v1` is a no-respawn 1v1 so a match yields at most one frag: win = 110, loss = 25, ≈ **67.5 cr/match** at a 50% win rate.

| Milestone | Cost | Matches | Hours (at 3 min) |
|---|---|---|---|
| Level 6 (curve exhausted) | 1,500 XP | ~14 | **~45 min** |
| One best-in-slot interceptor + upgrades | 27,150 cr | ~400 | ~20 h |
| Entire catalogue (60 modules + 3 hulls × 4 tracks) | **92,150 cr** | **~1,365** | **~68 h** |

After roughly 45 minutes the level number does nothing — every `requiresLevel` gate has resolved — and progression is a linear credit accumulator against a fixed price list. That is the weakest possible retention hook for a PvP game, and a 68-hour completion horizon against roughly four hours of distinct content (one online mode, one arena) inverts the healthy ratio.

### 2.4 Permanent vertical power in a queue with no rating

`content/upgrades/hull-std.json` level 5 is `hull.base add 90` on an interceptor whose base hull is 80 (**+112%**). `engine-std` level 5 is `nominalSpeed mul 1.45`. `energy-std` level 5 is +110 capacitor / +12 regen. Each track costs 3,000 cr; all four on one hull is 12,000 cr. On top of that, mk3 weapons are roughly **2.1× mk1 nominal DPS** within every family (laser 13.75 → 28.57, kinetic 12.5 → 26.0, missile 7.0 → 15.25).

Meanwhile `server/src/matchmaking/routes.ts:29` enqueues **every player with a hardcoded `elo: 1000`**. The `profiles` table has no rating column. `eloExpansionPerSecond` defaults to 0 and `baseEloWindow` is 200, so `compatible()` is always true and pairing is pure FIFO. `MatchmakingQueue.ts:9` concedes it in a comment: "Rating scaffold. All callers currently enqueue at 1000."

A fully-upgraded account meets a fresh one in the same first-to-first-blood duel with roughly double the effective HP, 45% more speed and double the DPS. This is the structural precondition for the pay-to-win trap in §3.2, and it is also simply bad matchmaking: a new player's first online match is a one-sided loss they cannot read as anything but unfair.

### 2.5 Catalogue defects that cost the player money

**Dominated and trap purchases.** Several top-of-ladder items are strictly worse than cheaper, earlier ones:

| Item | Price / Level | Beaten by | Price / Level |
|---|---|---|---|
| `transformer-mk3` (`power.capacity +8`) | 1650 / L4 | `transformer-efficient` (`+10`, plus `energyDraw ×0.78`) | 1300 / L3 |
| `sensors-precision` (`lockRange ×1.15`, cone penalty) | 1550 / L4 | `sensors-mk3` (`lockRange ×1.55`, no penalty) | 1400 / L4 |
| `engine-racing` (speed 1.22 / accel 1.28 / turn 0.82) | 1800 / L5 | `engine-mk3` (1.55 / 1.45 / 1.25) | 1450 / L4 |
| `generator-compact-mk2` (+1 regen over free tier) | 650 / L2 | `generator-heavy` (+9 regen, +70 cap) | 1100 / L2 |

**The heat inconsistency also inverts the price ladder.** Only 5 of 15 weapons author `fire.heatPerShot` at all — and they are the free mk1s. Sustained heat while held: `laser-mk1` 330/s vs `laser-mk2` 40/s, against 30/s available dissipation. Measured 60-second hold: `laser-mk1` → 8 shots, 37.4 damage, pilot dead at 27.1 s. `laser-mk2` → **164 shots, 1,115.2 damage, zero self-damage.** That is a 30× damage jump for one level and 350 credits. Then the two priciest mid-tier weapons regress to the broken model: `laser-burst` (level 4, **1150 cr**) self-kills the pilot at 48.5 s after 65.5 damage, and `missile-heavy` (level 5, 1450 cr) is 360 heat per shot — 3.6× an interceptor's entire capacity. **A player who spends 1,150 credits receives an item strictly worse than the 350-credit one and worse than the free beam.**

**Naming collisions.** Verified directly: **16 `ui.shortName` collisions covering 36 of 60 modules.** `laser-mk3` (1000 cr) displays as "Laser Mk2"; `beamlaser-mk3` (1750 cr) as "Beam Mk2"; `kinetic-mk3` (1050 cr) as "Cannon Mk2"; `missile-mk3` (1200 cr) as "Missile Mk2"; all three heatsinks as "Radiator"; all three sensors as "Std Array". These fields drive the in-match rack labels and the Hangar picker chips, so **the moment of purchase produces no visible confirmation** on the five priciest weapons in the game.

**Orphaned content.** The three `boost-*` modules (1,200 cr of catalogue) cannot be fitted by anyone — verified, no ship socket accepts the family — yet `POST /api/modules/buy` will happily take 300 or 900 credits for one, and `content/progression/default.json` still lists them as level 1/2/4 unlocks.

**Dead config.** `progression.unlocks` (a 60-line map listing 59 module ids plus `ship.interceptor`) and `progression.rewards` are read by nothing — gating is done entirely by per-module `requiresLevel`, and `finalizeMatch` reads `gamemode.rewards`. A typo'd module id in `unlocks` is caught by neither validation nor runtime. Ships have no `price` or `requiresLevel` field at all, and no `owned_ships` table exists: **online, every account owns all three hulls from creation** — the most obvious premium SKU in a space game has no economy model.

### 2.6 The starter experience offers no decision

`starterCredits: 250`. Every level-1 module is `price: 0`, and the cheapest purchasable module is 300 cr at level 2. **At account creation there is literally nothing a player can buy.** The free kit contains no `utility` module, so the interceptor's `hp-wing-r` (accepts `["utility"]`) is permanently empty until level 2 plus 400 cr. The shipped `defaultFitting` arrays also under-fill: `brawler.json` lists 10 entries against 12 fittable sockets; `support.json` lists 9 against 10 — leaving sockets empty that the player already owns free modules for.

### 2.7 What to do

| Action | Effort |
|---|---|
| Fix `rewardsEligible` to derive from the trusted matchmaker flag | M |
| Put non-zero rewards on CTF and the team modes, and split `offlineOnly` out of `bots.roster` so they can go online | M |
| Extend `xpCurve` well past level 6 and decouple XP from credits so XP can carry mastery rewards; add per-match performance terms (damage, objectives, first blood) beyond `perKill` | M |
| Add a dominance sweep to `tools/validate-content.ts`: fail if any module is weakly dominated by another with price ≤ and level ≤ | S |
| Fix the 16 `ui.shortName` collisions; add a uniqueness check | S |
| Delete the orphaned `boost-*` family (or give it a socket); add a check that every family is accepted by at least one socket | S |
| Delete `progression.unlocks`/`rewards` or wire them as the single source of truth — shipping both with one enforced guarantees a live-ops mistake | M |
| Add a free level-1 utility module and fill every `defaultFitting` socket; add a check that `defaultFitting` covers `hardpointsOf(ship).length` | S |
| Implement the rating the scaffold is waiting for, or delete the field and say duels are unranked | M |

---

## 3. Monetization design and readiness

This is the owner's stated goal, so this section is deliberately blunt.

### 3.1 There is no monetization surface at all

Verified exhaustively:

- **No payment dependency** in any of the three workspaces. Client deps are Babylon, fontsource, shared, colyseus.js. Server deps are Colyseus, argon2, better-sqlite3, cors, express, jsonwebtoken, tsx. Shared has only zod.
- **26 API routes**, none of which is a purchase, price-list, receipt, or entitlement route.
- **No transactions/purchases/orders/receipts table** across all four migrations.
- **No cosmetic concept anywhere** in the 17 content type directories.
- ROADMAP.md:105 lists "Shop/monetization UI" first among Explicit Non-Goals (Post-MVP).

The only currency is soft credits granted 1:1 with XP. **There is nothing to sell and no way to pay.**

### 3.2 The pay-to-win trap — why "just sell credits" ends the game

This is the single most consequential commercial decision in the project, and the current content shape makes the obvious answer the wrong one.

Everything in the catalogue is combat power. Within every weapon family, mk3 beats mk1 by 2.08–2.18× nominal DPS. Worse, and specific to this codebase: **only the price-0 weapons carry a per-shot heat charge, and it is set one point below their own overheat threshold** — `laser-mk1` 120 vs threshold 121.5, `kinetic-mk1` 180 vs 181, `missile-mk1` 240 vs 241. Every paid mk2/mk3 in those families has no `heatPerShot` field at all. Only 6 of 60 modules define the field, and 3 of those 6 are the free mk1s.

So a credits IAP today would be the most literal pay-to-win product possible: **paying converts a weapon that fires roughly two shots per 3.4 seconds into one with no per-shot penalty and double the damage.** Layer that onto a queue where every player is hardcoded to elo 1000 (§2.4) and there is no bracket for the advantage to hide in — the payer meets the new account directly.

The commercial consequence is not moral, it is arithmetic. P2W shooters churn the non-paying population, and the non-paying population is the inventory that payers are buying access to. Lifetime revenue is capped by the size of the crowd you can beat up. In a game with one online mode and a 20-player concurrency ceiling at launch, that population is already the binding constraint.

**Encode the line so it cannot drift:** add `acquisition: 'progression' | 'premium'` to the module and ship schemas, and assert in CI (extend `tools/validate-content.ts`) that nothing with a stat effect is ever `premium`.

### 3.3 Recommended model

Given the content shape, one model is clearly right and the others are traps.

**Recommended: cosmetics + a seasonal pass, sold direct on web.**

| Component | Price anchor | Why it fits |
|---|---|---|
| Hull skins, engine trails, decals, kill effects | $3–8 | `render.palette` and per-ship GLB materials already exist; this is the cheapest art-to-revenue path |
| Seasonal pass, 60 days — free track grants credits/modules, paid track grants **cosmetics only** | $7–10 | The workhorse SKU, and it fixes retention by giving daily reasons to log in — which §2.3 says the game currently lacks entirely |
| Account-level convenience that is not power (extra fitting slots, stat history, private lobbies) | $2–5 | Safe, high-margin, no balance exposure |
| Rewarded video **in practice modes only**, never in ranked | — | Optional; only after analytics exist to measure it |

**Do not ship loot boxes.** Belgium and the Netherlands prohibit paid random items outright; Apple and Google both require odds disclosure; UK/EU regulation is moving one way. Direct-purchase cosmetics carry none of this exposure.

**Code work each option implies:**

| Option | Required work | Effort |
|---|---|---|
| **Cosmetics + pass (recommended)** | A `cosmetic` config type (id, slot: hull-skin / decal / engine-trail / flag-banner / kill-effect / nameplate; render overrides only, schema-forbidden from touching core stats); a `cosmetic_loadout` table keyed like `owned_modules`; replicated `skinId`/`trailId` fields on `PlayerState` — **currently `ArenaState` replicates only `shipId` and `displayName`, so a remote client cannot know what another player's ship should look like**; a Hangar cosmetics tab; and an art pipeline. | **L** |
| Sell credits / time-skips | Small code work, but requires first making all stat modules horizontal sidegrades **and** shipping a real rating system, or it is §3.2. | M code, **L** design |
| Sell modules directly | Do not. Indefensible given §3.2 with no rating. | — |
| Normalized ranked queue (enabler for any model) | All fittings resolve to a fixed power budget in ranked; casual keeps progression fits. Removes the P2W surface structurally. | **L** |

**Underneath all of them, the money spine must exist first:**

1. A `purchases` ledger (id, user_id, sku, provider, `provider_txn_id` UNIQUE, amount_minor, currency, status, created_at) with the provider txn id as idempotency key.
2. An entitlement grant service that is the **only** writer to `owned_modules`/credits and always writes a ledger row in the same transaction.
3. Server-side receipt verification per provider — never trust a client-reported purchase.
4. A `sku` content type so prices are authored data like everything else.

**Effort: XL.** This is not optional and it is not a storefront UI; it is the substrate every later feature (refunds, gifting, seasonal resets, anti-fraud) sits on.

### 3.4 Platform choice sets the take rate

No Capacitor, Cordova, Tauri or Electron in any workspace. The only packaging is a PWA manifest plus a workbox service worker.

| Platform | Take rate | Shell required | Verdict |
|---|---|---|---|
| **Web direct (Stripe)** | ~2.9% + 30¢ → **~95% net** | None | **Launch here.** Validates conversion before paying a platform tax; you buy 100% of your own UA |
| iOS App Store | 30% (15% under Small Business Program, which this qualifies for) | Capacitor/WKWebView + StoreKit | Phase 2. A PWA cannot take payment on iOS at all |
| Google Play | 30% / 15% | Capacitor + Play Billing | Phase 2, alongside iOS |
| Steam | 30% + $100 Direct fee | Electron or native | Poor fit — a browser PvP game with 3–5 minute matches |

Note the bundle constraint if you do wrap: initial payload is 6.59 MB raw / 1.48 MB gzip, and the single-container deploy currently serves it **with no HTTP compression** — so real users download 6.59 MB. That is an ops fix (add `compression` middleware, one line) but it directly affects install-funnel conversion.

### 3.5 The blockers between here and taking a dollar

| Gap | Detail | Effort |
|---|---|---|
| **No analytics** | `server/src/telemetry` is entirely tick-time histograms and FPS buckets. Client telemetry sends three fields: `fps_bucket`, `device_class`, `quality_tier`. There is no event table, no session/login event, no `last_seen_at`. **D1/D7/D30, install→first-match funnel, ARPDAU and payer conversion cannot be produced from this database.** You would be pricing by guess with no way to tell whether a change helped. | M |
| **No legal surface** | Repo-wide grep for privacy/ToS/GDPR/CCPA/COPPA/age gate/consent returns only the `cookie` npm package and unrelated identifiers. No policy documents, no consent flow, no age capture, no account-deletion or data-export route. Apple, Google and Steam all require a live privacy policy URL before review. | M |
| **No account recovery** | No password reset, no email verification, no mail dependency. Guest accounts hang off a single `guestToken` in localStorage; `routes.ts:158` explicitly refuses to re-mint an unrecognised token. Emails are stored `TEXT UNIQUE` with BINARY collation and never normalized, so `Alice@Example.com` and `alice@example.com` are two accounts and neither can log into the other. **Every lost paid account is a support ticket and a probable chargeback**, and chargebacks above ~1% put a payment account at risk. | M–L |
| **No soft-currency audit trail** | Credit debits and grants write no record. `POST /api/ships/:shipId/upgrade` has **no idempotency guard**, so a retried request buys and charges for the *next* level — up to 1,400 credits — where `POST /api/modules/buy` is naturally idempotent via its `already-owned` 409. You cannot answer "what did this player buy" for a refund or an exploit post-mortem. | M |
| **The only public build is a free-everything demo** | The Pages deploy boots into READY — OFFLINE and grants the full 56,150-credit catalogue for free under the documented rule "every price is zero." Anyone evaluating the game also sees the balance at max gear. There is no production hosting pipeline for the paid product. | M |

---

## 4. UX, onboarding, retention and accessibility

### 4.1 There is no onboarding, and the defaults make the first 30 seconds unplayable (blocker)

A grep for `tutorial|how to play|controls hint|firstRun|firstTime|onboard` across client, content, shared and server returns **zero matches**. The three things a new player must independently discover are each hidden by shipped config:

1. **Throttle initialises to 0** (`ThrottleStrip.ts:37`), so the ship spawns stationary. The only affordance is a 44px vertical strip at 60% opacity, 240px above the bottom edge.
2. **All weapons require a target lock**, but the lock-zone circle is disabled — `hud.flight.reticle.showZone: false` in the shipped theme.
3. **The entire curriculum is one notification** — `content/notifications/fire-blocked.json` ("NO TARGET LOCK", 2,200 ms), shown **once per match** via a latch in `BlockedPullFeedback.ts:29-34`.

Neither the gamemode nor the module schema has a `description` field. The Settings "Controls" readout lists only desktop bindings (Steer / Throttle / Boost module) and never mentions FIRE, module buttons, JETTISON, or that lock is required.

A player who taps "Practice — 1v1 vs Bot" sits motionless, presses the biggest red button on screen, sees nothing happen, and closes the tab. There is no funnel to monetize.

**Fix (all plumbing already exists):** seed throttle to ~0.4 on spawn; re-enable `reticle.showZone`; add three content-driven dismissable coach marks keyed on a `sa.tutorialSeen` flag; re-show the NO TARGET LOCK notification on every blocked pull for the first match. **Effort: M.**

### 4.2 Disconnect handling (downgraded to medium)

> **Verification downgraded this from blocker to medium.** The technical defect is real: `NetClient.onStateChange` is declared, fired from `room.onLeave`, and **never assigned anywhere in production code** — so an in-match socket close reaches dead code. No client code references `reconnectionToken` or `client.reconnect`, so the server's `RECONNECT_WINDOW_S = 30` seat is unusable. Once patches stop, `bracket()` clamps `t` to 1 and the world freezes silently. But three parts of the original impact claim did not hold: the player **can** exit via the HUD gear → Quit to main menu (wired unconditionally); the "hold the CTF flag hostage" scenario is unreachable because there is no online CTF; and because `duel-1v1` sets `respawn.enabled: false` with the implicit elimination rule, the first kill on the ghost ends the match, so the typical cost is one lost duel rather than 30 seconds of chaos.

Still worth fixing before taking money — a mid-match drop in the only online mode silently freezes the client with no message and costs the player the duel and its rewards. Wire `onStateChange` in `NetGameSession.join` alongside the existing callback assignments, freeze prediction, show a "Reconnecting…" overlay with a countdown, attempt `client.reconnect` inside the window, and handle `visibilitychange` so a backgrounded tab does not burn the window. **Effort: M.**

### 4.3 Friend/foe identification is unreadable

Ships get **no team treatment in the world at all** — `EntityView.ts:725` builds every hull as `master.createInstance(...)`, sharing the master material, with no tint, outline, nameplate or livery for either team. Identification rests entirely on the HUD, where it is hue-only:

| Measure | Value |
|---|---|
| `--hud-primary` #3B82F6 vs `--hud-danger` #EF4444, WCAG luminance contrast | **1.02:1** |
| Under protanopia simulation | 1.25:1 |
| Under deuteranopia | 1.33:1 |
| Under tritanopia | 1.05:1 |
| Radar contact marker | identical diamond, identical size (`contactSizePx: 3.5`) for both teams |
| Allied HUD markers | **none** (`FlightControls.ts:421` skips same-team ships by design) |
| Enemy arrow cap | `maxCount: 8` — in a mode that ships **10** enemies |

World and HUD semantics also contradict: flags are coloured by **team id** (`EntityView.ts:940`) while every HUD surface colours by **allegiance** (`hudStyle.ts:1249-1250`, "The player's team is ALWAYS blue on the left"), so a team-1 player sees their own flag red in the world and themselves blue on the radar.

In 10v10 CTF there are 19 visually identical hulls and no way to tell a teammate from an enemy without reading a 128px radar. For colour-blind players (~8% of men) the only cue collapses to a 3.5px marker at 1.25:1.

**Fix:** redundant non-colour encoding at both layers — a team tint or emissive rim on the ship instance plus an allegiance chevron over allies; different **shapes** for friendly vs hostile radar contacts (filled diamond vs hollow chevron) at different luminance; low-opacity ally markers; raise `maxCount` above the largest team size; and reconcile flag colouring onto one convention. **Effort: M.**

### 4.4 Typography fails legibility minimums across both key surfaces

The HUD root is `calc(16px * var(--hud-scale))` with `hud.landscape.scale: 0.85`, so landscape root is 13.6px. Against that:

| Element | Size | Rendered (portrait / landscape) |
|---|---|---|
| Gauge labels and values | `0.5625em` | 9px / **7.65px** |
| Module button captions | `0.52em` | 8.3px / **7.07px** |
| Match status incl. `RESPAWNING…` | `0.6875em` | 11px / **9.35px** |
| Hangar (hardcoded px, never scales) | — | 6× 9.5px, 2× 9px, 1× **8.5px**, 4× 10px, 5× 10.5px |

All of these use `--hud-neutral` / `--hg-dim`, both bound to `--sa-n-400 = #475569`, which computes to **2.65:1** on the `#05080D` panel — against WCAG AA's 4.5:1 for normal text and 3:1 even for large text. Most HUD labels have no background plate, so over the arena the ratio is worse and unpredictable. Apple HIG floors body text at 11pt; Material at 12sp.

This covers the energy/heat gauges, every module caption, the respawn indicator, and **the entire Hangar — the surface the economy is meant to be sold on.**

**Fix:** floor all HUD and Hangar text at 12px rendered; promote `--hud-neutral`/`--hg-dim` for text use to a neutral clearing 4.5:1, keeping #475569 for hairlines only; add a contrast assertion to `designSystemContract.test.ts`, which already pins the token surface. **Effort: M.**

### 4.5 The Hangar is inert

The primary depth and monetization surface renders a name, a price/level tag and stat chips only. **No module in the game has a single word explaining what it does** — there is no `description` field on the module schema. Stats use unglossed EVE vocabulary with no tooltips ("Capacitor", "Heat cap.", "DPS (est.)", "EHP (est.)", "Power rail"). Worst of all, **fitting changes nothing visually**: `juice.deploy.showMeshes: false` because module models are still placeholders, so equipping a laser, a missile or a shield produces an identical hull. And the shipped copy still reads as dev copy: *"Offline: fitting, unlocking and saving work locally, and everything is free while we test."*

This screen asks a newcomer to spend credits on an unexplained acronym with no visual payoff, while telling them the economy is not real.

### 4.6 Smaller UX findings

| Finding | Detail | Severity |
|---|---|---|
| One-thumb promise is false | ROADMAP S3/5.5 are checked off as "entire match playable with one thumb", but `RelativeSteerInput` accepts exactly one pointer and refuses touches starting on a HUD control; FIRE carries that attribute; the canvas trigger is mouse-only. Turning while shooting needs two fingers. The `thumbZoneFactor` reachability clamp is also dead in shipped content — `ModuleButtons.position()` short-circuits when the theme authors an action arc, which it does. | Medium |
| Lobby has no guidance | Six unlabelled buttons generated from `name` alone, no descriptions, no durations, no recommended path. A ten-minute 10v10 CTF is one tap from first launch. | Medium |
| Online mode is a single-life 1v1 | `duel-1v1` has `respawn.enabled: false` and no time cap, and elimination defaults to true — so `fragLimit: 5` is unreachable and it is sudden-death first-blood, for 25 credits on a loss. | High |
| Reduced motion ignored in 3D | `prefers-reduced-motion` is honoured only in CSS. `ScreenShake`, `HitFlash`, `ExplosionFx`, `cameraShake` and the MVP orbit consult only theme config and a manual toggle defaulting to `true`. | Low |
| Fullscreen prompt every launch | `maybeShow()` has no localStorage persistence and stacks on top of the auth gate at z-index 60; skipped entirely on iPhone Safari, the platform that needs it most. | Low |
| Loading roster is one colour | Both team panels share a style block with no per-team colour and no highlight for the local player — a 20-name wall on the one screen whose job is to say who you are fighting with. | Low |

---

## 5. Multiplayer health and the bot strategy at low population

The engineering here is good — server-authoritative, bots on the human trust boundary, deterministic and replayable drivers, 0.37 ms/tick for a 20-ship CTF room. The product decisions are not.

### 5.1 The queue has no low-population fallback (blocker)

`searchForMatch` (`MatchmakingSearch.ts:34`) is `while (active())` with a 2 s poll and **no elapsed-time branch of any kind**. The screen renders only a rising `SEARCH TIME mm:ss` and rotating flavour text. The server-side 90 s TTL never prunes the entry because `GET /matchmaking/status` calls `queue.heartbeat` on every poll. `MatchmakingQueue.pairAvailable` only ever pairs **two waiting humans** — there is no bot-opponent path in the queue at all, and matchmade rooms explicitly refuse backfill (`if (this.matchmade) return`).

At 20 CCU spread across time zones, the modal outcome of pressing the only Online button is an unbounded wait with no ETA and no alternative. This is the single highest-leverage churn source at launch: the player's first online action produces nothing.

**Related:** a matchmade no-show leaves the *other* player frozen. `maybeStart` only goes live at `humanSessions.size >= 2`, there is no timer on the `waiting` phase, and `matchPhase !== "live"` maps to a countdown overlay stuck on **"3"** — unable to move or fire, with no timeout and no way back except reload.

**Fix:** surface an estimated wait from recent pair latency; at ~30–45 s offer an explicit, **labelled** "Fight a bot opponent" path flagged as such on the scoreboard and excluded from ranked reward rates, keeping the queue running behind it; and put a bounded timer on the `waiting` phase that dissolves the room and re-enqueues the present player. **Effort: M + S.**

### 5.2 The bots cannot carry the pre-population period

A fifth distinct stuck-bot failure mode, instrumented on the shipped 10v10 CTF (`arena.lunar-crater`, seed 73, entity 49, `bot.rookie`) for 180 s:

- From t = 2.6 s to end of match, the bot sat at pos (−215, 10.3, 0), pitch −1.67 rad, **throttle 0.00, speed 0.00 for 5,400 consecutive ticks**, with both `floorRecovery` and `surfaceRecovery` false the entire time.
- Root cause in `BotDriver.avoidFloor` (`BotDriver.ts:804-848`): `projectedVy` is computed from the throttle the plan *wanted*, so a nose-down hull always predicts a dive; `strength` saturates to 1; and the non-recovering branch evaluates to `cmd.throttle*0 + (pitch > 0 ? … : 0)*1 = 0` — exactly zero, permanently. Neither recovery latch can fire: floor recovery requires `pos.y ≤ 5.6` (the hull is at 10.3) and surface recovery requires clearance ≤ 0.35 (there is no surface). The lift aim point is 9.6, *below* the ship.
- Across the same seed, **7 of 20 bots spent more than 50% of the match at speed < 0.5** (entity 49: 99%, 44: 86%, 48: 86%, 61: 75%, 56: 74%, 52: 51%, 53: 51%). `tools/bot-ctf-review.ts` reports `nearZeroFraction: 0.31` and `distancePer10Sec.p10: 0` averaged over three seeds.

This is the fifth round of stuck-bot work (nose-in deadlock, floor stick, wedging, colossal-rock heavy hulls). The pattern is now clear: **each fix adds another geometry-specific detector, and the failure moves to the gap between detectors.**

Compounding it, the regression harness written to catch this class of bug crashes past its 12-second default (`TypeError: Cannot read properties of undefined (reading 'pos')` at `tools/bot-stuck-repro.ts:129`, reading a dead bot's transform) — and at 12 seconds it reports zero stalled bots while a 180-second run shows one frozen for the entire match.

**Fix — two parts.** *Point:* compute `projectedVy` from the throttle about to be issued; never let `avoidFloor` return throttle 0 while above `recoveryExitY`; make the lift target `max(pos.y + clearance, safeY + band)`. *Structural:* replace the four geometry-specific detectors with **one invariant** — no bot may hold near-zero speed for more than N seconds while a plan wants throttle — with a single escape that runs regardless of why. That is the only shape of fix that stops the sixth mode. Then fix the harness (guard the transform lookup, skip dead bots, raise the window to a full match, report stall *fraction*) and gate CI on it. **Effort: M + S.**

### 5.3 10v10 CTF cannot resolve a match (blocker)

Three full offline 10v10 CTF matches through the shipped path, seeds 1/2/3:

| Seed | Captures | Flag pickups | Kills | Ended by |
|---|---|---|---|---|
| 1 | 1 | 9 | 22 | 600 s time cap |
| 2 | **0** | 3 | 16 | 600 s time cap |
| 3 | **0** | 5 | 13 | 600 s time cap |

`captureLimit: 3` was never approached; two of three ended 0–0 and were decided on the kill tiebreak. Over three separate review seeds: `captures: 0`, and **every one of the 9 recorded carrier runs ended in death** — the longest lasted 5.5 s and covered 115 units of a 536-unit run home (flag bases at x = ±268). `escortFraction` was exactly **0** for all 20 bots in all 3 seeds, despite every profile authoring an `escortOwnCarrier` weight. Combat is equally sparse: ~17 kills per 600 s across 20 ships is roughly one death per ship per ten minutes.

The map was doubled to a 536-unit base separation without the objective economics being re-derived. The mode a player is most likely to try — the biggest, most cinematic one — plays as twenty ships drifting for ten minutes and ending 0–0.

**Fix:** shrink the CTF arena or move the bases so a run home is ~10–15 s at nominal speed, or drop `captureLimit` to 1 with a per-capture score. Verify that `escortOwnCarrier` actually produces a live objective sub-role, since it currently measures at literally 0%. Gate any CTF release on a headless soak asserting captures-per-match > 0 on every seed. **Effort: L.**

### 5.4 Online multiplayer is one mode

`Lobby.buildSections` puts every gamemode declaring `bots.roster` into offline Practice and everything else into Online. Of six shipped gamemodes, only `duel-1v1` lacks a roster. **The entire online catalogue is: Duel 1v1, frag limit 5, no respawn** — and it is also the only mode with non-zero rewards. CTF 10v10, 5v5, 2v2 and Twin Titans exist only as local sessions.

A player who registers and buys into the economy gets one online game mode. The 116-config content library, the CTF systems, the flag replication work and the 10v10 arena are invisible to paying players. It also caps social retention: no team play means no reason to bring a friend.

**Fix:** add an explicit `launch: { offline, online }` capability field to the gamemode schema — stop inferring availability from the presence of a bot roster — and open at least one team mode online with a party queue. **A 3v3 with 2 humans and 4 disclosed bots plays far better at 20 CCU than a 1v1 queue does.** **Effort: L.**

### 5.5 Bot disclosure

`generateBotName` deliberately produces lobby-shaped handles (`xXTalonXx`, `R1ftHunter_`, `Quasar_77`) with the stated intent that a bot "reads as an opponent." `PlayerState` carries **no `isBot` field**; the only tell is `connected = false`, which is also what a disconnected human looks like. Nothing in the scoreboard or kill feed distinguishes them.

Today this is mostly contained — matchmade rooms refuse backfill and practice modes are labelled Practice — but it is one line of content away from being a live deception, and the reward-eligibility bug (§2.1) *already* puts an undisclosed bot into a rewards-granting match. Given that any low-population fix (§5.1) necessarily means putting bots in front of players, **add `isBot` to `PlayerState` and a BOT tag on the scoreboard now.** Keep the human-shaped names; the tag, not the name, is what makes it honest. Retrofitting this after being caught is far more expensive. **Effort: S.**

### 5.6 Other multiplayer findings

| Finding | Detail | Severity |
|---|---|---|
| Display names unfiltered and non-unique | `z.string().min(1).max(40)` — any 40 characters including RTL marks; no uniqueness check for registered users; no rename endpoint, no report, no admin tooling. There is no chat, so naming is essentially the whole griefing surface — which is why closing it is cheap. | Medium |
| Single region, single process | Process-local queue with no presence driver; local SQLite. Every player worldwide connects to one region, on top of a 100 ms client render delay. Adding a second process fragments the queue. | Medium |
| Elo scaffold with no implementation | See §2.4. Shipping a rating-shaped no-op invites the assumption that matches are balanced when they are not. | High |

---

## 6. What is genuinely good about this game

This is not padding. These are the things that make the fixes above tractable, and they should be protected during the rework.

**The simulation is deterministic and interrogable.** No `Math.random`, `Date.now` or `performance.now` exists anywhere under `shared/src/sim` or `shared/src/bots` — grep returns only doc comments saying not to use them. All randomness flows through a seeded mulberry32 with named derived streams, so a bot driver cannot perturb `World.rng`. Every `World.*Ids()` returns a sorted array. **Every number in this audit was reproducible in a short script against shipped content**, with no mocking. Most projects at this stage cannot be interrogated this precisely, and that property is why the balance problems could be quantified rather than guessed at.

**Server authority is real and minimal-surface.** The protocol admits exactly three order kinds: flight (throttle 0..1, turn/pitch −1..1, fire bool), moduleToggle (an index that must be occupied), and jettison (no args). There is no client-supplied position, damage, hit, or kill message anywhere. The aimbot and damage-forge class of cheat is architecturally excluded, not merely validated away. Loadouts are re-validated against real DB ownership and profile level at join, and an invalid result rejects the join rather than spawning an illegal ship.

**Bots are held to the human trust boundary.** `driveBots` routes every bot order through the same `validateOrder` and the same per-second budget as humans, and `imperfectCombatAim` injects held, seeded angular and velocity error. There is no bot aimbot and no sim-side privilege — so a hostile content pack cannot author a bot that issues an order a player could not.

**Performance is not the constraint.** Measured: 20 concurrent 10v10 rooms (20 ships each) at 0.762 ms mean / 1.262 ms p95 tick against a 33.3 ms budget — about 2.3% of a core per room. Network egress is 9.54 KB/s per client, ~5.7 MB over a ten-minute match. The load harness itself is unusually good engineering: server in a child process so RSS is honest, cumulative metrics diffed into windows, an explicit teardown audit.

**The data-driven thesis largely holds.** `resolveStats.ts` is a real generic add/mul stat pipeline driven entirely by JSON; internal modules change the hull purely through authored ops with no per-family code. `collectReferences()` builds a real cross-reference graph validated at load, run in CI over 116 configs. `SchemaFormGen` genuinely is one component driving ten editors via Zod → JSON Schema. Module passives encode real opportunity cost rather than flat power — `generator-siege-mk2` buys +175 capacitor for `nominalSpeed ×0.76`; `transformer-efficient` (energyDraw ×0.78, heatGen ×1.25) versus `transformer-cryo` (heatGen ×0.7, energyDraw ×1.2) is a genuine fork. **The fitting depth the design promises is real in the data model** — it is the heat scale that makes it unreachable.

**The heat model itself is a good design.** Per-rack accumulation, proportional shared dissipation across all hot racks including locked ones, a real lockout state machine, and a single instant-relief path. Every problem in §1 is an authored number, not a structural flaw — which is why they are content edits.

**The beam weapon proves the game is in there.** `beamlaser-mk1`, free at level 1, sustains 182.3 damage over a 60-second hold with zero self-damage on a ~1.1 s fire / ~3 s cool duty cycle. That is a real trigger rhythm with a real decision in it. The same simulation produces a good game with sane values.

**Test discipline is high.** 1,891 tests across 168 files, green in 51.6 s. **Zero snapshot tests anywhere** — no "just re-record everything" escape hatch. Room tests are adversarial rather than happy-path: malformed orders rejected without disturbing a legitimate client, rate-limit kicks with burst forgiveness, joins with unowned modules rejected, content-edited "hot-rod" bots held to the human order budget. Several are tagged with prior-review finding numbers, so the review loop feeds back into tests.

**The chrome around the game is well built.** The boot screen is static markup in `index.html` that paints before Babylon or the content pack exist, with three named stages and a hard-fail path that leaves the reason on screen. Server-offline is probed before first paint with a persistent badge, a 10 s auto re-probe, and a precached `offline.html` fallback. Safe-area insets are composed consistently. Match presentation is a modelled, unit-tested state machine with deterministic MVP ordering down to an entity-id tiebreak.

**Economy writes are already correct at the primitive level.** `tryDebit` is a guarded conditional `UPDATE ... WHERE credits >= ?` wrapped with the grant in one transaction, so concurrent buys cannot overspend. `finalizeMatch` is fully transactional and dedupes by userId. Passwords are argon2id; refresh tokens are rotated, single-use, and stored only as SHA-256. These are the right primitives to build a real ledger on.

**Content-pack rollback is a genuine, documented, tested capability** — data can be rolled back without a redeploy, and `docs/CONTENT.md` §7 ("What is live-reloadable — honestly") is unusually candid operational documentation.

---

## 7. Sequenced roadmap to a monetizable launch

Effort key: **S** ≈ under a day · **M** ≈ 2–5 days · **L** ≈ 1–3 weeks · **XL** ≈ a month or more.

### Phase 0 — Make it a game (2–3 weeks). Do not work on anything else first.

Nothing downstream matters until holding the fire button stops being a suicide button.

| # | Action | § | Effort |
|---|---|---|---|
| 0.1 | Rescale the ship half of the heat model (capacity/dissipation up ~10–20×, or `heatPerShot` down proportionally) across all three hulls | 1.1 | M |
| 0.2 | Author `fire.heatPerShot` consistently across all 15 weapons on one scale; re-price `laser-burst`, `kinetic-longbarrel`, `missile-heavy` out of the broken model | 1.6, 2.5 | M |
| 0.3 | Fix the balance bench: stop restoring hull, make `timeToKill` distinguish attacker-death, forbid `Infinity` anchors, re-implement the `peakPoolHeat < 6.5` test as `< 1.0`, re-record the matrix | 1.3 | S |
| 0.4 | Add the guard rails: `heatPerShot ≤ 25%` of smallest hull capacity; a hold-fire-at-nothing-for-300 s invariant; a CI bot-vs-bot match asserting self-kills < 10% and shots/ship/min > 30 | 1.6 | S |
| 0.5 | Give `heatsink-basic` a `jettison` block; fix or delete the boost family; add a check that every module family has a socket | 1.4, 2.5 | S |
| 0.6 | Fix the bot stuck-mode: point fix in `avoidFloor` plus the single "near-zero speed while throttle wanted" invariant replacing the four detectors; repair and CI-gate the repro harness | 5.2 | M |
| 0.7 | Re-derive CTF objective economics (shrink base separation or drop `captureLimit` to 1); verify `escortOwnCarrier` produces a live sub-role; gate on captures > 0 per seed | 5.3 | L |

**Exit criterion:** a stock interceptor kills a stock interceptor in a bounded, finite time without self-damage; a scripted bot practice match resolves through its win condition; CTF produces captures on every seed.

### Phase 1 — Make it a product (3–4 weeks)

| # | Action | § | Effort |
|---|---|---|---|
| 1.1 | Fix `rewardsEligible` to derive from the trusted matchmaker flag; refuse client-supplied room options on rewarded modes | 2.1 | M |
| 1.2 | Ship first-match onboarding: throttle seeded to 0.4, `reticle.showZone` re-enabled, three content-driven coach marks, persistent NO TARGET LOCK for match one | 4.1 | M |
| 1.3 | Add the queue wait ladder + labelled bot-opponent fallback at ~30–45 s; add `isBot` to `PlayerState` and a BOT tag on the scoreboard; put a timer on the `waiting` phase | 5.1, 5.5 | M |
| 1.4 | Give practice and CTF modes real (reduced) rewards; add `launch: { offline, online }` to the gamemode schema; open one team mode online | 2.2, 5.4 | M |
| 1.5 | Wire `NetClient.onStateChange`: reconnect overlay, `client.reconnect` inside the 30 s window, `visibilitychange` handling | 4.2 | M |
| 1.6 | Accessibility pass: redundant shape encoding for friend/foe on radar, team treatment on hulls, 12px text floor, contrast token promotion, contrast assertion in the design-system test | 4.3, 4.4 | M |
| 1.7 | Catalogue hygiene: fix the 16 `shortName` collisions, add the dominance sweep to `validate-content`, fill every `defaultFitting` socket, add a free level-1 utility module | 2.5, 2.6 | S |
| 1.8 | Add product analytics: an `events` table plus ten instrumented events (app_open → purchase_complete), `last_seen_at` on profiles, retention/funnel queries in `telemetry-report` | 3.5 | M |
| 1.9 | Extend `xpCurve` past level 6, decouple XP from credits, add per-match performance reward terms, re-price against a stated target (competitive fit in ~3 h, catalogue as a months-long chase) | 2.3 | M |
| 1.10 | Lobby descriptions and durations; replace the "everything is free while we test" copy; add module `description` and stat tooltips in the Hangar | 4.5, 4.6 | M |

**Exit criterion:** a stranger on a phone can guest-join, be taught the controls, fight a bot within 60 s, earn credits from any mode they play, and never be silently stranded.

### Phase 2 — Before taking a dollar (4–6 weeks)

Ordered so that no money moves before the substrate exists to account for it.

| # | Action | § | Effort |
|---|---|---|---|
| 2.1 | Build the money spine: `purchases` ledger with provider-txn idempotency; a single entitlement grant service that is the only writer to credits/entitlements; a `sku` content type | 3.3 | XL |
| 2.2 | Add idempotency keys to `POST /api/ships/:shipId/upgrade` and the buy path; route every credit movement through the ledger; build the admin grant/refund CLI | 3.5 | M |
| 2.3 | Account recovery: email verification, password reset, normalized (`COLLATE NOCASE`, lowercased) emails, guest recovery codes; block purchases on unverified accounts | 3.5 | L |
| 2.4 | Legal surface: ToS and privacy policy at stable URLs, neutral age gate storing a bracket, `DELETE /api/account` and `GET /api/account/export` (cascades already exist) | 3.5 | M |
| 2.5 | Encode the P2W line: `acquisition: 'progression' \| 'premium'` on module/ship schemas, with a CI assertion that nothing stat-bearing is ever `premium` | 3.2 | S |
| 2.6 | Build the cosmetic layer: `cosmetic` config type (render overrides only), `cosmetic_loadout` table, replicated `skinId`/`trailId` on `PlayerState`, Hangar cosmetics tab | 3.3 | L |
| 2.7 | Implement rating: a rating column, Glicko-2 or Elo at match finalize, real `elo` at enqueue, non-zero `eloExpansionPerSecond`, plus loadout-power as a second bracketing dimension | 2.4 | L |
| 2.8 | Stand up a real production deployment of the container on a custom domain; reposition the Pages build explicitly as a demo | 3.5 | M |
| 2.9 | Launch web-direct via Stripe with cosmetics only. **Do not ship credits-for-money and do not ship loot boxes.** | 3.3 | L |

**Exit criterion:** a real payment completes, is verified server-side, writes a ledger row, grants a cosmetic-only entitlement, and can be refunded by an operator — and the analytics can report conversion on it.

### Phase 3 — After launch

| # | Action | § | Effort |
|---|---|---|---|
| 3.1 | Seasonal pass (60 days), free track granting credits/modules, paid track cosmetics only — the workhorse SKU and the retention fix | 3.3 | L |
| 3.2 | Normalized ranked queue where all fittings resolve to a fixed power budget; casual keeps progression fits | 3.3 | L |
| 3.3 | Capacitor shells for iOS/Android with StoreKit and Play Billing, verified against the same entitlement service | 3.4 | L |
| 3.4 | Add ship ownership as an economy: `owned_ships` table, `price`/`requiresLevel` on the ship schema, hull gating in `ownershipContext`; delete either `progression.unlocks` or per-module `requiresLevel` | 2.5 | L |
| 3.5 | Horizontal-power rework: make mk-tiers sidegrades rather than 2.1× DPS ladders, so the catalogue is a build space rather than a power ladder | 2.4 | L |
| 3.6 | Regional expansion: shared queue store with a Colyseus presence driver, Postgres, region ping probe at boot | 5.6 | XL |
| 3.7 | Display-name policy: constrained character class, case-insensitive uniqueness at the DB level, wordlist filter, authenticated rename, admin reset | 5.6 | S |

---

## Appendix: severity changes from adversarial verification

Four of the most serious findings were independently re-tested. Two were confirmed, two were reduced. They are reported here at their corrected severity.

| Original claim | Verdict | Corrected severity | Note |
|---|---|---|---|
| Reward eligibility inverted — matchmade PvP pays nothing | **Holds** | **Blocker** | Confirmed at runtime. The blocker is the matchmade-pays-zero half; the farm-exploit half is real but smaller than claimed |
| `jettisonHeatsink` rejected at the trust boundary | **Holds** | **High** | The wire schema admits only `flight` and `moduleToggle`; the jettison order parses as malformed. Correction: nothing at all triggers jettison online — bots emit only two order kinds, so the entire replicated decoy path is dead online. Mitigating: the heatsinks' passives still apply, so the purchase is not worthless |
| Client-controlled room options let an attacker pick bot difficulty and farm rate | **Refuted as stated** | **Medium** (was high) | `bot.rookie` is already the weakest profile, so overrides can only make the opponent harder; `arena`/`seed` have no payout effect; the amplifier is one 20 s wait. Real unvalidated input, but a rider on the eligibility bug |
| No in-match disconnect handling — client freezes forever | **Holds, impact reduced** | **Medium** (was high/blocker) | The dead `onStateChange` and unusable reconnect window are real. But the player can exit via HUD gear → Quit; there is no online CTF so no flag-hostage scenario; and `duel-1v1` ends on first kill, so the cost is one lost duel |
| `practice-bots-5v5` declares `teams: "2v2"` | **Refuted as stated** | **Low** (was high/medium) | The mode is offline-only by lobby routing and plays as a genuine 5v5 on an arena with 10 spawn points. A latent authoring trap, not a shipped inconsistency |

Two further findings from adjacent audits are noted here because they change design decisions, though they belong to the ops audit: the rate limiter keys on `req.ip` with no `trust proxy` (behind any TLS terminator the whole playerbase shares one 10 req/s bucket), and the login endpoint's argon2 exposure was **downgraded from high to medium** on measurement — memory plateaus at ~310 MiB regardless of concurrency and event-loop lag peaks at 35 ms on a single core, so it is a brute-force surface rather than a process-killer.
