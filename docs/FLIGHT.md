# Flight Overhaul — Galaxy Division-style movement, camera, lock-on, throttle

Design spec for replacing the tap-to-move RTS model with a continuous forward-flight
model. Decided with the user 2026-07-25: **full replacement** (move orders retired at
the end), **left virtual joystick steering**, **radius ~300 arena** (inside the ±327
wire-quantization cap — no protocol format change), **all weapons require lock**.

Design rule unchanged: NOTHING per-ship hardcoded — every knob flows through content
configs, schemas, resolveShipStats, tuning, or theme.

## Match presentation amendment (2026-08-05)

Match presentation is a strict `live → outcome (3 s) → MVP → scoreboard → exit` flow. On end,
the themed victory/defeat/draw (or practice-clear) outcome fills the centre while
the arena remains visible; after three seconds it yields to the MVP shot. Then
combat HUD/entities are hidden while the arena skybox and lighting remain; one
disposable instance of the MVP hull is staged for the hero shot. NEXT reveals
the same full-viewport scoreboard used by hold-Tab, with new-game and menu exits
kept below the tables. MVP uses the scoreboard score (capture 1000, return 100,
kill 100, assist 25, death −10). Equal scores break by kills, fewer deaths,
assists, captures, returns, then lowest entity id, making replicated ordering
irrelevant. Before countdown, arena preload is covered by a themed loading
screen using the arena skybox and the session's team roster.

## Flight-frame amendment (2026-07-30)

Ship orientation is now an authoritative forward/up FRAME (see the amendment at
the top of `docs/BUBBLE.md` and `docs/HANDOFF-2026-07-30-FLIGHT-FRAME.md`):
`Transform3D` persists a unit `up` alongside heading/pitch, both integrators
advance the whole frame (`shared/src/sim/frame.ts`), the up replicates
(`PROTOCOL_VERSION` 3), and the chase camera (§3), hull pose and 3D radar all
consume the replicated frame instead of reconstructing an up from heading/pitch.
Statements below that derive the camera or hull basis from heading/pitch alone
describe the roll-less historical model.

## Owner presentation amendment (2026-07-30)

This amendment supersedes older HUD/minimap/asteroid-LOD descriptions below:

- Every visible asteroid uses its authored GLB on low, medium, and high. The
  shipped tiers set model-to-procedural medium/low LOD distances to zero; only
  distance culling remains tier-specific. Arena model preloading completes
  before `ViewManager` creates instances, while procedural recipes remain the
  real asset-load failure fallback.
- The upper-left instrument is now a player-centred 3D Canvas2D radar. A tilted
  plane carries ship-relative right/forward and lollipop stems carry
  ship-relative up, using raw heading/pitch so loops and inverted flight remain
  continuous. Legacy minimap theme fields are accepted as fallbacks.
- Hull and shield are subtle theme-driven arcs flanking the ship. Their legacy
  lower-left rows are disabled in the shipped theme; energy remains.
- The projected lock-cone circle is optional and hidden in shipped content;
  target brackets and lock progress still operate. The primary weapon's
  decorative circle is disabled and the fitting-driven module arc is tighter
  around the pedestal.
- The throttle is raised and drawn at 60% opacity. The chase camera baseline is
  12 units, with a persisted Settings multiplier from 0.8 to 1.5 applied over
  the authored radius.

## Owner presentation amendment (2026-07-31)

- **Module meshes are hidden on the hulls** while the module models are
  placeholders: `theme.juice.deploy.showMeshes: false`. The deploy/retract
  state machine, HUD buttons, emitters and shield are untouched; flipping the
  flag back re-mounts the meshes with no code change.
- **Module activation is fast**: deploy/retract times were cut roughly 3×
  across the shipped modules (lasers 0.5/0.35s, kinetics/shields 0.4/0.3s,
  missiles 0.7/0.4s, boosts 0.25s).
- **Weapon ranges are 2.5×** (kinetic 75/85, beam 85, laser 95/105, missile
  137.5/155), with ship `sensors.lockRange` scaled 2.5× to match — all weapons
  require lock, so an unscaled lock range would have silently capped the
  increase. Projectile lifetimes were extended so speed × lifetime covers the
  new reach.
- **The shield bubble is a faint rim**, not a balloon: an opacity fresnel keeps
  the shell's centre near-transparent, and the shipped ripple block drops to
  radiusScale 1.18 / maxAlpha 0.1.
