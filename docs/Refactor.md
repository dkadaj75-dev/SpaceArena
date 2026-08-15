# Refactor plan — Orion's Arm

Produced 2026-08-15 by a six-lens audit of ~67k lines of source (client 43k,
shared 17k, server 6k, tools 8k), followed by adversarial verification of every
finding. **38 findings survived; several were rejected outright** — those are
recorded in the notes below where they matter, because a rejected finding is
often more useful than a confirmed one.

Three of the rejections are worth stating up front, as they show the failure
modes this kind of audit produces:

- A batch of "unreferenced" CSS included `.sa-screen-btn--accent`, which is
  applied through a template-literal class name (`sa-screen-btn--${variant}` at
  `Lobby.ts:206`). Deleting it would have visibly regressed the Lobby's Hangar
  and Shop buttons. Regex-based reference checks cannot see composed class names.
- A batch of "superseded" terrain tooling included two scripts added *the day
  before* as the manual verification instruments for the seam rebuild. The
  criterion "not in an npm script or CI" does not imply dead in `tools/` here,
  because the live terrain pipeline is not in `package.json` either.
- "Every mobile device is pinned to the cheapest tier" is true, but it is
  deliberate policy from `docs/audits/2026-08-12-mobile-perf-audit.md`, not an
  accident. The genuine finding underneath is narrower: every `allowMobile`
  field is therefore unreachable.

Nothing in this document has been executed. It is a plan.

---

## 1. Where this codebase actually stands

This is a mature, unusually well-documented codebase, and most of what looks wrong on first read turns out to be load-bearing and explained in a comment next to it. Six independent audit lenses spent their time trying to break claims, and the healthiest result is how often the code won: the asteroid radial-field evaluation is correctly guarded by a bounding-sphere reject at all three sim entry points (`CollisionSystem.ts:45-58`, `ProjectileSystem.ts:239-250`, `los.ts:44-57`); `ConfigService.get` in per-entity loops measures 10.7 ns for a tuning lookup and 17.0 ns for a module lookup, under 1 µs/tick total, and the hot-reload behaviour it buys is worth more than the nanoseconds; `spatialHash.ts:6` documents its own iteration-order invariant before anyone needed to discover it; `ConfigService.ts:44-52` caps pack loading at 12 and says why. The god objects have already had their pure logic extracted and tested (`hangarLayout`, `hangarStats`, `hangarGating`, `HangarApi`, `hangarLoadout`, `ownershipStore`, `shopModel` all have real test files). The collision suite includes a 10,000-seeded-query brute-force cross-check of the BVH. And the sim really is deterministic in practice: every A/B in this audit — memoising bot context, unrolling slab tests, adding a bounding-sphere reject — produced byte-identical match fingerprints.

Three things genuinely need work, and they cluster.

**The gates measure the wrong surfaces.** `npm run bundle:budget` sits at 30.5% of its 5 MB ceiling with 82% of the measured bytes being Babylon — first-party app code would have to grow 17x before it fires. `tools/bundle-budget.ts` reads only `client/dist/assets/*.js`, so the ~53 MB content pack has never been under any gate. `npm run validate:terrain` exists at `package.json:20`, passes in 1.73 s, and is referenced by nothing. The service worker precaches 291 kB nobody uses. None of this is negligence; it is a set of gates that were correct when written and have been outgrown.

**Allocation, not arithmetic, is the mobile cost.** The headless profiles found 19-24 MB/s of garbage at 30 Hz — a scavenge roughly every two ticks. The largest CPU entries are not clever algorithms doing too much work; they are three functions allocating array-of-tuple literals inside loops that run thousands of times a tick. On the client, one decorative GLB installs a whole-scene re-render, and one 4096×2048 panorama is 36% of GPU texture memory on the tier built for budget phones.

**Two seams have no contract.** The 74-field `Snapshot ⇄ ArenaState ⇄ decode` mirror is hand-maintained across three packages, the client decodes all of it through `any`, and five schema fields have already drifted unread. And nothing in the suite pins a golden sim fingerprint — every determinism test is `run(seed) === run(seed)` in one process, which cannot notice a change that alters iteration order identically in both runs.

None of the findings below are style nits. Seven candidate findings were rejected during verification and do not appear.

---

## 2. Do this first: the safety net

Every risky item in section 5 depends on at least one of these existing. Total: roughly 2-3 days.

### 2a. Commit a golden sim fingerprint (blocking for all sim work)

Enumerating every determinism assertion in the suite found 17 `it` titles matching `/determin/`, and all of them are same-process A-vs-B. `shared/src/sim/balanceRegression.test.ts:462-466` is literally `expect(JSON.stringify(a)).toBe(JSON.stringify(b))` on two calls to `runEngagement`, under the title "is bit-for-bit reproducible across runs". `shared/src/sim/systems/Ctf.test.ts:352-365` is `expect(run()).toEqual(run())`. `client/src/game/gameSessionDeterminism.test.ts:65-77` is `expect(a.events).toBe(b.events)` on two `run(4242)` calls. Repo-wide there are **zero** committed golden values: no `toMatchSnapshot`, no `__snapshots__` directory, and the only two `__fixtures__` files are a fake store and shop content. The existing pinned literals are band-shaped — `BAND = 0.06` at `balanceRegression.test.ts:59`, `TTK_BAND = 0.25` at `:663` — which is many orders of magnitude looser than bit-exact.

**Be honest about why this matters.** The verifier corrected the original justification and the correction stands: this is *not* lockstep netcode. `client/src/net/NetGameSession.ts:51` sets `SNAP_DISTANCE = 3` and `:150-203` document snapping and blending the predictor onto authoritative samples; `server/src/rooms/ArenaRoom.ts:232` runs the authoritative sim. A float-sequencing divergence costs prediction accuracy (a visible snap), not a desync. There is also no replay persistence anywhere in the repo — every "replay" mention means "the same seed reproduces the same match". So the correct case for this test is: it is a cheap regression net for balance and behaviour drift, it makes good on the machine-independence `balanceRegression.test.ts:46` already claims in prose, and it is the only thing that lets you land the section-3 and section-5 sim changes with proof rather than assertion.

Add: a fixed scenario (scripted orders, fixed seed, asteroid-free bench arena, N ticks) whose SHA-256 over the serialized event stream plus final transforms is a checked-in literal. Add a second vector on `gamemode.practice-bots` so bot decision ordering is pinned too. Test-only; no `Date`, no `Math.random`; zero determinism risk in the addition itself.

### 2b. A `SpatialHash` query-order test (blocking for the static/dynamic split)

`shared/src/sim/spatialHash.ts` (77 lines) has no direct test file. It is exercised indirectly by every sim test through `shared/src/sim/testutil.ts:97-107 rebuildSpatial`, and all four consumers have their own suites, so it is not unguarded — but nothing asserts **order**. The documented invariant at `spatialHash.ts:6` ("cells and returned ids are iterated in insertion/id order") is genuinely load-bearing in exactly one place: `CollisionSystem.ts:45-64` mutates `st.pos` inside the candidate loop, so two overlapping rocks push out in query order and float addition is not commutative. `los.ts:44` is an any-hit boolean and `ProjectileSystem.ts:270` / `CombatSystem.ts:299` select nearest by strict `<`, so both are order-insensitive except on exact ties. Pin a fixed insertion sequence and assert the returned id sequence, not just membership. ~30 lines.

### 2c. A field-name contract for the wire schema (blocking for anything touching replication)

`server/src/rooms/state/ArenaState.ts` declares 75 `@type` fields in 220 lines. `ArenaState.test.ts` is 23 lines and asserts four of them. `client/src/net/NetGameSession.ts:1` carries a file-level `no-explicit-any` disable and every decoder is `any`-typed: `receiveState(state: any)` `:673`, `decode(state: any)` `:884`, `decodeModules(raw: any)` `:1023`, `decodeTeamScores` `:1072`, `decodeDecoys` `:1090`, `decodeFlags` `:1138`. There is no import path from server to client, so `npm run typecheck` cannot see the coupling. Client tests build the wire shape as hand-written literals (`replicatedObjectives.test.ts:17-22`). Renaming `FlagState.dropRemaining` server-side passes typecheck, lint, and both tests.

Note what *is* linked, so the claim stays accurate: the **value** encodings are shared and typechecked on both sides (`replicatedObjectives.test.ts:2` imports `encodeCenti`/`encodeFlagState` from `@space-arena/shared`; `NetGameSession.ts:3-13` imports the matching decoders). What is unlinked is field **names and presence**.

Add: enumerate `Object.keys()` of a constructed `PlayerState` / `ModuleState` (note: the class is `ModuleState`, not `ModuleStateSchema`) / `FlagState` / `DecoyState` / `TeamScoreState`, assert against a frozen list exported from `shared`, and have the client decoders assert against the same list. ~60 lines, one file each side.

### 2d. Wire `validate:terrain` into CI (30-line job, zero cost)

