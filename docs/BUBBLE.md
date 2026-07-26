# Bubble Overhaul — full 3D movement in a spherical arena

Extends docs/FLIGHT.md (all its invariants stand). User request 2026-07-25: the map
is no longer a circle but a **bubble** — ships move in 3D, not on the ground plane —
and the HUD gains **off-screen enemy direction arrows**.

Design rule unchanged: NOTHING per-ship hardcoded; sim determinism rules unchanged.

## Decisions (defaults chosen from the Galaxy Division reference + mobile arcade genre)

- **Orientation model: yaw + pitch, no roll in the sim.** `heading` (yaw, wraps) stays;
  new `pitch` clamped to ±`tuning.maxPitchRad` (default ~1.4 ≈ 80°) so "up" is always
  world-up, the chase cam never flips, and there is no gimbal/quaternion surface.
  Roll is a purely visual client bank (EntityView leans into turns; never in the sim).
- **Pitch is held state like throttle** — stick released ≠ auto-level; the nose stays
  where you point it (space, not atmosphere).
- **Velocity is facing-aligned in 3D**: `dir = (cos p·cos h, sin p, cos p·sin h)`,
  speed integrates exactly as FLIGHT.md §1 (throttle × nominalSpeed × boostMult,
  accel-limited). One flight model, now with a vertical component.
- **Arena bounds become a sphere** (`bounds: { shape: "sphere", radius }`); the circle
  shape is retired with the same full-replacement philosophy as move orders. Both
  shipped arenas convert (deep-field r300 bubble, ring-nebula r90 bubble). Boundary
  rules (bounce/damage) act on 3D radial distance. Asteroid placements + spawns gain
  `y` (and spawns a `pitch`, usually 0).
- **Wire format**: `y` = int16 centi-units like x/z (±327 cap unchanged, r300 safe);
  `pitch` gets its OWN signed int16 codec (±π ↦ ±32767). **Landed as T2, deviating
  from the original "encoded like heading":** heading's codec folds its value into
  0..2π and `decodeHeading` never returns a negative, so a nose-down −0.5 rad would
  arrive as +5.78 rad — outside the sim's ±`maxPitchRad` clamp, wrong for mesh
  orientation and chase-cam beta, and fatal to the client's LINEAR pitch
  interpolation, which would sweep the long way round across zero. Pitch does not
  wrap; its codec must not either. Projectiles replicate y too. This is additive
  wire work, not a format change.

## Feature seams

### A. Sim 3D core
- `Transform2D` → `Transform3D` (`pos {x,y,z}`, `heading`, `pitch`); `Velocity` gains y.
- Order: `{ kind: "flight", throttle, turn, pitchStick (-1..1), boost }` — pitch rate =
  `pitchStick × engine.turnRate × tuning.pitchRateMult` (default 0.8; config knob, no
  new ship stat unless balance wants one later).
- NavigationSystem + steering.flightStep: 3D integration per the decision above —
  MUST stay bit-identical mirrors (existing parity test extends to 3D inputs).
- Spatial hash: stays 2D on (x,z) as the broadphase; all narrowphase checks
  (collisions, lock range, projectile hits) use true 3D distance. At ≤600-unit
  diameter and tens of entities this is comfortably within the tick budget; the
  hash's queryCircle callers add a |Δy| prefilter where it is cheap.
- TargetingSystem cone goes 3D: angle between the 3D facing vector and the 3D
  bearing (one acos on normalized vectors — replaces the planar angleDelta check).
  Sticky-candidate rule, warm-up, drain, gating: unchanged.
- CollisionSystem/ProjectileSystem: 3D distances, homing missiles steer in 3D
  (turnRate applies to the 3D bearing rotation), bounds cull on radial distance.
- Boundary + win conditions + snapshots: `y`/`pitch` in ShipSnapshot (+ projectiles).

### B. Net
- quantize: encode/decode y (centi) + pitch (own signed int16 codec, see above);
  ArenaState PlayerState += y, pitch; projectile state += y; writeState/decode
  both sides.
- protocol orderSchema: pitchStick axis, OPTIONAL (pitch is held state, so an
  absent axis and a centred stick mean the same thing) and clamped like turn when
  present; validateOrder already matched, so the two sides of the trust boundary
  are identical.
- Prediction: flightStep 3D with the same resolved stats; snap velocity derivation
  works on 3D positions.

