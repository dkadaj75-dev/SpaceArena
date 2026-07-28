# Bubble Overhaul — full 3D movement in a spherical arena

Extends docs/FLIGHT.md (all its invariants stand). User request 2026-07-25: the map
is no longer a circle but a **bubble** — ships move in 3D, not on the ground plane —
and the HUD gains **off-screen enemy direction arrows**.

Design rule unchanged: NOTHING per-ship hardcoded; sim determinism rules unchanged.

## Decisions (defaults chosen from the Galaxy Division reference + mobile arcade genre)

- **Orientation model: yaw + pitch, no roll in the sim.** `heading` (yaw) wraps, and
  since the **free-pitch amendment (2026-07-27, below)** so does `pitch` — both are
  full-circle angles in (-π, π], and there is still no gimbal/quaternion surface.
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
  arrive as +5.78 rad — wrong for mesh orientation and chase-cam beta. Pitch is
  SIGNED about level; its codec must stay signed. Projectiles replicate y too. This
  is additive wire work, not a format change. (The codec was scaled to the full ±π
  from the start rather than to `maxPitchRad`, which is why freeing pitch to loop
  needed no wire change at all — see the amendment below.)

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

## Free pitch — full loops (2026-07-27)

User request: *"when moving up/down, we should be able to continue steering (e.g.
able to make a full loop), same as left/right."* Pitch was clamped to
±`tuning.maxPitchRad` (~80°); it is now a full-circle angle exactly like heading.
This amends the orientation-model bullet at the top of this file.

- **Pitch wraps to (-π, π]** (`math.advancePitch`, shared by NavigationSystem and
  `flightStep` so the two mirrors cannot diverge at the wrap). The facing formula
  `(cos p·cos h, sin p, cos p·sin h)` needed no change: past vertical `cos p` goes
  negative, the nose's horizontal component flips against the heading, and THAT is
  the loop. Hold the stick up and the ship goes over the top and keeps going.
- **Yaw is BODY-FRAME** (amended 2026-07-27, see the steering section at the end of
  this file). `turn` rotates the nose about the SHIP's own up, not world Y. At level
  flight the two are the same operation; the difference grows with pitch and is what
  makes steering read the same way at every attitude.
- **`tuning.maxPitchRad` becomes an OPTIONAL legacy clamp.** Absent — and the
  shipped pack now omits it — pitch is free and ships loop. Authored, behaviour is
  bit-for-bit what it was before: the nose stops there and can never invert. There
  is deliberately no default value; "absent" is a behaviour, not a missing number.
  `pitchTuningOf` returns `null` for it, and every consumer (integrators, spawn
  pitch, the client predictor, the bots) branches on that one value.
- **Two spellings, one attitude.** `(h, p)` and `(h + π, π − p)` name the same
  nose direction, and once pitch can leave [-π/2, π/2] both are reachable states.
  `math.mirrorAttitude` / `canonicalAttitude` / `attitudeNear` are that algebra.
  Anything that CHOOSES an attitude rather than integrating one has to choose the
  spelling continuous with where the ship already is, or the ship teleports between
  two names for the same thing: the boundary bounce reflects the nose and then
  re-spells it with `attitudeNear`, and the bots pick their desired attitude the
  same way (which is also what lets a bot traverse the pole instead of oscillating
  at it — a target directly overhead is now simply reachable).
- **Wire: unchanged.** The pitch codec was always ±π ↦ ±32767, so the whole wrapped
  domain including inverted attitudes was already representable, and ±π round-trips
  exactly — the one place a rounding error would have flipped a decoded attitude's
  sign. No format change, no version bump.
- **Everything that INTERPOLATES pitch now takes the short way round** — the mesh
  pose, the remote-ship snapshot lerp, the local predictor's attitude pull, and the
  chase rig's tilt. A pair of samples straddling ±π is a normal mid-loop event, and
  a plain lerp would read that near-zero error as a full-circle one.