`grep -rn 'validate:terrain'` returns exactly one hit: its own definition at `package.json:20`. It is absent from `.github/workflows/ci.yml` (six jobs: typecheck, lint, test, content, build, e2e), from every git hook, and from all docs. It passes today — all three LOD modes print "PASS: chunk borders meet", worst seam 0.0502u, 0 open edges — in 1.73 s wall. It reads only committed assets (`content/arenas/lunar-rift.json`, `content/props/lunar-rift-chunk-*.glb`), so a plain checkout suffices. Add a `terrain` job mirroring the `content` job shape, with no `needs:`.

### 2e. Make `bundle:budget` a regression detector

`tools/bundle-budget.ts:51` sets `BUDGET_GZIP_BYTES = 5 * 1024 * 1024`. Measured: INITIAL 6.73 MB raw / 1.53 MB gzip across 3 chunks — babylon-core 1.26 MB, vendor 59.7 kB, index (all first-party, since `client/vite.config.ts:212-221` returns undefined for anything outside `node_modules`) 209.8 kB. First-party code would need to reach 3.6 MB gzip before the gate fires.

Add a per-chunk ceiling on `index-*.js` (~260 kB gzip against today's 210 kB) *and* an assertion on the **set** of chunks `index.html` names. The set assertion is the part that matters: a per-chunk ceiling alone would not fire if `babylon-loaders` (54.4 kB gzip, currently lazy) were promoted into the initial set. Keep the editor-smuggling checks at `:17-22` and `:23-25` untouched — they are documented §11 6.3 guards and are genuinely load-bearing. Note the index ceiling is a ratchet that needs re-baselining as features land; that is the intended cost.

### 2f. Fix the CTF delivery test before it eats a correct refactor

`shared/src/bots/CtfBots.test.ts:494-520` is one boolean on one seed: `playLunarCtf(6, 180)` then `expect(events.some(e => e.type === 'flagCaptured')).toBe(true)`. Its own 24-line comment records the seed history 11 → 4 → 12 → 6 across three days and its own measurement: a fresh 20-seed sweep found "only 6 and 10 still capturing inside 180 s, against 12 of 20 before" — a 2/20 population rate. It is the slowest test in the file at 6.3 s of 11.24 s total. The author's own note at `:516` says "worth a design answer rather than a re-pin next time".

It is deterministic, so it does not flake — it is *refactor-fragile*, and only to changes that perturb combat math or RNG-consumption order. That is precisely section 3b and section 5a.

The originally proposed fix does not work: with a 2/20 rate, `>=1 of 8 seeds delivers` passes only if seeds 6 or 10 are among the chosen 8, which is the same pin at 8x the runtime. Do instead: (1) assert pickup health (`flagTaken > 0` per seed) across a sweep — the comments record 1-8 pickups on *every* seed, so this is the robust signal already measured but never asserted; (2) if a delivery assertion is kept, make it a floor honestly derived from the population (`>=1 of the full 20 seeds`, or move the sweep to a nightly job) with observed per-seed counts in the failure message; (3) delete the single-seed boolean rather than re-pinning it. Apply the same treatment to `shared/src/bots/BotIntegration.test.ts:459-467`, which carries an identical 11 → 5 re-pin.

---

## 3. Safe wins

Mechanical, individually revertible, and several can land in one pass.

### 3a. Delete dead code — one commit, no behaviour change

These can go together; each is independently proven by a whole-repo reference search including `content/*.json`, GLB JSON chunks, `tools/`, tests and docs.

- **`client/src/game/hud/minimapAltitude.ts`** (38 lines) + its test (51 lines, 7 tests, 4,014 B total). Only importer is its own test at `minimapAltitude.test.ts:2`. Independently confirmed absent from the shipped bundle: the checked-in `client/dist/assets/index-aYx4KQgN.js` contains 4 occurrences of the *theme key* `minimapAltitudeTickPx` and zero of `altitudeTickPx`. Superseded by `radarProjection.ts:74`, consumed by `Minimap.ts:121`. Its docstring points at `Minimap.applySize`, a method that no longer exists. If the sub-half-pixel suppression is worth keeping, move that one line into `radarProjection.ts:74`.
- **Twelve unreferenced exports.** `KillAnnouncements.ts:20 ANNOUNCE_MS`; `flightHudLayout.ts:387 boostLayoutFrom`; `botLoadout.ts:7 MAX_BOT_MODULE_LEVEL`; `ship.ts:183 isInternalSlot`; `math.ts:116 pitchToward`; `math.ts:66 turnToward`; `spawn.ts:22 resolveShipCore`; `env.ts:305 resetEnvCache`; `staticSite.ts:124 isBuiltClientDir`; `metrics.ts:347 resetMetrics`; `tools/lunar-rift/field.ts:457 HIGHLAND_TOP`; and `client/src/editor/repository/DevEditorRepository.ts` (a 5-line, 315 B re-export alias with no importer). Each has exactly one occurrence repo-wide: its declaration. `shared/package.json` is `"private": true` and the only consumers are `client/` and `server/`, both grepped. **Determinism:** two live in `shared/src/sim` (`math.ts:116`, `math.ts:66`, `spawn.ts:22`) — all pure and uncalled, so removal cannot change iteration order or float sequencing. Two corrections to carry: `pitchToward` is *not* a duplicate of `advancePitch` (different signature and semantics — `advancePitch` applies a delta and wraps or clamps, documented at `math.ts:200-215`); only `resolveShipCore` is a true redundant twin, of `resolveShipStats`. And `ANNOUNCE_MS` is the only in-code note that it mirrors the 1.8 s animation at `hudStyle.ts:1260` — move that note into the CSS when deleting.
- **The queue-based matchmaking client trio.** `MatchmakingScreen.ts` (197), `MatchmakingSearch.ts` (55), `MatchmakingClient.ts` (54), plus tests (166 lines) and CSS `screenStyle.ts:784-844` (2,348 B measured). Outside the import closure from `main.ts` — `main.ts:49-61` imports 8 screens and this is not among them; `MatchmakingClient` is imported only by `MatchmakingSearch.ts:2`, which is imported only by its own test. The replacement is explicit: `MatchLoadingScreen.ts:124` documents itself as "loading + matchmaking in ONE screen", and the online join goes through `NetClient.ts:54 client.joinOrCreate("arena", options)`. **The fix has one gap the original missed:** `.sa-matchmaking-scanner span { animation: none; }` lives at `screenStyle.ts:742`, inside the shared `prefers-reduced-motion` block at `:740-743`, *outside* the 784-844 range. Reconcile that line too, plus the isolation-group entries at `:222`/`:229` and the contract entry at `twoLayerStyle.test.ts:25`. Server side: `MatchmakingQueue` is still constructed at `index.ts:34` with a live 90 s TTL and the router is still mounted and rate-limited at `httpApp.ts:92` — decide deliberately (unmount and delete, or add a header saying it is a future re-entry point with no current client) rather than leaving it ambient.
- **`content/actions/play-sound-boost-down.json`** (263 B): zero references outside `manifest.json:137`. Its sibling `play-sound-boost-up` is referenced by `heatsink-ablative.json:28` and `heatsink-cryo.json:28`, so only the disengage half was never wired. Note the `"[SOUND: boost_disengage]"` placeholder is *not* evidence of neglect — `shared/src/schemas/theme.ts:515-521` establishes placeholders as the sanctioned form, and all nine shipped play-sound actions carry one. Either wire it or drop it; wiring an action named "Boost Disengage" onto a heatsink retract is a naming mismatch, so dropping is probably right.

### 3b. The sim/bots allocation wins — land after 2a, A/B each against the fingerprint

All three were measured with match fingerprints byte-identical before and after. Land them one commit each so a fingerprint change bisects cleanly.

- **Unroll `segmentBounds` and `segmentAabb`** (`shared/src/collision/staticWorld.ts:123-133`, `shared/src/collision/bvh.ts:141-151`). Both loop `for (const [origin, delta, low, high] of [[...],[...],[...]])`, allocating one outer array plus three 4-element tuples per call, plus a fifth on any `[a,b] = [b,a]` swap — for a six-comparison slab test. On `arena.lunar-rift` with 10 bots these are the two largest CPU entries by a wide margin: `segmentAabb` 27.6% and `segmentBounds` 18.9% of all samples, 46.5% together, with `StaticWorld.raycast` at 59.5% inclusive. Replacing both with three calls to a scalar axis helper over module-level scratch took the whole loop from 1.372 to 0.524 ms/tick (−62%), fingerprint identical across six runs, collision suite 30/30 green including the 10k brute-force BVH cross-check. **Correction to carry:** the cost is paid overwhelmingly in the *bots* phase (~80% of the frame in the verifier's harness), not `sim.tick` (~19%) — the original "sim.tick is 76% of the frame" is wrong. **Keep `Math.max`/`Math.min` verbatim** rather than substituting comparisons: they differ on NaN and −0, and this code divides by a delta that can be zero-ish. Isolated microbenchmark is ~3.7x (77 → 21 ns), not the originally claimed 5.7x. Second win left on the table: `bvh.ts:118 vertex()` still returns a fresh 3-tuple per vertex, so `triangleSegment`/`triangleNormal`/`closestOnTriangle` allocate ~6 objects per triangle tested.
- **One-slot memo for the blocker/hazard list** (`shared/src/bots/context.ts:154-161`). The loop materialises two `{pos, radius}` objects per asteroid, depends on nothing but `snapshot.asteroids`, and runs ~17x/tick (`BotDriver.ts:547` sampleThreat, `:576`/`:594` decide, `:896` updateTrigger). `buildBotContext` is the largest non-idle self-time entry on both asteroid arenas: 16.6% on deep-field, 12.3% on ring-nebula. A one-slot module-level memo keyed on snapshot identity cut the bots phase 33% and the whole loop 19% on ring-nebula; 38%/25% on a 10-bot deep-field. Identity keying is sound with no clear-hook needed: `ArenaSimulation.snapshot()` (`:779`, asteroids at `:824`) allocates fresh arrays every call and `ArenaRoom.ts:602` takes one per bot-update pass — unlike the value-keyed precedent at `roleAllocator.ts:51`, which does need `clearRoleAllocationCache()`. A `WeakMap<Snapshot, …>` was measured and is **worse** (keeps every tick's arrays alive, promoting to old space; snapshot and sim.tick both regressed ~20%).
- **Bounding-sphere reject before `rockCollider`** (`shared/src/bots/recovery.ts:536-539` → `:615-626`). `restSurfaces` builds a `RestSurface` for every non-destroyed asteroid, then `activeContacts` (`:353-365`) discards everything with `clearance > VISUAL_MARGIN + own` — typically all of them. This is the one path into the radial field with no bounding-sphere guard. `restSurfaces` inclusive is 11.4% of samples on deep-field, 6.8% on ring-nebula. The reject is **provably behaviour-identical, not an approximation**: `colliderRestSurface` computes `clearance = |d| − selfR − collider.radius`, and the sampled surface radius never exceeds `boundRadius`, so clearance from the bound is a lower bound on true clearance — rejecting when the *lower* bound already exceeds the band can only drop entries `activeContacts` would have discarded. `restSurfaces` has exactly one caller (`:356`), and `surfaceByKey` (`:546`) resolves latched keys through `colliderById` independently, so the reject cannot strand a latched surface. Fingerprint identical in every A/B run.

**Scope these honestly.** All three arena framings in the original findings were corrected: `arena.deep-field` (148 rocks) is the default arena of `gamemode.duel-1v1` only, so a 10-bot deep-field run is synthetic. The shipped 5v5 arena is `ring-nebula` (46 rocks), and the shipped CTF arena `lunar-rift` has **zero** asteroids — so the two asteroid-related wins are nil there, while the slab-test win is largest there.

### 3c. Client render wins — small diffs, large numbers

- **Kill the transmission pass** (`content/props/lunar-rift-he3-plant.glb`, material `ArmoredGlass`). It is the only asset in `content/` declaring `KHR_materials_transmission`/`_volume`/`_emissive_strength`, with `transmissionFactor 0.15` and `alphaMode BLEND`. Since 0.15 > 0, Babylon constructs a `TransmissionHelper` which creates a 1024×1024 HALF_FLOAT MSAAx4 mipmapped `opaqueSceneTexture` (~11 MB) and — critically — registers `scene.onNewMeshAddedObservable` at `KHR_materials_transmission.js:120-126`, so the render list keeps absorbing ships, asteroids and terrain as they spawn. `grep -ri transmission` over `client/src` and `tools/` returns zero hits; no quality tier touches it. The runtime A/B (168 → 119 draw calls, 910,032 → 517,278 active indices, 5.7 → 5.3 ms after `scene._transmissionHelper.dispose()`) **is the original agent's measurement and could not be independently reproduced without a GPU** — it is internally consistent (49 calls, 392,754 indices = one full opaque pass) but rests on one measurement. Two-line fix: hook `SceneLoader.OnPluginActivatedObservable` next to `ensureGlTFLoader()` at `client/src/core/AssetRegistry.ts:32` and set `dontUseTransmissionHelper = true` on the `GLTFFileLoader` (confirmed present at `glTFFileLoader.js:188` in this Babylon build). Qualification: the pass runs on frames where the transmissive mesh is active, not literally every frame — but the plant sits at the arena origin, so that is most frames. Cleaner long-term fix is stripping the extension in the offline bake.
- **`noMipmap: true` on the skybox panorama** (`client/src/core/SceneBuilder.ts:450`). `content/skyboxes/lunar-crater.webp` is 4096×2048 (verified from the VP8X header) = 32.0 MiB RGBA8 from 83 kB on the wire; all three shipped panoramas are the same. `SceneBuilder` passes `undefined` for `noMipmap`, so the full chain generates: 42.7 MiB resident. The mip chain is ~10.7 MiB of that and is near-useless for an `infiniteDistance` backdrop sampled at roughly 1:1 minification. **Do not** use `lodLevel` — Babylon still allocates and uploads the full chain; `lodLevel` only biases sampling. And drop the "never sampled at more than a few hundred pixels" justification: at the low tier's own render resolution (`maxDevicePixelRatio 1.5` × `hardwareScalingMultiplier 1.33` → hardwareScalingLevel 0.887, ~950 px backbuffer in landscape) the visible ~85° of a 4096-wide equirect is ~960 texels. A 2048×1024 variant is a real visible quality cut; argue it on the memory budget if you want it. The live `getLoadedTexturesCache()` figures (17 textures / 88.3 MB / 117 MB with mips) are corroborated by static arithmetic, not re-measured.
- **Cache the canvas CSS size in `flightBinding`** (`client/src/main.ts:376-377`). `project()` reads `canvas.clientWidth`/`clientHeight` and is called from `FlightControls.ts:392,426,438,448` interleaved with style/`textContent`/`classList` writes in `EnemyArrows.ts:456-486`, forcing synchronous layout. Refresh from the ResizeObserver already installed at `main.ts:1526`, which already reads `canvas.clientWidth` at `:1533`. Same for `FloatingDamageText.ts:162-163`. **Three caveats.** (i) The `WHERE` list is incomplete: `FloatingDamageText.ts:197` also calls `binding.project(...)` per active damage slot, so the fix must cover that path or the read count barely drops. (ii) `project()` returns false when width ≤ 0, so a cache seeded lazily from the ResizeObserver (async, post-layout) will blank every HUD marker on the first frames of a match — seed it from the eager `engine.resize()` path at `main.ts:1537-1538`. (iii) **The numbers are internally inconsistent and could not be re-measured.** 0.351 ms/frame for canvas reads plus 0.282 ms/frame for the container read cannot coexist with "hud.update() costs 4.343 ms after a single style write" if the arrows write every frame. Treat **0.63 ms/frame** as the supported figure and drop the "3-5x on mobile → 12-19% of a phone frame" extrapolation entirely — that is a story, not a measurement.
- **Trim the SW precache.** The built `client/dist/sw.js` manifest holds 35 entries, 7,830,369 raw bytes, including `rajdhani-devanagari-{400,500,600}-normal-*.woff2` at 75,744 + 77,440 + 79,344 = **232,528 B** (69% of the entire woff2 payload) and `ConstellationApp-*.js` (35,088) + `.css` (24,242) = **59,330 B**. The CSS gives the Devanagari faces `unicode-range: U+0900-097F`, so the browser never requests them — workbox's `globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"]` downloads them anyway at install. `tools/bundle-budget.ts` classifies the Constellation chunk as "lazy (dynamic import)" and excludes it, which is true for page load and false for SW install. Fix: import subset-scoped fontsource entrypoints — **`latin-*` *and* `latin-ext-*`**, not `latin-*` alone, or accented display names lose the font — plus a workbox `globIgnores` for the Constellation chunks. Denominator correction: the gzip install is **2.07 MB**, not ~2.4 MB, so 249 kB gzip is 12.0% of it. And soften "bytes no player can ever use": an admin does use the Constellation chunk, and a registered player with Devanagari codepoints in their display name would legitimately hit that subset (no server-side charset regex on `displayName` was found).

### 3d. Two one-line type cleanups

- **Widen `heatSystemEnabled`** at `shared/src/sim/tuningDefaults.ts:20` to accept `TuningConfig | undefined`, returning `tuning?.featureFlags?.heatSystem === true`. That single change removes both `?? ({} as TuningConfig)` casts (`Notifications.ts:37`, `ModuleButtons.ts:212`) — the entire cast problem in this cluster. Do this separately from and before any `ConfigService` API change.
- The wider `getAll<TuningConfig>("tuning")[0]` idiom appears at **13** non-test sites (`ArenaSimulation.ts:331`, `BotDriver.ts:525`, `ArenaRoom.ts:223`, `main.ts:1288`, `:1296`, `NetGameSession.ts:480`, `EntityView.ts:326`, `:468`, `FlightControls.ts:609`, `:614`, `Notifications.ts:37`, `ModuleButtons.ts:212`, `SettingsScreen.ts:366`) — 16 if you count `shared/src/sim/testutil.ts`, which is a test helper. See section 4 for the accessor; it is not a safe win.

---

## 4. Moderate work — real refactors with named seams

### 4a. Extract `FlagView` out of `ViewManager`

**What moves:** `client/src/game/EntityView.ts` is 2,070 lines with `class ViewManager` at `:346-~1924` holding five structurally identical sync/create/dispose families plus a beam/FX subsystem. The flag family is the clean seam: `syncFlags:1164` + `createFlagView:1236` (through ~1355) plus free functions `disposeFlagView:1931`, `createFlagBanner:1954`, `updateFlagBanner:1989`, `writeFlagBanner:2001` — ~280 lines. Verified coupling: lines 1164-1355 reference only `this.scene`, `this.flags`, `this.createFlagView`, `this.quality`, `this.root`, `this.beaconClockMs`, `this.sTrail`, `this.sTrailVectors`, and the last three (declared `:377,:379,:380`) are used **nowhere else in the file**, so they move cleanly. `this.root` is shared by every family and must be passed in, not moved.

**New interface:** `createFlagViews(scene, configs, quality, root): { sync(cur, frameDtMs): void; dispose(): void }`. **Drop `playerTeam` from the signature** — the flag path never reads it (`this.playerTeam` appears only at `:375, :913, :983, :1150`, all ship-side). `ViewManager` keeps a field and one `this.flags.sync(cur, dt)` line in `render()` (`:873`).

**Protection:** `client/src/game/EntityView.flagBeacon.test.ts` — 9 tests that build a `ViewManager` on a `NullEngine` and drive `render()` with flags-only snapshots, asserting banner geometry, pose, beacon shells, culling and disposal. It passes verbatim across the extraction. There are five `EntityView.*.test.ts` files in total (deathExplosion, flagBeacon, missile, moduleMount, sparks). **Verify:** the flagBeacon suite green, unchanged. No sim code moves.

Afterwards the projectile/FX families are the same treatment, protected by `EntityView.missile.test.ts` (9) and `.sparks.test.ts` (16).

### 4b. Extract replication into `server/src/rooms/state/replicate.ts`

**What moves:** `writeState`, `syncShipState`, `applyShipSnapshot` (`ArenaRoom.ts:842-1013`, ~170 lines) become `applySnapshot(state, snap, keyOf, asteroidTags)`. The body touches no `Client`, no timer, no `this.clock` — only `this.state`, `this.entityToKey`, `this.sim.world.asteroids`, `this.asteroidEntityIds`. **One correction to the plan:** lines 842-1015 also call `this.sim.snapshot()` three times (`:843`, `:933`, and the join path), so those must be hoisted to the caller as part of the move — see 4c and section 6.

**Then add the test that makes drift fail CI:** a client-project test importing `ArenaState` + `applySnapshot` + the decoder, asserting `decode(applySnapshot(simSnapshot))` matches the sim snapshot field-for-field.

**Protection:** the 39 tests in `server/src/rooms/ArenaRoom.test.ts` exercise the encode path end to end (`:994` backfill, `:1143` human-full start, `:1290` telemetry counts).

Also add, in the same pass, the CTF/decoy integration gap: `grep` for flags/decoys/teamScores/carrier across the 1,356 lines of `ArenaRoom.test.ts` returns one unrelated hit at `:1032`, and `e2e/smoke.spec.ts` has zero. The `@colyseus/testing` rig is already present — play `gamemode.practice-ctf-5v5` until a `flagCaptured`, then feed the real `room.state` through the client's `decodeFlags`/`decodeDecoys`/`decodeTeamScores`. That kills the literal-shaped fixtures. (For accuracy: there is no 10v10 CTF mode; `content/gamemodes/` contains only `practice-ctf-5v5.json`.)

### 4c. Hoist the redundant server snapshot

Two independent lenses found this, which is worth noting. `ArenaRoom.ts:763` calls `writeState()`, whose first statement at `:843` is `this.sim.snapshot()`; `:764` immediately takes another. The only sim access in between is a read at `:920`; everything else writes into `this.state`. `ArenaSimulation.snapshot()` (`:779-897`) is pure. So `:843` and `:764` are two full rebuilds of identical post-tick state. (`:602` in `driveBots` is genuinely pre-tick and must stay.)

**Fix:** `const snap = this.sim.snapshot();` after `this.sim.tick(FIXED_DT)`, passed into `writeState(snap)` and the matchTimer/teamScores block. Measured cost of the removed call: 13.8-25.6 µs and ~54 KB per room-tick on deep-field (the two lenses measured 0.0175 and 0.0216 ms independently — the absolutes reproduce; the "6-11% of a tick" *ratio* does **not**, one verifier getting 22-35% with a cheaper harness, so quote the absolutes). `tools/loadtest.ts:192` forces `defaultArena "arena.deep-field"` and `package.json` runs `--rooms 20`, so the 20-room framing is legitimate.

**Two things NOT to do here** — see section 6: reusing `AsteroidSnapshot` objects, and hoisting the `syncShipState` snapshot out of the spawn loop.

### 4d. `createBotDriver` — one wiring, six call sites

Six `new BotDriver({...})` sites. Three production sites (`GameSession.ts:269`, `:407`, `ArenaRoom.ts:563`) plus `bot-ctf-review.ts:134` pass an identical 8-field block; the formula `Math.max(ship.collider.radius, (ship.render.modelScale ?? ship.collider.radius * 2) / 2)` is duplicated five times (`GameSession.ts:280`, `:418`, `ArenaRoom.ts:574`, `bot-ctf-review.ts:142`, `CtfBots.test.ts:379`). But `tools/match-tracker.ts:123` passes only `{entityId, profile, configs, rng}` — no `arenaBounds`, `floorY`, `staticWorld`, `navRoute`, `visualRadius` — and `tools/bot-behavior-audit.ts:180-187` passes `arenaBounds`+`floorY` only, with raw `ship.render.modelScale`. `staticWorld`/`navRoute` gate line-of-sight and route planning at `BotDriver.ts:981, 995, 1043-1044, 1053`.

**Measured on `arena.lunar-rift`** (129 propPlacements + navGraph — the correct arena; the original finding measured `lunar-crater`, which has zero props and no navGraph, so nothing about terrain awareness could be measured there, and `docs/bots/behavior-map.md:166` naming lunar-crater is a stale doc). 90 s, 5v5, same seed and roster: full vs match-tracker wiring gives kills 23/19, 20/17, 21/13 and distance +20%/+17%/+44% for seeds 3/11/29. `staticWorld`+`navRoute` alone gives kills 11/19, 22/17, 21/13, and flips captures 1 vs 0 on seed 29.

**New interface:** `createBotDriver(world: World, entityId, profile, ship, rng): BotDriver` in `shared/src/bots/`. **Take `World`, not `ArenaSimulation`** — `shared/src/sim/World.ts:24` already imports `NavRoute` from `shared/src/bots`, so an `ArenaSimulation` parameter closes a bots→sim→bots cycle. Preserve the deliberate `bounds.shape === "sphere"` guard on `floorY`.

**Who's affected:** the balance pipeline (`match-tracker` → `balance-report` → `docs/Balancing.md`) and the audit tables at `docs/bots/behavior-map.md:252,292`. **Not** `npm run telemetry:report`, which is a read-only SQLite reporter over `server/src/db/repos.js` and never constructs a sim. There are no committed baselines to re-record (`.balance*/` is gitignored); the docs tables go stale and should be regenerated.

**Determinism:** production option values are byte-identical, so the live sim stream is untouched. **Protection:** `BotIntegration.test.ts`, `CtfBots.test.ts`, `floorAvoidance.test.ts` all exercise the full-option driver directly.

### 4e. Preload what an asteroid arena actually renders

`arenaModelRenders` (`client/src/core/assetPreload.ts:32-50`) only emits a job when an asteroid config declares `render.model`. All 14 `content/asteroids/*.json` set `shape` and none declares `render.model`, on the top-level render or any `states[].render`. Per-arena: broken-halo 52 placements / 0 models, deep-field 148 / 0, lunar-crater 82 / 0, ring-nebula 46 / 0, twin-titans 41 / 0. So on every asteroid arena the arena half of the preload is empty while the launch screen reports 100%.

The rocks come from `getShapedAsteroidMaster` (`AssetRegistry.ts:978`), called **synchronously** from `EntityView.createAsteroidView:1357` on the first `render()`. `buildRockMaterial` (`rockMesh.ts:335`) issues 4 `new Texture` per set, then `applyRockRelief` runs `composeSurface` for *every* relief mode — `rockMesh.ts:383` says so outright ("Every mode gets the composited normal map"), so "off" does not skip it. `composeSurface` (`:503`) decodes 2 more JPEGs, runs two passes over 1,048,576 pixels each, and uploads a 4 MB `RawTexture`. Across 4 texture sets: ~8.4 M iterations, 8 `getImageData` 4 MB copies, 16 MB of uploads, on the main thread, on the first gameplay frame. The 16 JPEGs sum to exactly **3,381,397 bytes**, all confirmed 1024×1024 from their SOF markers.

**Correction to the framing:** the 3.38 MB is a **cold-cache** cost. `client/vite.config.ts:329-335` gives `/content/**.(glb|…|webp|…)` a StaleWhileRevalidate runtime cache, so a returning player serves those from the SW. The decode + composite + upload stall survives regardless — but it is once per **page load**, not per match (caches are keyed by `Scene`, there is one Scene for the app's lifetime at `main.ts:291`, and `AssetRegistry.dispose` at `:1207-1210` does not force-dispose textures). Minor per-match residue: `composeSurface` deletes and disposes the plain `_nor` entry at `rockMesh.ts:563-569`, so 4 `_nor` textures are re-created each match.

**Fix:** add a third job group walking `arena.asteroidPlacements` → configs → distinct `render.surface.textureSet`, and count it in the progress total so the bar tells the truth. `rockTexture`/`surfaceTexture` are module-private, so export a small `preloadRockSurfaces(scene, baseUrl, sets)` helper. `main.ts:317` builds `preloadAssets` on the same `Scene` the ViewManager's `AssetRegistry` uses (`main.ts:430` → `EntityView.ts:461`), and the caches are `WeakMap`s keyed by `Scene`, so the in-match calls really do become cache hits. **Do not oversell it:** this does not remove the synchronous `buildRockGeometry` tessellation on the first frame. Optionally move `composeSurface`'s pixel loops to a Worker + OffscreenCanvas — no sim contact.

### 4f. Cap preload concurrency

`client/src/core/assetPreload.ts:137-143` is a flat `await Promise.all(jobs.map(...))` with no gate. Job list for `arena.lunar-rift`, reproduced from content: 129 propPlacements → **40 distinct prop GLBs = 14,002,424 B**, plus 10 ship GLBs = 6,495,676 B, plus the `preloadShipModels` job = **51 jobs / 50 imports / 20,498,100 B**, all started in one microtask. Add ~1.47 MB of externally-referenced prop textures the loader fetches on top. `AssetRegistry.ensureModel` (`:657-705`) memoizes but does not queue, and `ensureGlTFLoader` is one dynamic import all 50 await then release together. `shared/src/core/ConfigService.ts:44-52` caps its own 170-file load at 12 with a comment naming exactly this hazard; `client/src/core/modelLoadQueue.ts` is a working throttle already used by Hangar/Shop.

**Fix:** run the job list at bounded width (6-8 for binaries), arena/terrain ahead of ship hulls. **Accuracy notes:** the unpacked-memory argument applies to the 40 prop GLBs (embedded textures by URI); the 6.5 MB of hulls is already raw uncompressed vertex data with no Draco/meshopt. And because binaries are on SWR, this is a cold-install / first-launch burst, not a per-boot one.

### 4g. Two-phase ship-hull preload

`shipModelRenders` (`assetPreload.ts:70-82`) walks `configs.getAll('ship')` unconditionally: human_light (lod0-3), human_medium (lod0-2), human_heavy (lod0-2) = 10 GLBs = **6,495,676 B**, light alone 4,269,340. On every non-lunar-rift arena that is 100% of what the launch screen downloads — for a `duel-1v1` (which defaults to `arena.deep-field`) fielding at most two hulls. The flow already knows the roster in time: `waitForMatchStart` (`main.ts:1141`) resolves the full roster before `prepareSessionArena` at `:1151`.

**State the win as latency, not bytes** — the fix keeps speculatively downloading all 10, it just stops *blocking* on 8. **Gate on the fallback hazard:** `AssetRegistry.getShipMaster` (`:912-916`) returns the procedural recipe when the GLB is absent, and `EntityView.ts:998` resolves the master once per view and keeps it for the view's lifetime. Any hull appearing after the blocking phase — late joiner, server-spawned bot, hull swap — would render as its procedural stand-in permanently. Either cover those in the blocking set or add a view-rebuild hook when a master lands.

### 4h. Defer `authService.restore()` off the boot critical path

`main.ts:194` starts `serverHealth.refresh()` unawaited (awaited at `:991`) with a comment explaining the pattern. `main.ts:198` breaks it with `await authService.restore()`. `restore()` (`AuthService.ts:94-118`) calls `me()`; `request()` (`:283-300`) retries through `tryRefresh` on a 401, and `ACCESS_TTL_S = 15*60` (`server/src/auth/tokens.ts:7`), so **me → refresh → me** is the normal returning-player case. Everything from engine creation at `:254` onward is blocked behind it. A first-ever visitor short-circuits with no fetch, which is why a fresh-profile test never sees it.

**The fix needs three call sites moved, which the original missed.** Between `:198` and `:1006`, three sites read auth state synchronously and would silently change behaviour: `main.ts:981` (`?editor` deep link, `getState().status === "authed"`, no `onChange` subscription — the admin link would stop working); `main.ts:205-207` (the documented guard dropping a restored dev-admin session on a LAN hostname — would see "anonymous" and not fire, re-opening the identity collapse its comment describes); `main.ts:221-225` (dev-login gate that then **awaits** `devLogin()` — would fire spuriously and race the in-flight restore over the same token storage). Move all three behind `await authRestored`. The self-healing consumers the finding did check are fine: `installDesignToolsEntry` (`:961-980`) re-runs on `authService.onChange`, and `createSessionOwnership` (`main.ts:730`) swaps its ledger on auth change (`sessionOwnership.ts:46-58`). Note that in DEV on localhost the `devLogin()` await keeps boot serialized regardless — the win is only observable in a production-mode profile with stored tokens.

### 4i. Cache the `World` id accessors

`shared/src/sim/World.ts:179-198`: five accessors, each `Array.from(map.keys()).sort((a,b) => a-b)` with no caching, called ~26/tick on deep-field and ~30/tick on lunar-rift CTF. **Halve the original claim:** warm per-call costs are `shipIds(10)` 0.234 µs and `asteroidIds(148)` 2.57 µs, while `decoyIds`/`projectileIds`/`flagIds` over the empty maps they actually have in play are 0.025-0.035 µs — so the ~13 `decoyIds` calls that make up half the count contribute ~0.5 µs total. In-sim total is **~5.6 µs and ~17 KB per tick**, not 11-13 µs.

**Fix is provably complete:** membership changes only at `spawn.ts:87/186/247`, `JettisonSystem.ts:107`, `ArenaSimulation.ts:372` (each immediately after a `createEntity`/`restoreEntity`) and removal only in `World.destroyEntity` (`:130-145`). Nothing in `client/`, `server/` or `tools/` writes those maps. Cache-and-invalidate in `createEntity`/`restoreEntity`/`destroyEntity`. **The accessor must return a copy, not a frozen shared array** — `CleanupSystem` iterates `projectileIds()` while calling `destroyEntity`. A slice of 10 costs 0.019 µs, so it still pays. A/B against the golden fingerprint.

### 4j. `configs.tuning()`

Add `tuning(): TuningConfig` to `shared/src/core/ConfigService.ts` returning the sole tuning config, with the exactly-one check in `tools/validate-content.ts` / pack load. `content/manifest.json` ships one `tuning/default.json` and nothing enforces that today. **Two caveats:** (a) the runtime accessor should return the sole config or a frozen default, **not throw** — `client/src/net/NetGameSession.test.ts:126-130` builds `{ get } as unknown as ConfigService` with no `getAll` at all, so any converted call site those tests reach would throw "not a function"; (b) `client/src/editor/TuningPanel.ts:100` iterates `getAll<TuningConfig>("tuning")` as a collection and must keep the array API. Sim-side callers exist (`ArenaSimulation.ts:331`, `BotDriver.ts:525`), so the throw-vs-default decision belongs at pack load, never mid-tick. Read-path only; no determinism exposure.

### 4k. Ship LOD bias — do it, but size it correctly

`client/src/core/assetPreload.ts:102` is `applyModelLods(master, ship.render.lods ?? [])` with no third argument, while `SceneBuilder.ts:833` passes `(placement.scale ?? 1) * (this.quality.scene.terrain?.lodBias ?? 1)`. `AssetRegistry.ts:846-849` confirms the `distScale = 1` default and `:889` `base.addLODLevel(lod.distance * distScale, variant)`. Ladders are correct (interceptor 40/90/180, brawler and support 40/90); `human_light_lod0.glb` parses to 44,271 tris and lod1 to 22,029. Asteroids get tier-driven LOD distances and props get `terrain.lodBias`, so ships really are the only ladder with no tier bias. `shipLodGeometry.test.ts` asserts only monotonic distances and a triangle ceiling — a runtime `distScale` touches neither.

**But the impact argument does not hold and the win is small.** The local player's ship can never benefit: `EntityView.ts:1000` does `if (s.id === this.localPlayerId) pinInstanceLod0(node)`, and `client/src/core/modelLod.ts` pins that instance to the base master deliberately. And the in-match view is the chase rig (`main.ts:502`, FLIGHT.md §3) with `chase.radius 12` (×0.7 landscapeRadiusScale = 8.4) — not the tactical rig, whose own default 55 is already past the 40u threshold. At radius 12 even a 0.55-biased 22u threshold still selects LOD0. **The real win is confined to remote ships in the 22-40u band.** Also add the caveat the finding omits: LODs are applied once at preload, so after an in-match auto-tier demote the biased distances are stale unless `preloadShipModels` re-runs or `applyModelLods` is re-applied on `setTier`. The "every ship instance resolved to LOD0" observation could not be reproduced and reads like a spawn/scrum frame.

### 4l. Author an LOD1 for `prop.lunar-rift-he3-plant`

`content/props/lunar-rift-he3-plant.glb` is exactly 8,127,396 bytes: 7 materials, 6 embedded 1024×1024 PNGs, 19,046 triangles (not the 17,256 originally claimed — the ablation's own 57,138-index delta proves 19,046). Five materials share one texture set, giving the 15 `scene.textures` entries over 6 distinct internal textures ≈ 24 MB. Against a lunar-rift model download of ~27.2 MB it is 24-30% of the bytes.

**The correct fix is an authored LOD1.** This render block authors **no `lods` at all** (render is just recipe + model) while every other heavy prop in the arena ships `_lod1` GLBs. An LOD1 keeps the collider and the silhouette. Requantify the texture story if you re-bake: the two AO maps are only 109,696 + 96,612 = 206 kB (2.5% of the file) — dropping AO is a texture-memory win (~8 MB), not a download win. The download is dominated by two normal maps (4.16 MB, 51%) and two base colours (2.67 MB).

**Do not** widen the quality gate to skip it — see section 6.

### 4m. Dedupe terrain chunk textures in the bake

All 16 `lunar-rift-chunk-N.glb` and 16 `_lod1.glb` name the identical six `textures/game/*.jpg` URIs — 192 references for 6 unique images, and all 32 are preloaded (`arenaModelRenders` adds `render.model` and every `lods[].model`). The vendored loader's `loadImageAsync` → `loadUriAsync` → `_loadFile` fetches per loader instance with no cross-file dedupe. VRAM is fine — `_uniqueRootUrl` is the plain rootUrl (`glTFLoader.js:298`) so all 32 hit the same engine cache key.

**The impact is understated, and the easy half of the fix does not work.** Commit b3167d0 moved `/content` binaries to StaleWhileRevalidate (`client/vite.config.ts:330`), and workbox SWR fires a background revalidation on **every** request — so those 192 requests are ~192 network revalidations for 6 files even on a warm load. That also kills the "prefetch the six URLs first" option: prefetching warms the cache but does not collapse 32 later fetches. **The fix that works** is bake-side (emit the shared material set once, or embed the six images in one GLB the rest reference), or a URL-keyed image-buffer cache in `AssetRegistry` ahead of `SceneLoader.ImportMeshAsync`. Chunk geometry (3.3 MiB LOD0 + 2.2 MiB LOD1) is fine — frustum culling and `terrain.lodBias: 0.55` are both working, and terrain is 24.6% of the frame against ships at 63%. **Do not reopen the seams to shrink it.**

### 4n. Invert the design-system CSS contract test, then delete

`client/src/game/designSystemContract.test.ts:26-45` asserts `expect(css).toContain(selector)` for 25 class selectors. **15 of the 25** are never applied to any element anywhere in the repo (the original said 16; `hud-button--primary` **is** applied — `ResultsOverlay.ts:378` builds `hud-button--${variant === "primary" ? "primary" : "secondary"}`). Across both style files the ratio is ~32 dead of 283 class tokens (~11%), not 16 of 174.

**Scope this correctly.** The four sibling files (`hudOverflow.test.ts` 32 assertions / 8 its, `ResultsOverlay.test.ts` 20/7, `Scoreboard.test.ts` 9/8, `twoLayerStyle.test.ts` 5/2) do **not** share this failure mode — they assert CSS for classes that are genuinely applied; their limitation is that jsdom cannot lay them out, which `hudOverflow.test.ts:5-11` discloses in its own header. Drop the "~95 assertions on dead CSS, 16x the scale" framing.

**Fix:** invert the direction — extract the class-selector set from the injected stylesheet and assert each is applied by some client source file. **The allow-list must cover template-literal composition**, not just pseudo-state/media variants: `hud-button--*`, `sa-button--*`, `hud-results-btn--*`, `sa-screen-btn--*`, `hud-scoreboard-team--*` (`Scoreboard.ts:88`), `hud-enemy-arrow` and `hud-toast`/`hud-damage-number` modifiers, `state-deploying`/`state-retracting`. Otherwise the new test fails on day one against live CSS. Write the test first; then delete or wire the dead selectors.

### 4o. Give the Hangar screen a unit test

`client/src/game/screens/Hangar.ts` is 2,495 lines — the largest source file in the repo — with `class Hangar` at `:204-1961` (~1,757 lines, ~69 methods). Responsibility clusters, by method boundary: 3D preview stage ~312 lines / 15 methods (`buildStageArrow:416`, `mountLoadingOverlay:614`, `revealAfterPriorityLoad:624`, `rebuildPreview:692`, `rebuildBay:790`, `lockedShipMaterial:801`, `applyStageViewport:818`, `statsBandPx:833`, `syncStageBand:844`, `frameShip:857`, `tickPreview:874`, `resetIdlePreview:896`, `tickSwap:949`, `setPreviewVisibility:980`, `setArrowsEnabled:985`); DOM build/render 557 lines / 16 methods (`render:1459` plus twelve `build*`); loadout state 223 lines; commerce + server IO 216 lines / 9 methods, 8 async (`refreshFromServer:650`, `setAsMain:994` (sync), `buyShip:1003`, `buyModule:1068`, `upgradeTrack:1102`, `saveFitting:1119`, `deleteFitting:1161`, `chooseSkin:1591`).

**Coverage, stated accurately:** `client/src/game/hangarLoadout.test.ts:9` **does** import `loadHangarSelection` from `screens/Hangar.js` and covers it in 12 `it`s — but that reaches only ~60 lines of module-level storage helpers (`Hangar.ts:129-190`). The class itself is exercised solely by `e2e/smoke.spec.ts:105-218` (buy → set as main → equip → save → close). `e2e/hangar-shot.spec.ts` is not a second gate: it is `@hudshot`-tagged and excluded by `playwright.config.ts:63 grepInvert`. That smoke is the slowest and most retry-prone gate — `.github/workflows/ci.yml:92` gives the job `timeout-minutes: 20`, `playwright.config.ts` sets `retries: CI ? 1 : 0`, `workers: 1`, and forces the ANGLE/SwiftShader software rasterizer.

Context: `client/src/game/screens` is the thinnest-covered area outside `tools/` at a **0.13** test:src line ratio (6,802 src lines / 904 test lines, 50 `it`s and 151 expects across 13 modules), against `shared/src/core` 1.92, `shared/src/sim` 1.23, `shared/src/bots` 1.03, `client/src/net` 0.79, `client/src/core` 0.70, `server/src` 0.63, `client/src/game/hud` 0.51, `client/src/editor` 0.31, `tools` 0.00. (File-name matching understates coverage in this repo, which names tests by aspect — `EntityView.ts` has five aspect-named test files and `shared/src/sim/systems/*.ts` are covered by `Combat`/`Ctf`/`Targeting`/`Jettison`/`EnergySystem`/`ModuleSystem`/`NavigationFlight`/`NavigationLos` tests. Each of those was verified by reference before counting.)

**Do this now:** happy-DOM tests for the state machine (rail switching, slot selection, equip/remove, dirty-then-save) using the existing `__fixtures__` fakes.

**Then, separately:** the `HangarStage` extraction (`showShip`/`swapTo`/`tick`/`setViewport`/`setVisible`/`dispose`, taking the 15 stage methods plus the free `idleSnapshot` at `:1963`) and `HangarCommerce` (the 9 commerce methods, already backed by `HangarApi.test.ts` and `hangarGating.test.ts`). The stage seam is thinly protected today (`hangarLayout.test.ts` covers `stageAspect`), so it must land with a `NullEngine` test modelled on `EntityView.flagBeacon.test.ts`, which proves the pattern works for Babylon code in this repo. Judge that extraction on its own merits — it is a real client refactor, not a free rider on the test-gap finding.

---

## 5. Risky work

### 5a. Static/dynamic split of the spatial hash — determinism-critical

`ArenaSimulation.ts:496-508` clears and re-inserts every asteroid then every ship each tick. Asteroid transforms are provably immutable: `spawn.ts:86` gives zero velocity, no system integrates them, and 0 of 148 deep-field positions changed over 300 ticks. The only `pos.x/y/z =` writes in `shared/src/sim` are `ProjectileSystem.ts:66-68` and `CtfSystem.ts:48-50/119-121/178-180` — none touch an asteroid (rocks tumble via the closed-form `rockPose`, rotation-only, irrelevant to a bounding-sphere hash). Bucket geometry is exact: 302 cells, 525 pushes, cellSize 16 (`content/tuning/default.json:29`).

**Cost, corrected:** ~29 µs and 87.3 KB per tick on deep-field (the finding's own two numbers contradicted each other — the isolated bench said 72 µs, warm re-measurement says 28-30 µs, which happens to make the CPU-profile figure of ~26 µs the right one). That is ~25% of a warm deep-field sim tick and ~52 MB/s of garbage at 20 rooms × 30 Hz on the loadtest config. **Size it against the loadtest and duel-1v1, not live 5v5:** shipped 5v5 modes default to ring-nebula (8.50 µs) or lunar-rift (0.11 µs). `tools/loadtest.ts:192` hardcodes `arena.deep-field` (its comment saying "47 asteroids" is stale — it is 148). No "150-rock target in the brief" exists anywhere in docs.

**THE HAZARD.** `spatialHash.ts:5-8` documents that "cells and returned ids are iterated in insertion/id order", and today every bucket holds asteroids (ascending id) before ships (ascending id) because of the insert order at `ArenaSimulation.ts:498-507`. That order is load-bearing: `CollisionSystem.ts:46-65` mutates `st.pos` **inside** the candidate loop, so each contact resolves against a position earlier contacts moved; `ProjectileSystem.ts:270` and `CombatSystem.ts:299` select nearest with strict `<`, so exact ties fall to whichever candidate came first.

**Sequencing that makes it survivable:**
1. Land the golden fingerprint (2a) and the query-order test (2b) first. Non-negotiable.
2. Land the `queryAABB` allocation fix **alone**: replace the per-call `Set` with a generation-stamped `Int32Array` visited marker and a reusable out array. `nextId` grows only ~0.4/tick (176 after 463 ticks), so the array stays small. This does not change order. Verify fingerprint.
3. Only then split the layers, and have `queryAABB` walk **cell by cell, emitting the static bucket then the dynamic bucket** — never layer-major. A layer-major walk changes sim results.
4. Gate on a bit-identical replay of the regression fixtures plus the new fingerprint.

### 5b. Deleting drifted wire fields — needs a protocol bump

Five `@type` fields are unread by the client: `PlayerState.vx` and `.vz` (`ArenaState.ts:103-104`, declared int16, zero writers and zero readers anywhere), `PlayerState.connected` (the client filters on `alive` via `isReplicatedPlayerAlive` at `NetGameSession.ts:980`), `AsteroidState.hp` (written at `ArenaRoom.ts:928`, client reads only `.destroyed` at `NetGameSession.ts:939`), and `lastProcessedSeq` (written at `:663`, never decoded — reconciliation goes through `this.ack(client, seq, true)` at `:664`).

`vx`/`vz` are the interesting one: they are exactly the field the client works around. `NetGameSession.ts:410` comments that "`ShipSnapshot` carries no velocity, so it is differenced from replicated positions", and `trackServerVelocity` at `:717` does that differencing — while the schema declares a 2D subset of the very thing (no `vy` for the 3D bubble). Either wire them and drop `trackServerVelocity`, or delete them; do not leave the trap.

**Hazard:** `shared/src/constants.ts:20` sets `PROTOCOL_VERSION = 6` with the comment "bump on any breaking message/schema change", and `shared/src/content/pack.ts` validates bundles against it (`pack.test.ts:129`). Removing schema fields is exactly that change and requires a version bump plus a content-pack re-export. **This is not a safe deletion.** Sequence: 2c (field-name contract) → 4b (replicate.ts + round-trip test) → this, as one deliberate commit with the bump.

### 5c. Roster parity — the three-line fix, not the refactor

Client (`GameSession.ts:212-294`) reads all of `ResolvedBotSlot{profile, shipId, fitting}`; server (`ArenaRoom.ts:528`) reads only `.profile` and always sources the hull from `backfill.shipId` at `:529-531`, discarding `slot.ship` and `slot.fitting` even though `gamemodeSchema` accepts both (`shared/src/schemas/gamemode.ts:40`). `practice-bots.json` and `practice-bots-1v1.json` already author `ship: "ship.interceptor"` on slots and are silently ignored online — harmless today only because they equal `defaultShip`. All 6 non-tutorial gamemodes are `launch: "online"`, including all 5 roster-bearing ones, so `ArenaRoom` really does serve authored-roster modes. (Note `docs/audits/2026-08-07-code-audit.md:92`, which claims roster-bearing modes are offline-only, is now stale.)

**Do:** ~3 lines at `ArenaRoom.ts:528-534` — prefer the matched roster slot's `shipId`/`fitting` when it supplies one. This changes no RNG draws and needs no re-baselining. **Do not** do the `planRoster` refactor — see section 6.

### 5d. A content-pack size gate — as a warning, with an exception list

Two independent lenses found orphaned binaries and got different totals because they swept differently. Lens A: 14 files, **16,716,649 B** (15.94 MB), 30.0% of a 55,796,728 B pack — the 7 model/skybox files plus 6 hashed rock textures, 4 of which are md5-identical to a live sibling. Lens B, sweeping every `model`/`texture` string transitively through GLB `images[].uri`: 29 unreachable binaries, **19,708,101 B** (18.8 MiB), including 21 prop textures with 8 exact-duplicate pairs (2.23 MiB of identical bytes). Both are honest about scope: the SW `globPatterns` exclude `.glb`/`.jpg`, so **no player downloads these** — it is repo, Docker image and Pages-artifact weight. Shipping paths: `.github/workflows/deploy-pages.yml:51 cp -r content client/dist/content` and the Dockerfile `COPY content` at builder and runtime. `tools/bundle-budget.ts` scans only `client/dist/assets`, so the pack has never been under any gate.

**The reachability caveat both verifiers found is the load-bearing one.** `client/vite.config.ts:77-96` serves `/__editor/list-models` by recursively walking `CONTENT_DIR` for every `.glb`/`.gltf`, and `client/src/editor/ShipManager.ts:239` fetches it to populate the Ship tool's model picker. `HShip01`/`MShip01`/`LShip01` and the four asteroid GLBs are precisely the author-selectable library that endpoint exists to expose. Deleting them silently shrinks the picker. `docs/HANDOFF-2026-07-27.md` records MShip01→interceptor and LShip01→support, both since replaced by the `human_*` LOD chains, so retiring them is defensible — but the framing is "retire superseded source art", not "nothing can see this".

**Sequencing:**
1. Delete the unambiguous waste first: the 21 unreferenced prop textures, starting with the 8 exact md5 duplicates. Nothing enumerates those.
2. Update `AssetRegistry.test.ts:36,290,198,330` and `assetPreload.test.ts:25,30` to use an obviously-synthetic path (`fixtures/model.glb`) so the stubs stop reading as references. Note `content/asteroids/*.json` carry only `"recipe": "procedural.*"` with zero `"model"` keys — `git show 8c2a735` deleted those keys in the "Give asteroids real shapes" commit.
3. Move the GLB library under an explicit `content/library/` the sweep skips, or leave it and document why.
4. Add the sweep to `tools/validate-content.ts` (which already walks every config) or `bundle-budget.ts`: collect every `render.model`, `lods[].model`, `skybox.texture`, follow each GLB's `images[].uri`, plus the `rockMesh.ts:31,345-356` `<set>_{diff,nor,rough,ao}_1k.jpg` convention over the 4-value enum at `shared/src/schemas/asteroid.ts`. **Emit a WARNING with a declared exception list, never a hard fail** — "fail on any unreferenced binary" turns the editor's "park new art in `content/` and pick it" workflow into a red CI run.

Also decide `arena.broken-halo` and `arena.lunar-crater` deliberately. Neither is named by any gamemode's `defaultArena` (the seven shipped modes use deep-field ×1, ring-nebula ×4, lunar-rift ×1, twin-titans ×1); both are reachable only through the F10 MapEditor (`client/src/editor/MapEditor.ts:95`) or an explicit `options.arena` join override (`ArenaRoom.ts:218`). The original finding's exculpation of lunar-crater was wrong — `tools/bot-behavior-audit.ts:114` and `tools/bot-ctf-review.ts:74` both resolve `practice-ctf-5v5`'s `defaultArena`, which is `arena.lunar-rift`. broken-halo's 52 placements are pinned by `shippedArenaGeometry.test.ts:35` and `shippedPresentation.test.ts:79,105` and validated on every `validate:content`, so it is fully maintained while unreachable. lunar-crater is *more* exercised (`CtfBots.test.ts:132,323,537,556`; `floorAvoidance.test.ts:20,68,91`; `BotIntegration.test.ts:654`). Either give them a gamemode or move them to an explicitly-labelled unshipped set. Cosmetic priority; `broken-halo` was already flagged in `docs/audits/2026-08-07-design-gameplay-audit.md:180`.

### 5e. `quality.asteroids.thinInstances` — decide, do not leave

`shared/src/schemas/quality.ts:132` declares it and **nothing reads it**: every occurrence is a declaration or an object-literal assignment; there is no `.thinInstances` property read anywhere, and `rockMesh.ts`/`SceneBuilder.ts` never mention it. `ultra.json:38` sets it `true`, claiming a rendering strategy that does not exist.

**The real defect is not the dead knob — it is that the comment is false.** `quality.ts:126-131` documents a genuine measurement: "10 asteroids across 2 masters already batch to 2 draw calls as InstancedMesh, so this buys ~0 there — kept as data so denser arenas can turn it on without a code change." The measurement is sound; the promise is not, because no consumer exists, so a denser arena **cannot** turn it on without a code change. Either implement the read (making the comment true) or delete the field. Deletion touches ~16 sites, including two **non-test shipped defaults** at `client/src/game/EntityView.ts:314` and `client/src/core/QualityManager.ts:336` — not just four content files and five fixtures. Reported a week earlier at `docs/audits/2026-08-07-code-audit.md:228`.

---

## 6. Explicitly not worth doing

Recorded so nobody re-litigates them.

- **`featureFlags.heatSystem` and its retained code.** Deliberately off, deliberately kept — see `docs/heat-system.md`.
- **`ConfigService.get` inside per-entity loops.** Measured: 10.7 ns tuning, 17.0 ns module (two Map hops), `world.tuning` resolving 74-76×/tick for under 1 µs total. The documented hot-reload behaviour is worth more than the nanoseconds.
- **The asteroid radial-field early-out.** All three sim entry points already reject on a bounding sphere. The only unguarded path was the bots' snapshot-side probe, which is 3b.
- **Shrinking terrain chunk geometry to chase frame cost.** Measured at 24.6% of the frame against ships at 63%, with culling and `lodBias 0.55` both working. Do not reopen the seams.
- **The `planRoster` refactor.** It moves RNG draws **and** makes the server start honouring authored hulls/fittings — i.e. it changes live online opposition — to close a divergence nothing can currently observe. `main.ts:1183` says "identical mode and arena, bot-filled teams"; it never claims an identical roster, and mode and arena *are* identical. The fallback constructs `GameSession` with `Date.now() >>> 0` as the seed (`main.ts:1208`), so client and server never share a seed and no shipped flow compares them. Take the 3-line fix in 5c instead.
- **Reusing `AsteroidSnapshot` objects across ticks.** It turns `Snapshot` from a value into shared mutable state, and `driveBots` (`ArenaRoom.ts:602-611`) hands snapshots to bot drivers. Any retaining consumer would silently observe it change underneath. Ship the hoist (4c) alone.
- **Hoisting the `syncShipState` snapshot out of the spawn loop.** `syncShipState` is called at `ArenaRoom.ts:577` **inside** the loop, one iteration after each `spawnPlayer` at `:539`. A snapshot hoisted above the loop predates ships spawned later in it, so `snap.ships.find(...)` returns undefined for every bot after the first and their `PlayerState` never gets its initial full write. It would likely still pass the tests (the next tick repopulates), which makes it a silent one-tick behaviour change rather than a caught bug. If that site is worth optimising, restructure to take one snapshot *after* the whole loop and apply it to collected `(entityId, ps)` pairs.
- **Skipping `prop.lunar-rift-he3-plant` on a low quality tier.** It is placed at the arena **origin**, `{x:0, y:-8.75, z:0}`, scale 1.5, in a 768×768 CTF map — the mid-map centrepiece, not background. It carries a 2,188-triangle collision mesh (bounds 43.2 × 19.2 × 22.4 before scale) and `impactDamage 12`, and `shared/src/sim/World.ts:97` builds `StaticWorld` from `arena.propPlacements` for **every** prop regardless of any client quality setting. Letting a tier skip its render produces an invisible, damaging 65-unit wall at the centre of the contested lane. Any per-category prop budget must exclude props with a `collision` block. Related: `SceneBuilder.ts:827`'s `category === "terrain"` gate is inert anyway — **no** shipped tier sets `scene.terrain.enabled` at all (low/med set only `terrain.lodBias`; high/ultra omit the block).
- **`lodLevel` on the skybox texture.** Babylon still allocates and uploads the full mip chain; `lodLevel` only biases sampling. `noMipmap: true` is the real saving.
- **Prefetching the six terrain texture URLs before the chunk imports.** Prefetching warms the cache but does not collapse 32 later fetches, and workbox SWR revalidates regardless. Fix it in the bake.
- **Treating `[SOUND: ...]` placeholders as neglect.** `shared/src/schemas/theme.ts:515-521` establishes them as the sanctioned form ("§ iron rule 5: placeholders, never fake paths"), and all nine shipped play-sound actions carry one, including the live laser/kinetic/missile/shield-up.
- **Rewriting the four sibling CSS test files.** `hudOverflow`, `ResultsOverlay`, `Scoreboard`, `twoLayerStyle` assert CSS for classes that are genuinely applied. Their limitation is that jsdom has no layout, which `hudOverflow.test.ts:5-11` states outright. Only `designSystemContract.test.ts` certifies dead rules.
- **`pitchToward` as a redundant twin of `advancePitch`.** They have different signatures and semantics. Delete `pitchToward` because it is unreferenced, not because it duplicates anything.
- **Turning on `allowJs`+`checkJs` over `tools/**/*.mjs` as part of the CI job.** It will surface new errors across 2,341 previously-unchecked lines (`bake-lunar-rift-terrain.mjs` alone is 33.9 kB). Worth doing eventually — `tsconfig.tools.json` covers only `.ts`, so `npm run typecheck` never sees the load-bearing generators — but size it separately from the 30-line `validate:terrain` job.

---

## 7. Suggested order

Each step leaves the tree green. Sizes are rough.

**Phase 0 — Safety net (2-3 days).**
1. Golden sim fingerprint, two vectors (2a). ~half day.
2. `SpatialHash` query-order test (2b). ~1 hour.
3. Wire schema field-name contract, both sides (2c). ~half day.
4. `validate:terrain` CI job (2d). ~30 min.
5. `bundle:budget` per-chunk ceiling + initial-chunk-set assertion (2e). ~2 hours.
6. Replace the CTF delivery lottery with pickup-health + an honest delivery floor (2f). ~2 hours.

**Phase 1 — Free bytes and free frames (1-2 days, all independently revertible).**
7. `dontUseTransmissionHelper` (3c). Two lines. Measure draw calls on real hardware while you are there — that A/B is the one number in this report nobody could reproduce.
8. `noMipmap: true` on the panorama (3c). One line, ~10.7 MiB.
9. Font subsets (`latin-*` **and** `latin-ext-*`) + workbox `globIgnores` (3c). ~249 kB gzip of the 2.07 MB install.
10. Widen `heatSystemEnabled` to `TuningConfig | undefined` (3d). One line, kills both casts.
11. Delete the dead code batch (3a): `minimapAltitude`, the twelve exports, the matchmaking trio + its CSS (including the stray `screenStyle.ts:742`), `play-sound-boost-down`. ~half day.
12. Delete the 21 unreferenced prop textures, 8 md5 duplicates first, and de-fake the two test stubs (5d steps 1-2). ~1 hour.

**Phase 2 — Sim and server hot path (2-3 days). Every commit A/B'd against the Phase 0 fingerprint.**
13. Unroll `segmentBounds`/`segmentAabb` (3b). Largest single win: 1.372 → 0.524 ms/tick on lunar-rift.
14. One-slot memo in `buildBotContext` (3b).
15. Bounding-sphere reject in `restSurfaces` (3b).
16. Hoist the redundant `ArenaRoom` snapshot (4c).
17. Cache the `World` id accessors, returning copies (4i).

**Phase 3 — Load and boot (2-3 days).**
18. Concurrency cap on `preloadMatchModels` (4f).
19. `preloadRockSurfaces` job group + honest progress count (4e).
20. Two-phase ship-hull preload with the `getShipMaster` fallback hook (4g).
21. Defer `authService.restore()`, moving the three synchronous consumers first (4h).
22. HUD canvas-size cache, covering `FloatingDamageText.ts:197`, seeded eagerly (3c).

**Phase 4 — Seams (1-2 weeks).**
23. `FlagView` extraction (4a) — smallest seam, best-protected, do it first to establish the pattern.
24. `createBotDriver(world, ...)` (4d), then regenerate the `docs/bots/behavior-map.md` tables.
25. `replicate.ts` extraction + `decode(applySnapshot(snap))` round-trip test + the CTF/decoy room test (4b).
26. Happy-DOM tests for the Hangar state machine (4o), then `HangarStage` with a `NullEngine` test, then `HangarCommerce`.
27. `configs.tuning()` accessor + the exactly-one pack rule (4j).
28. Invert `designSystemContract.test.ts` with the composition allow-list, then delete the ~32 dead class tokens (4n).

**Phase 5 — Risky, one at a time, each behind the fingerprint (1 week).**
29. `queryAABB` generation-stamped visited array alone (5a step 2).
30. Static/dynamic spatial-hash split with a cell-major walk (5a steps 3-4).
31. Roster parity: the 3-line `ArenaRoom.ts:528-534` fix (5c).
32. Delete or wire `vx`/`vz`/`connected`/`hp`/`lastProcessedSeq` with a `PROTOCOL_VERSION` bump and content-pack re-export (5b).
33. Decide `thinInstances` — implement or delete across all 16 sites (5e).

**Phase 6 — Content pipeline (sizing uncertain, depends on bake tooling).**
34. Content-pack reachability sweep as a warning with an exception list (5d steps 3-4).
35. Author an LOD1 for `lunar-rift-he3-plant` (4l).
36. Emit the shared terrain material set once in the bake (4m).
37. Ship `quality.scene.ships.lodBias`, with a re-apply on auto-tier demote (4k) — smallest payoff of the render items; do it last or not at all.