- **Module buttons are restrained circles**: quiet translucent plate, thin
  family-tinted ring; the family colour only fills the button while the module
  is ON (`hud.modules.fillOpacity` now means the active-fill tint).
- **Landscape chase camera defaults to 70%** of the authored radius
  (`camera.chase.landscapeRadiusScale`); the player's distance setting
  multiplies on top.
- **Practice vs bots is a 1v1** against `bot.rookie` (the easy profile);
  the aggressive+cautious pair roster is retired from the shipped mode.

## 1. Flight model (sim)

New order (shared/src/sim/orders.ts):

```ts
{ kind: "flight"; throttle: number /* 0..1 */; turn: number /* -1..1 */; boost: boolean }
```

- **Level-triggered**: stored in a persistent `FlightState` component
  (`world.flightStates`), NOT cleared on any condition — the sim integrates the last
  received state every tick until replaced. This keeps the net model edge-triggered
  (one order per meaningful input change) and inside `tuning.maxOrdersPerSec`.
- NavigationSystem per tick for ships with FlightState:
  - `heading += turn * engine.turnRate * dt` (turn>0 increases heading directly,
    the same sense as a positive `angleDelta`; client maps stick-right to
    whichever sign reads as screen-right under the chase cam).
  - `desiredSpeed = throttle * engine.nominalSpeed * boostMult` — boost resolves
    exactly like today's MoveOrder.boost path (active boost module + energy
    headroom, `workedThisTick = true`).
  - Approach `desiredSpeed` with `engine.accel * dt`, velocity always heading-aligned,
    integrate position. Same math style as seekStep — no arrival concepts.
  - **No asteroid avoidance in flight** — the player (and bots) eat `impactDamage`
    via the existing CollisionSystem. Avoidance code goes away with move orders.
- `steering.ts`: add `flightStep(s, input, p, dt)` mirroring the NavigationSystem
  integration exactly (used by client prediction). `seekStep` dies with move orders.
- Snapshots: add `throttle` (actual FlightState value, 0 when none) to `ShipSnapshot`
  so client signals (engine trails, boost curves) read the real value instead of
  inferring from displacement (retire REFERENCE_THROTTLE_STEP inference in signals.ts).
- Determinism rules unchanged: no Date.now/Math.random in sim, sorted-id iteration,
  fixed system order, tick-integrated timers only.

## 2. Sensors + lock-on (sim)

New ship stat block `core.sensors` (schema + all ship JSONs + resolveStats):

```jsonc
"sensors": { "lockRange": 55, "lockTimeSec": 1.6, "coneDeg": 70 }
```

- resolveStats: add `sensors.lockRange`, `sensors.lockTimeSec`, `sensors.coneDeg` to
  STAT_PATHS **and** the base bag **and** the ShipCore mapping (all three or statOps
  silently no-op). Modules/upgrades can then modify lock stats with zero extra code
  ("lock distance depends on ship and modules" falls out of the resolver).
- Lock zone is a **heading-relative world-space cone**: candidate enemies with
  `dist <= lockRange` and `|angleDelta(heading, bearingTo(target))| <= coneDeg/2`.
  The chase camera yaw-follows heading, so on screen this IS the circular zone;
  the screen circle is only a visualization of the cone.
- TargetRef gains `lockProgress: number` (seconds) and `locked: boolean`.
  TargetingSystem each tick:
  - Candidate selection is **fully automatic** — there is no `target` order and
    no manual pin. One rule produces every ship's candidate, player and bot alike:
    - **Sticky while lockable** (final, landed in stage 7): if the ship's current
      target is still alive and still inside the cone + range, it REMAINS the
      candidate, whatever the ranking now says. Fresh selection (nearest inside
      the cone, or `tuning.targetingPolicy`) runs only when there is no such
      incumbent — because it died, left the zone, or was never set.
    - Why: a lock needs `lockTimeSec` of continuous progress on ONE candidate and
      any change zeroes it, so re-ranking every tick means a second enemy drifting
      a hair closer throws away a warm-up that was about to finish, and in a
      two-on-one nobody ever fires. This is the sim-side version of what the bots'
      `holdLockTarget` did while target orders existed — moved into the sim so it
      covers human pilots too and so bots gain nothing the player does not have.
    - An incumbent that leaves the zone with another enemy already in it switches
      IMMEDIATELY (progress from zero, no drain grace); with nothing else in the
      zone it drains as below, and the drop at 0 re-opens selection.
  - Candidate changed → `lockProgress = 0, locked = false`.
  - Candidate valid → `lockProgress += dt` capped at `lockTimeSec`;
    `locked = lockProgress >= lockTimeSec` (then stays true while progress > 0).
  - No candidate / left cone → `lockProgress -= dt * tuning.lockDecayMult`
    (default 1.5, new tuning field); at 0 → `locked = false`, target dropped.
    The drain window IS the lock-break grace — deterministic and tunable.
  - Emit `lockAcquired` / `lockLost` world events (audio/haptics juice hooks).