### C. Client
- Relative steering drives yaw + pitch together. Desktop holds RMB on the canvas
  and accumulates mouse deltas; touch begins on any free HUD area and drags from
  a floating origin. Release recentres both command axes (the sim still holds the
  resulting ship pitch). `sa.controls.invertPitch` flips only pitch. W/S ramps
  throttle; wheel/strip drag remain available. A/D, arrows, and R/F are retired.
- Chase camera: beta follows ship pitch (config lag, clamped so it never crosses the
  poles); alpha logic unchanged. Shake/allocation invariants unchanged.
- EntityView: orient meshes by heading+pitch, add visual bank roll from turn input
  (client-only, drives off snapshot turn/heading delta).
- playerFollow node tracks y; SceneBuilder ground-plane/grid assumptions audited
  (the arena "floor" disappears — starfield shell + bounds shell become the spatial
  reference; minimap keeps the top-down (x,z) projection and gains a small relative-
  altitude tick next to each blip).
- **Off-screen enemy arrows (the new HUD feature)**: for each enemy ship not currently
  inside the safe viewport rect (or behind the camera), draw a theme-styled arrow on
  an elliptical track around the screen edge pointing along the screen-space direction
  to it. Uses the existing `project()` callback; behind-camera positions flip the
  projected direction. Arrow tint: normal enemy vs current lock candidate (reuse
  reticle colors); optional distance fade from theme. DOM per the ModuleButtons
  pattern, geometry in theme.hud (portrait+landscape), capped at the arena's max
  ship count, allocation-conscious update loop.
- Quality/LOD: distances already camera-based, no changes expected beyond testing.

### D. Bots
- flight.ts `turnForHeading` generalizes: desired 3D bearing decomposes into a yaw
  delta (existing math) + pitch delta → `pitchStick` via the same proportional rule
  and self-calibration trick (measure pitch rate from observed Δpitch).
- Behaviors keep their designs; aim points gain y (engage/kite/breakLoS/retreat/dodge
  operate on 3D geometry; jinks alternate between yaw and pitch axes deterministically).

### E. Content/tests
- Arena schema: sphere bounds, placement y, spawn y+pitch; both arenas authored with
  truly volumetric structure rather than planar belts. Deep-field keeps recognizable
  dense clusters, rising/falling strings, and sparse fill across the bubble; most
  rocks are far above or below the old y=0 plane, while a few lower-latitude singles
  preserve navigational variety. Ring-nebula uses the same clustered 3D language at
  its smaller scale.
- Balance/regression fixtures: y=0 starts keep most recorded numbers meaningful;
  scripts that relied on planar geometry re-verified. e2e smoke unchanged in spirit.
- **Volumetric re-author (2026-07-26):** deep-field has 47 placements spanning
  low, middle, and polar latitudes, with |y| routinely in the 150–250 range.
  Ring-nebula's 10 placements reach roughly |y|=55. For both arenas, scaled
  collider surfaces have at least 12 units of pairwise separation and at least
  25 units of clearance from the capsule around the straight centroid-to-centroid
  spawn corridor. Deep-field also enforces the wire-safe
  `distance(origin) + scaled collider radius <= 315` cap placement by placement;
  ring-nebula keeps the same quantity within its radius-90 bubble. Spawn offsets
  and authored pitch values remain unchanged.
- **Rect bounds audit (T6):** rect is not shipped, but it still has live sim and
  SceneBuilder consumers, so it remains supported as a finite 3D box. Authored
  rects now require `verticalExtent`; collision/projectile culling enforce its
  ceiling and floor, and the scene renders all six boundary walls.

## Stage plan (test-gated, per the flight-overhaul rhythm)
1. **T1 sim 3D core** (A) — landed.
2. **T2 net** (B) — landed.
3. **T3 client** (C) incl. off-screen arrows — landed.
4. **T4 bots** (D) — landed.
5. **T5 arena/content + audits** (E) + retirement of circle-bounds code — landed.
6. **T6 external review + fixes + final validation.**

## Boundary shield + skybox follow-up (2026-07-26)

- Arena presentation now lives in `arena.render`: each shipped arena owns its
  `/content/skyboxes/*.webp` equirect panorama plus intensity/tint, and its
  boundary-shield proximity thresholds, blue/red colors, opacity, hex density,
  and warning-notification id. These belong to the arena because they scale
  against that arena's physical boundary; the global HUD theme does not.
- The spherical boundary is a proximity-driven procedural hex shield. It is
  nearly invisible beyond `glowStartDistance`, brightens toward contact, and
  blends blue to red inside `redTransitionDistance`. Low quality keeps the
  panorama but selects the schema-driven plain-shell fallback.
