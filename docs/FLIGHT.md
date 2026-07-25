# Flight Overhaul — Galaxy Division-style movement, camera, lock-on, throttle

Design spec for replacing the tap-to-move RTS model with a continuous forward-flight
model. Decided with the user 2026-07-25: **full replacement** (move orders retired at
the end), **left virtual joystick steering**, **radius ~300 arena** (inside the ±327
wire-quantization cap — no protocol format change), **all weapons require lock**.

Design rule unchanged: NOTHING per-ship hardcoded — every knob flows through content
configs, schemas, resolveShipStats, tuning, or theme.

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
  - `heading += turn * engine.turnRate * dt` (turn>0 turns the same direction as
    today's `turnToward` positive delta; client maps stick-right to whichever sign
    reads as screen-right under the chase cam).
  - `desiredSpeed = throttle * engine.nominalSpeed * boostMult` — boost resolves
    exactly like today's MoveOrder.boost path (active boost module + energy/heat
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
  - Candidate = nearest enemy inside the cone (manual `target` orders are retired
    with move orders; targeting is fully automatic).
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
- Pan (right-drag/two-finger) and tap-to-move picking are disabled in chase mode;
  OrderInput's ground-plane picking and double-tap-boost retire with move orders.
- Quality configs: asteroid LOD distances (lodMedium/lodLow/lodCull per tier) were
  tuned for orbit radius 30–90; retune for chase radius (~12–20) + far draw.

## 4. HUD / input (client, all theme-driven)

New theme.hud blocks (portrait + landscape geometry like the module cluster), new
HUD subcomponents per the ModuleButtons pattern (DOM, `data-hud-control` attr so
edge palm-rejection ignores them):

- **Virtual joystick** (left thumb): steer only — `turn = stick.x` (deadzone from
  theme/tuning). Vertical axis unused for now.
- **Throttle strip** (right edge, vertical): drag thumb 0% (bottom) → 100% (top);
  the thumb STAYS where released (held state). Shows % readout. Emits flight orders.
- **Boost button** (module-cluster area): hold = `boost: true`.
- **Lock reticle**: fixed center-screen circle showing the lock zone (size derived
  from coneDeg + camera FOV, theme-styled); target bracket projected onto the
  locked/locking enemy (main.ts passes a `project(worldPos) → cssPx` callback into
  Hud) with a lock-progress ring; locked state = color change + haptic pattern
  (new themeSchema haptic field + Haptics.ts branch) + audio event.
- **Desktop bindings**: A/D or ←/→ = turn, W/S or ↑/↓ = throttle nudge (hold to
  ramp), Shift = boost, mouse drag works on both widgets.
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
- Fix arena split-brain first: main.ts:203/613 hardcode
  `buildArena("arena.ring-nebula")` and Minimap hardcodes ARENA_ID while the sim
  resolves the arena from options — route ONE resolved arenaId into SceneBuilder,
  Minimap, and setPanBounds.
- Wire cap: positions quantize to int16 centi-units (±327.67). Radius 300 is safe;
  do not exceed ~320 without a protocol change (explicitly out of scope).

## 7. Retirement list (final cleanup stage)

move + target orders, MoveOrder component, seekStep, arrival tuning
(arrivalRadius/arrivalStop), asteroid avoidance + clampTargetOutsideAsteroids,
OrderInput tap-to-move + double-tap-boost, OrderMarkers path/destination rendering
(keep/adapt target marker if the reticle doesn't fully replace it), displacement
throttle inference in signals.ts, camera pan in match, protocol move/target cases,
dead tuning fields. Bots (shared/src/bots/behaviors.ts): every behavior re-planned
in flight terms (engage = hold target in cone at range band; kite = hover near max
lockRange; breakLoS = put a rock between; retreat = throttle 1 + boost away;
dodge = turn jinks) — same BotDriver plan() structure, same order path as humans.

## 8. Build order (each stage lands with tests green)

0. Arena wiring fix (independent, tiny).
1. Sim flight model (orders/NavigationSystem/flightStep/snapshot.throttle/signals).
2. Sensors + lock pipeline (+ CombatSystem gate).
3. Client: chase camera + joystick + throttle + reticle + desktop keys.
4. Bots flight rewrite.
5. Net: protocol/validateOrder/ArenaState/prediction.
6. Arena content + LOD/quality retune.
7. Cleanup (retirement list) + docs + Sol review + browser/loadtest validation.