- CombatSystem: weapons fire only when `ref.locked` (all weapon kinds — decided).
- ShipSnapshot += `lockProgress` (normalized 0..1) and `locked`.
- Bots gain no aimbot: lock gating lives in the sim, and bots use the same order
  vocabulary through the same validateOrder path as humans.

## 3. Chase camera (client)

- New `chase` block in cameraSchema (all feel knobs config-driven, hot-reload +
  TuningPanel for free): `radius`, `height` (follow-point y offset), `beta`,
  `yawLag` (0..1 smoothing like followLag), optional `fov`.
- TacticalCamera gains chase mode alongside setEditorMode/setHangarMode: alpha
  driven each frame from smoothed ship heading (Babylon yaw = π/2 − heading, same
  convention as EntityView), beta/radius from chase block, target = playerFollow
  node with configurable height. Preserve invariants: shake stays purely additive
  and applied last; allocation-free update(); mutate camera.target in place (never
  setTarget()).
- Pan (right-drag/two-finger) and tap-to-move picking are gone: OrderInput and
  the whole in-match pan rig retired with move orders (§7). `camera.pan.sensitivity`
  survives for the dev editor's stage; `lookAhead` and `pan.boundsMargin` do not.
- Quality configs: asteroid LOD distances (lodMedium/lodLow/lodCull per tier) were
  tuned for orbit radius 30–90; retune for chase radius (~12–20) + far draw.

## 4. HUD / input (client, all theme-driven)

New theme.hud blocks (portrait + landscape geometry like the module cluster), new
HUD subcomponents per the ModuleButtons pattern (DOM, `data-hud-control` attr so
edge palm-rejection ignores them):

- **Relative steering**: desktop holds RMB on the game canvas and moves the
  mouse; touch starts on any free area and drags from a floating origin. The
  radial deadzone, max radius, response curve, mouse sensitivity, and feedback
  geometry are theme-driven. Release recentres turn + pitchStick.
- **Virtual joystick** remains a reusable component behind
  `theme.hud.flight.joystick.enabled`; the shipped theme disables it.
- **Throttle strip** (right edge, vertical): drag thumb 0% (bottom) → 100% (top);
  the thumb STAYS where released (held state). Shows % readout. Emits flight orders.
- **Bottom-right action cluster**: every fitted module button plus the dedicated
  BOOST / JETTISON controls share the right-thumb cluster. Their corner-relative
  slots are authored in `theme.hud.flight.actions` (with portrait/landscape
  overrides).

  **There is no FIRE button (2026-08-21.)** A WEAPON's button is a momentary
  trigger: tap to fire, hold to keep firing as fast as its `fire.cycleTime`
  allows. The pilot's first weapon sits on the old FIRE footprint —
  `theme.hud.flight.fire` still supplies that slot's geometry and colour. Held
  buttons ride the flight order as `triggers`, a bitmask over hardpoint index,
  so holding costs no extra orders; the sim ORs it with the ship-wide `fire`
  flag, which is what the space bar and every bot still use. Weapons are no
  longer toggleable at all, and are never shed by the power rail (a shed gun
  would have no control that could bring it back) — a deployable that the rail
  cannot feed is refused instead.

  Buttons show their module GLYPH, not its name; the caption survives as
  screen-reader-only text. A weapon's ring is its cooldown.

  BOOST toggles the fitted boost module and its replicated `active` state drives
  `boost: true`. JETTISON appears only for a countermeasure pod with a
  `jettison` block, emits `jettisonCountermeasure`, and draws its replicated
  cooldown.
- **Lock reticle**: fixed center-screen circle showing the lock zone (size derived
  from coneDeg + camera FOV, theme-styled); target bracket projected onto the
  locked/locking enemy (main.ts passes a `project(worldPos) → cssPx` callback into
  Hud) with a lock-progress ring; locked state = color change + haptic pattern
  (new themeSchema haptic field + Haptics.ts branch) + audio event.