- **Chase camera: the rig ROLLS with the ship.** First cut kept the world-up
  `ArcRotateCamera` orbit and folded an inverted attitude into its upright
  spelling. The owner flew it and reported being "bumped in the other direction"
  on reaching vertical, and they were right. A world-up chase rig cannot represent
  an inverted attitude: staying behind the nose past the pole needs a π flip of the
  orbit azimuth, and with the camera's up pinned to world +Y that flip inverts the
  entire image in one frame — while the ship's horizontal travel genuinely reverses
  at the same instant (`cos p` changes sign). Together they read as a hard kick
  backwards. It is topological, not a tuning problem: no taper, smoothing or fold
  ordering fixes it. **The layer was pinned before it was fixed** —
  `client/src/game/loopSteering.test.ts` drives the real chain (screen drag →
  `mapRelativeSteer` → `FlightOrderSender` → `flightStep`) with the stick held up
  across both poles and asserts every emitted `pitchStick` is byte-identical and
  every tick advances the nose the same way, which leaves presentation as the only
  candidate.
  So the rig rolls: `camera.upVector` is the SHIP's own up (`chaseUpFor`, which is
  perpendicular to the nose at every pitch and continuous across the ±π wrap), and
  in that frame the ship is permanently level — the camera sits behind and slightly
  above the nose at ONE constant tilt, the horizon rotates smoothly around the
  player through a loop, and "drag up" moves the nose toward the top of the screen
  at every point of it. That last property is the real prize: it is what keeps the
  input's meaning stable, which is what the bug report was actually about.
  Two consequences worth knowing. `chaseOffsetFor` turns out to be exactly the
  plain orbit formula at `alpha = h + π`, `beta = chase.beta + pitch` with no fold
  and no pole clamp — the camera's POSITION was always continuous under the naive
  rule, and only the roll was ever broken. And `ArcRotateCamera` does not accept a
  pose: it derives position from `alpha`/`beta` and then rotates by
  `RotationAlign(Y, upVector)`, so `TacticalCamera.applyChasePose` builds the same
  alignment, undoes it on the desired offset, and reads the orbit angles back out.
  In ordinary flight that resolves to `alpha = h + π`, `beta = chase.beta`; doing it
  by inversion rather than by assuming it keeps the rig correct in the one place the
  assumption fails, namely Babylon's fixed-axis fallback when the up vector is
  within ~2.5° of −Y, which a looping ship passes through at the bottom of every
  revolution.
  `camera.chase.pitchFollow` is RETIRED (schema + shipped pack). It scaled how much
  of the ship's pitch a world-up tilt followed, and the rolled rig has no such
  quantity: the frame rotates 1:1 with the ship or it cannot be continuous through
  the wrap. `beta` survives with a sharper meaning — the over-the-shoulder tilt, now
  measured in the ship's frame and therefore identical at every attitude.
- **HUD.** The minimap folds to the canonical heading before drawing a blip (a
  top-down map must show the direction a ship TRAVELS, and an inverted one travels
  180° from its raw heading). The lock reticle is fed a pitch of ZERO: it sizes the
  cone from `view.betaRad - shipPitchRad`, and the rolled rig's beta is already in
  the ship's frame, where the nose is level by construction — subtracting the pitch
  again would double-count it. The ring is therefore constant, which is what
  `reticleRadiusPx` documents for a rig that looks down the nose. Off-screen enemy
  arrows needed nothing: they key off view-space z, not pitch.

## Screen-relative turn while inverted (2026-07-27)

