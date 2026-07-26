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
- Virtual joystick: **y-axis becomes pitch** (was unused — FLIGHT.md §4 reserved it);
  push up = climb (invert via a settings toggle, sa.controls.invertPitch). Desktop:
  W/S or ↑/↓ = pitch (throttle nudge moves to R/F + wheel over the strip; keep the
  strip drag). Deadzone/theme geometry unchanged.
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
  vertical structure (deep-field belts get y-bands so the bubble is used).
- Balance/regression fixtures: y=0 starts keep most recorded numbers meaningful;
  scripts that relied on planar geometry re-verified. e2e smoke unchanged in spirit.

## Stage plan (test-gated, per the flight-overhaul rhythm)
1. **T1 sim 3D core** (A) — biggest; everything else hangs off it.
2. **T2 net** (B).
3. **T3 client** (C) incl. off-screen arrows; live browser verify.
4. **T4 bots** (D).
5. **T5 arena/content + audits** (E) + retirement of circle-bounds code.
6. **T6 external review + fixes + final validation.**