- **Combat text**: each ship damage or shield-absorb event creates a pooled RPG
  number at that ship's projected screen position. Numbers float upward and fade
  over one second; quick like-for-like hits on one target merge to keep sustained
  fire legible. Hull uses the theme hull colour, shield uses the shield colour,
  and damage taken by the player uses the danger colour near the player-edge
  convention in chase view. The same sim-event path feeds practice and online.
- **Desktop bindings**: W/S = throttle nudge (hold to ramp), Shift = toggle the
  first fitted boost module,
  hold RMB + mouse movement = turn/pitch. A/D, arrows, and R/F are unbound.
- Order sending: client keeps latest input state; sends a flight order when
  `|Δthrottle| > 0.02`, `|Δturn| > 0.05`, boost edge, or 250ms heartbeat while
  changing — comfortably inside maxOrdersPerSec, with a trailing send so the final
  state always lands.

## 5. Net (online)

- protocol.ts orderSchema += flight (zod: throttle clamped 0..1, turn −1..1,
  boost boolean); ArenaRoom.validateOrder clamps/rejects the same way.
- ArenaState += per-ship `lockProgress` (u8 quantized) + `locked` (bool) +
  `throttle` (u8) — server writeState + client decode.
- Prediction (NetGameSession): replace seekStep call + hardcoded arrivalStop=1.5
  with flightStep, and use **resolved** stats (client runs resolveShipStats with
  its known fitting/upgrades — Hangar already does this) instead of base
  cfg.core.engine. Under continuous flight a base-stats error is persistent, not
  transient.

## 6. Arena (content)

- New arena `content/arenas/deep-field.json`: radius 300, spread spawn points,
  several asteroid belts/clusters + open lanes, boundary `damage` (warning has no
  sim enforcement today). Manifest entry (classic silent failure) +
  gamemode.defaultArena.
- **As landed:** 47 asteroids in four structures — a broken core ring at r 40-56,
  two mid belts athwart the spawn axis at r 118-144, flank knots at r 176-208 and
  sparse rim debris at r 240-270. Lanes are held open at 45°/135°/225°/315°
  (±21°), so the spawn axis is a clear run through the middle. Nothing reaches
  past 272 units including its collider — well inside the ±320 guard rail.
- Spawns: three per team at r ~99, team 0 around (-70,-70) facing 0.785 and team 1
  around (70,70) facing 3.927. That is 198 units apart — 2.5× the interceptor's
  78-unit `lockRange` and 3.2× the brawler's 62 — so nobody spawns already
  locked, and a head-on merge is ~2 s of closing at nominal speed. Spawns sit in
  the gap between the core ring and the mid belts, in an open lane.
- `defaultArena`: practice + duel-1v1 move to deep-field; practice-bots stays on
  ring-nebula, which keeps the small arena a live, exercised code path.
- Scene/quality follow-ups for the bigger space: the starfield shell is derived
  from the arena bounds instead of a 300-550 literal (it used to sit *inside* a
  radius-300 field); `theme.hud.minimapRangeUnits` is dropped from the shipped
  theme so the minimap fits whatever arena the session resolved; asteroid
  `lodCullDistance` on low/med (300/450) had been "never cull" at radius 90 and
  silently became a real cull — re-set to 380/620, and starfield counts raised to
  keep density across the larger shell.
- Practice dummies are now placed in the player's SPAWN FRAME (ahead/abeam
  offsets, `client/src/game/GameSession.ts`) rather than at absolute coordinates,
  so they land in the sensor cone on any arena.
- Arena split-brain (fixed in stage 0): main.ts used to hardcode
  `buildArena("arena.ring-nebula")` and Minimap its own ARENA_ID while the sim
  resolved the arena from options. ONE resolved `session.arenaId` now drives
  SceneBuilder and Minimap; the third consumer, the camera pan clamp, retired
  with the pan itself (§7).
- Wire cap: positions quantize to int16 centi-units (±327.67). Radius 300 is safe;
  do not exceed ~320 without a protocol change (explicitly out of scope).

## 7. Retirement list — DONE (landed as stage S6, with §6)

Everything below is removed from the tree; nothing in the list survives as a
gated/dead path.