Follow-up to the camera roll, from a second round of owner testing ("flight still
has issues with bumps / inverted axes").

- **Turn input flips while inverted; the SIM does not.** Yaw stays about world Y
  everywhere — deterministic, bot-compatible, unchanged on the wire. But the chase
  rig rolls with the ship, so upside-down the player is looking at the world from
  an inverted frame and a world-Y yaw sweeps the nose the opposite way across
  their screen: pushing right turned left. The compensation lives at the input
  boundary (`flightInput.turnSignForAttitude`, applied in `RelativeSteerInput`),
  flipping the turn sign while `cos(pitch) < 0`. Pitch needs no flip — "drag up =
  nose toward the top of the screen" already survives the roll, which is the whole
  point of rolling. A hysteresis band holds the previous sign within ~0.05 of
  vertical so the axis cannot chatter at the one attitude where a world-Y yaw is
  nearly pure roll anyway; a full loop flips it exactly twice.
- **The "bump" hypothesis for the online path was tested and REJECTED.** The
  suspicion was a reconciliation snap at the ±PI wrap — the server replicating
  `-PI+ε` against a predictor at `+PI-ε`, any naive subtraction seeing ~2PI. Every
  pitch comparison in the online path was audited (`FlightReconciler` turns out to
  be pure order-sequence bookkeeping with no attitude math at all), and
  `client/src/net/onlineLoop.test.ts` now flies a held loop through a real
  `ArenaSimulation`, the real int16 codecs, snapshot interpolation and the
  session's own `correctPrediction`, at render delays from 3 to 20 ticks. The
  rendered attitude is monotonic through both poles, never steps more than one
  tick of stick, stays a legal wrapped angle, and the snap branch never fires —
  the residual position error peaks at 0.07 units at every latency, because the
  predictor is pulled onto the DELAYED trajectory and then integrates the same
  held input, becoming a lagged copy rather than diverging around the curve. A
  widened, curvature-scaled snap budget was written and then REVERTED on that
  evidence: it fixed nothing measurable and would have loosened a threshold that
  is doing its job. `correctPrediction` was extracted from the session as a pure
  function so this path is testable at all, and it now re-wraps the attitude it
  writes (`lerpHeading` deliberately returns an unwrapped value, which would
  otherwise let the predictor drift off the circle).

## World-yaw's parasitic roll — why the turn flip is not enough (2026-07-27)

Third owner report: "the left/right axes are inverted depending on my rotation
up/down", with the turn-sign flip active. Investigated by pinning the invariant
rather than the mechanism, and the conclusion is that **world-yaw plus a sign flip
cannot be made correct** — it needs a sim-semantics change, which is its own
design pass.

What was RULED OUT, each with a test that stays in the tree:

- *The model.* Screen-right of the rolled rig is `(sin h, 0, -cos h)` —
  independent of pitch — and the nose's response to yaw is `dN/dh · R = -cos p`,
  so flipping on `sign(cos p)` does leave `-|cos p|`: the same screen direction at
  every attitude. Confirmed twice, once on the nose swing and once on the apparent
  slide of a distant star.
- *The plumbing.* `client/src/game/screenSteering.test.ts` drives the REAL chain —
  a real `RelativeSteerInput` fed real pointer events, its real `setShipPitch`,
  `mapRelativeSteer`, `flightStep`, and the real rig math — and the invariant holds
  at 0, ±45, ±80, ±100, ±135 and 180 degrees. Its control case shows the invariant
  breaking at exactly `[100, -100, 135, -135, 180]` when the attitude feed is
  removed, so the flip is demonstrably firing.
- *The pitch source.* Nothing between sim state and `setShipPitch` canonicalizes:
  the fold helpers are used only by the minimap (on its own scratch) and the
  reticle takes a constant now. `cos(pitch)` does go negative in flight.
- *The Babylon binding.* `client/src/game/chaseRigBinding.test.ts` drives a real
  `ArcRotateCamera` on a `NullEngine` through `applyChasePose` and confirms the
  camera lands on the intended offset to 1e-6 at every pitch, that its view
  matrix's screen-right is the pitch-independent vector the invariant rests on,
  and that the horizon really does invert over the top.

The ACTUAL cause: the rig is locked to the nose, so the ship sits at screen centre
and the lateral swing is only half of what a turn input does to the view. The other
half is ROLL — a world-Y yaw also spins the camera about its own view axis at a
rate proportional to `sin p`. Near vertical that roll IS the visual (0.999 of it at
88 degrees) while the lateral component has collapsed to 0.035, and the sign flip
that fixes the lateral component necessarily reverses the roll along with it. Four
degrees apart, at 88 and 92, the same held input spins the world in opposite
directions. Without the flip the roll is continuous but sustained inverted flight
steers backwards; with it, sustained flight is right and the crossing reverses.
Both halves cannot be satisfied by any choice of sign, which is why this is a model
limitation and not a bug to patch. The behaviour is pinned as a KNOWN LIMITATION
block in `screenSteering.test.ts`.

**Recommended fix, not implemented (needs a design pass):** body-frame yaw — rotate
the nose about the SHIP's own up `U` instead of world Y, decomposing back into
`(heading, pitch)`, which the roll-less state can represent exactly. Then
`dN/dpsi = U x N`, and that cross product is *exactly* the rig's screen-right at
every attitude with unit length: constant steering authority, identical screen
direction upright or inverted, no dead zone at vertical, and — since rotating about
`U` leaves `U` fixed — zero parasitic roll. No sign flip needed at all, so
`turnSignForAttitude` would retire with it. The cost is that `turn` stops being a
plain `heading +=` in the integrator, which touches the sim mirrors, the bots'
steering decomposition and the determinism story — hence a design pass rather than
an edit.

## Steering model: body-frame yaw (2026-07-27, supersedes world-yaw)

The owner's third report — "the left/right axes are inverted depending on my
rotation up/down" — was traced to the steering MODEL, not to any bug in the
plumbing (input chain, pitch source and the Babylon camera binding were each
cleared with a test that is still in the tree). World-Y yaw splits its screen
effect into a lateral component that scales as `cos p` and a view ROLL that scales
as `sin p`. Near vertical the roll is the entire visual and the lateral component
has vanished, so a sign flip that fixes one necessarily reverses the other. No
choice of sign satisfies both. The turn-sign flip added earlier is retired.

**The model.** With `N` the nose, `U` the ship's up (which is also the chase rig's
up) and `W = N x U` the ship's right-hand axis:

    N = (cos p·cos h, sin p, cos p·sin h)
    U = (−cos h·sin p, cos p, −sin h·sin p)
    W = N × U = (−sin h, 0, cos h)