- `damageAndBounce` composes the existing damage magnitude with velocity
  reflection. Every shipped mode uses it, preserving its prior `damagePerSec`.
- The authored boundary notification fires on warning-zone entry and rearms
  only after the player leaves, using the existing notification duration/style
  pipeline.

## Sun, dust, spawn markers, match countdown (2026-07-26)

Four user-requested changes to how a match opens and how the bubble reads.

- **The painted star IS the key light.** `arena.render.skybox` gains an optional
  `sun { dir, color, intensity }`. `dir` points FROM the arena TOWARD the star
  as a unit vector — the same number an author reads off the panorama — and the
  schema rejects a non-unit vector (tolerance 0.02) so a mistyped axis fails
  loudly. SceneBuilder builds the arena's `DirectionalLight` (parallel rays)
  travelling along **-dir** with the authored color/intensity, *replacing* the
  generic `lighting.directionalIntensity` key light; the hemispheric fill stays
  (and now leans toward the star) so an unlit hull face is a shadow rather than
  a silhouette. An arena with no authored sun keeps the old rig byte for byte,
  and the whole rig is still parented to `arenaRoot`, so the editor/hangar
  stages that hide the arena and supply their own lights are unaffected.
  Deep-field: `[0.777, 0.309, 0.55]` / `#ffecc8` / 1.1. Ring-nebula:
  `[-0.677, -0.208, -0.706]` / `#dce4ff` / 1.0.
- **Ambient dust** (`quality.scene.dust`, optional so published packs stay
  valid): one `ParticleSystem` emitting inside a ~120-unit box that follows the
  player's follow point, driven from the same per-frame hook the boundary shield
  uses. Particles live in WORLD space (`isLocal` false), so the ship flies past
  them and the motion sells speed; they expire about one box-crossing after the
  box has moved on, with the lifetime band DERIVED from `boxSize` rather than
  authored. Cost is a function of the box, never the arena radius: one draw
  call and `count` particles at radius 90 or 300 alike. The knobs live on the
  quality tier, not the arena, because every one of them is a render-density /
  overdraw budget — the same argument that puts `starfieldPoints` there.
  Counts: **low 0**, med 180, high 340. Low is off deliberately and not for
  lack of trying: additive sprites are pure overdraw, which is exactly the
  budget a phone at the tier that already drops glow and the hex shader has
  least of.
- **Spawn markers are off in all three shipped tiers.** They are an authoring
  aid. `SceneBuilder.setSpawnMarkerOverride` lets the dev editor force them back
  on for its whole session (`EditorHost.setSpawnMarkersForced`), so the Map
  editor and arena Inspector still show designers where teams spawn — an
  override rather than a second flag, so there is still ONE shipped answer.
- **Match-start countdown** (`tuning.matchCountdownSec`, default 3, `0` legal):
  sim-level and therefore authoritative and identical for both players.
  `ArenaSimulation` opens in a `countdown` phase and reaches `live` only after
  ticking the clock down in SIM time. The mechanic is *suspend the integration*,
  not *reject the orders*: NavigationSystem and ModuleSystem still run, with
  **dt = 0**, so a held flight order is drained and stored while nothing
  integrates — a throttle held through "3-2-1" bites on the very first live
  tick — and a mashed module button toggles once per press instead of N times
  at GO. Nothing else runs, so no lock warms up early and no one can fire or
  collide. `elapsed` (and the `timeLimit` win condition) starts at GO; `tick`
  counts countdown ticks. Snapshot carries `phase` + `countdownRemaining`, and
  the sim emits `countdownTick` (3/2/1) and `matchStarted` — low-rate edges,
  relayed like the lock flips, so the audio cue and the numeral cannot drift
  apart. Online, `ArenaState.countdownRemaining` is written from the sim each
  tick and the room accepts orders throughout the window; the client's predictor
  suspends `flightStep` while the phase is not `live`, and a room still
  `waiting` decodes as `countdown` (its sim is not being ticked at all, which is
  the same guarantee). Bots needed no change — `BotDriver.update` already bails
  on `phase !== "live"`, so no bot burns boost before GO.
  `CountdownOverlay` renders `Math.ceil(countdownRemaining)` → GO in the
  sci-fi style; it reads the replicated value and keeps no timer of its own,
  which is the whole point. The e2e smoke plays the real 3 s countdown inside
  its existing frame budget (90 ticks ≈ 18 forced frames of 1500), so no test
  fixture change was needed there; unit suites run on `matchCountdownSec: 0`
  because they measure per-tick behaviour, and the countdown has its own suite.