**Sim** — `move` + `target` out of the `Order` union; `MoveOrder` component and
`world.moveOrders`; `seekStep` + `SteerParams` (`steering.ts` keeps `flightStep`);
NavigationSystem's move branch, `clampTargetOutsideAsteroids`, the avoidance
block, `ARRIVAL_STOP` and the arrival tuning reads; TargetingSystem's manual-pin
path and `TargetRef.manual` (replaced by the sticky-candidate rule, §2);
`moveOrderSet` / `moveOrderCleared` events (`targetSet` stays — auto targeting
still announces its candidate). `signals.ts`: the displacement fallback under
`throttle` is gone (it reads the real commanded value). `speedFraction` and
`boostActive` deliberately KEEP the displacement basis: they describe actual
motion, `ShipSnapshot` carries no velocity, and deriving them from `throttle`
would lie mid accel-ramp, after a collision, or when a boost request was denied
for want of energy.

**Schemas / content** — `tuning`: `arrivalRadius`, `avoidLookahead`, `avoidWeight`,
`orderMarkerDashLength`, `doubleTapWindowMs`, `tapSlopPx`, `edgeRejectMarginPx`
(the last three had no consumer left once the canvas pointer machine went).
`targetingPolicy` STAYS — it still ranks fresh candidates. `camera`: `lookAhead`
and `pan.boundsMargin` gone, `pan.sensitivity` kept for the editor stage.
`theme.hud.minimapRangeUnits` dropped from the shipped pack (still schema-legal).

**Net** — `orderSchema` move/target cases and the now-unreachable `out-of-bounds`
/ `bad-target` reject reasons; `ArenaRoom.validateOrder`'s move/target cases and
its `inBounds` helper. `PROTOCOL_VERSION` was unchanged *for this stage*: no
replicated field moved, and the reject reasons that went are not schema.
(Correction, 2026-08-16: the constant is not content-only. It gates the CONTENT
PACK bundle — `validateBundle` in `shared/src/content/pack.ts` refuses a
mismatch — *and* it is the repo's version stamp for the Colyseus schema in
`server/src/rooms/state/ArenaState.ts`; entries 3 through 7 in
`shared/src/constants.ts` are all wire-schema changes. There is no second
constant. Bump it whenever a replicated field is added, removed or reordered.)

**Bots** — `BotDriver` no longer emits `target` orders (`lastTargetId` gone). It
keeps `pickTarget`, renamed in intent: it chooses which enemy to MANOEUVRE
against, which is local planning, not a sim privilege. `holdLockTarget` survives
with that meaning — it keeps the bot's flying aligned with the sim's sticky
candidate. `kite`'s perch leg is deleted: `score` only bids below `breakRange`,
which sits inside `standoffRange` in every shipped profile, so the "at or beyond
the standoff, nose back on" branch was unreachable by construction. Re-perching
is `engage`'s job — once kite stops bidding, engage wins and holds the band.

**Client** — `OrderInput.ts` (+ its test) and `OrderMarkers.ts` deleted outright;
the ground-plane pick path, double-tap boost and path/destination rendering go
with them (the lock reticle and the minimap cover what they showed). The
canvas-level palm-rejection helpers in `inputGuards.ts` go too — no pointer path
can be palm-rejected any more; `HUD_CONTROL_ATTR` stays. TacticalCamera loses the
in-match pan entirely (`pan()`, `panOffset`, `setPanBounds`, `recenter`,
`lookAhead`) and its pointer handler now serves only the dev editor.
NetGameSession loses `predTarget`/`predBoost`/`seekStep`. `camera.chase.fov` is
reconciled with its own doc: absent now genuinely keeps the engine default, and
the rig restores that default on a hot-reload that deletes the key.

## 8. Build order (each stage lands with tests green)

0. Arena wiring fix (independent, tiny).
1. Sim flight model (orders/NavigationSystem/flightStep/snapshot.throttle/signals).
2. Sensors + lock pipeline (+ CombatSystem gate).
3. Client: chase camera + joystick + throttle + reticle + desktop keys.
4. Bots flight rewrite.
5. Net: protocol/validateOrder/ArenaState/prediction.
6. Arena content + LOD/quality retune.
7. Cleanup (retirement list) + docs + Sol review + browser/loadtest validation.

Stages 6 and 7 landed together as stage S6.

## LOD retune follow-up (2026-07-26)

Designer feedback moved asteroid swaps materially farther from the chase camera.
The Quality editor exposes these and every other quality scene knob through the
normal schema/save/hot-reload path.

| Tier | Medium before → after | Low before → after | Cull before → after |
| --- | ---: | ---: | ---: |
| low | 55 → 95 | 130 → 220 | 380 → 600 |
| med | 85 → 150 | 200 → 340 | 620 → 900 |
| high | 120 → 210 | 280 → 480 | 0 → 0 (never cull) |