`turn` rotates `N` about `U`. Since `U ⊥ N`, Rodrigues collapses to
`N' = N·cos ψ + W·sin ψ`, so `dN/dψ = W` with `|W| = 1` at EVERY attitude —
constant authority, same screen direction upright or inverted, no dead zone at
vertical. `W` is exactly the chase rig's screen-right, which is why the steering
invariant now holds identically at every pitch. Pitch is unchanged: it already
rotated the nose about `W`, which is what a body-frame pitch is. Both integrators
go through `math.advanceAttitude`, and the decomposition back to (heading, pitch)
picks the spelling continuous with the current attitude, so an inverted hull stays
inverted through a turn.

**At pitch 0 this is bit-identical to the old model** (`U` is world Y there), which
is the change's strongest safety property and is asserted directly. It is also why
NO regression or balance anchor moved: every recorded fixture flies level.

**What it costs, stated plainly.** Turning while pitched rolls the horizon by
`ψ·tan p`, where world-Y yaw rolled it by `ψ·sin p` — body-frame rolls MORE at
steep pitch. That is the deliberate trade, and it is the right one because the two
are different kinds of defect: a rolling horizon while you turn in a climb is what
turning in a climb looks like, whereas a lateral response that fades to zero and
then reverses makes the control itself untrustworthy. `tan p` is unbounded only at
the pole, where the roll-less state genuinely has no derived "up" to offer —
the Euler singularity, not a steering bug, and unbuyable without giving the sim a
real roll axis (a different orientation model than this game chose). A ship crosses
the pole in a few hundredths of a second and keeps full steering authority while it
does. All of this is pinned in `client/src/game/screenSteering.test.ts`.

**Consequences elsewhere:**

- `heading` is now a COORDINATE whose scale depends on pitch: a body-frame yaw of
  `ψ` moves it by `ψ / cos p`, unbounded at the pole. Anything that measures a rate
  or an error in heading has to account for that. Two places did.
  - Bots (`BotDriver.calibrate`) multiply the observed heading change by `cos p` to
    recover the hull's actual yaw rate; without it the estimate balloons with pitch
    and the bot centres its stick to nothing in a climb.
  - Prediction (`correctPrediction`) pulls the ATTITUDE by interpolating the nose
    DIRECTION and re-deriving the pair, instead of lerping the two angles
    independently. Measured on a full-stick pitched turn, the old coordinate-wise
    pull moved the rendered nose 0.24 rad in one frame — four times what the hull
    can physically rotate — which reads as judder. Direction-space brings it to
    0.161, inside the derived bound.
- Bots plan in the ship's frame now (`steerForPoint`): `yawErr = atan2(D·W, D·N)`,
  `pitchErr = asin(D·U / |D|)`. Simpler than the old spherical version and better
  behaved — no heading/pitch coordinate appears in it, so nothing degenerates near
  the poles and an inverted hull needs no special case. The `asin` is not a typo
  for `atan2`: the sim applies yaw first and then pitch about the already-yawed
  axis, and that ordering is what the pair has to invert. Because the axes move
  with the hull, no single constant pair of sticks lands exactly on a bearing
  open-loop — re-planning each interval closes it, which is what the driver does.
- Prediction snap threshold now scales with speed while steering. A hard pitched
  turn is a tight spiral, and the predictor settles ~3.15 units behind the
  render-delayed sample — past the flat 3-unit snap distance, so a correctly
  predicted manoeuvre was teleporting the ship online. This is the "bump" that an
  earlier pass looked for on a pure-pitch trajectory, failed to reproduce, and
  correctly declined to fix on speculation; coupling the axes is what surfaced it.
- Camera needed nothing: `U` was already the rolled rig's up.
- Wire, codecs and the order schema are untouched — `turn` is still a rate in
  [-1, 1].
