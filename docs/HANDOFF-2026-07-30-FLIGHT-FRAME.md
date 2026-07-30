# Flight-frame handoff — eliminate the steep-pitch barrel roll

Date: 2026-07-30  
Owner report: the ship sometimes performs a sudden barrel roll while steering near the vertical up/down axis.  
Status when written: root cause reproduced; implementation follows this document.  
**Status 2026-07-30 (Claude): IMPLEMENTED** — see the implementation record at the bottom of this file for the two places the design was amended during implementation.

This is the current contract for the next flight-model pass. It supersedes the passages in `docs/BUBBLE.md` and `client/src/game/screenSteering.test.ts` that deliberately accepted `yaw × tan(pitch)` horizon roll and an unbounded pole spin.

## Confirmed reproduction

The symptom is deterministic, not camera noise or network reconciliation.

With the shipped interceptor rate (`turnRate = 3 rad/s`), 30 Hz simulation, `turn = 1`, `pitchStick = 1`, and `pitchRateMult = 0.8`:

- tick 20: pitch `83.490°`, heading advances `31.256°` that tick;
- tick 25: pitch `88.692°`, heading advances `76.535°`;
- tick 30 onward: pitch converges to `88.711°`, while heading advances `77.367°` every tick;
- the derived frame therefore spins about 6.45 revolutions per second instead of crossing the pole.

A pure `0.1 rad` body-yaw step moves the nose by the expected `5.73°`, but the reconstructed ship-up vector jumps by:

- `29.52°` from an 80° pitch;
- `48.77°` from 85°;
- `80.08°` from 89°;
- exactly `90°` at the pole.

`TacticalCamera` and `EntityView` then display that invalid frame. A separate presentation bug compounds it: cosmetic hull bank derives rate from Euler `heading`, whose scale is unbounded near the pole, so its target saturates and reverses across vertical.

## Root cause

`Transform3D` stores only `{ heading, pitch }`. `advanceAttitude(...)` constructs a derived ship frame, rotates the **nose** around derived ship-up for body yaw, then decomposes only that nose back into heading/pitch. The rotated up axis is discarded.

That loss is harmless at level flight and catastrophic near ±90° because infinitely many roll orientations share the same vertical nose. Reconstructing up from the two Euler coordinates selects a different frame. The comment that yaw “leaves U fixed” describes the intermediate Rodrigues rotation, not the state that is actually persisted.

The full diagonal input exposes a worse behavior than the existing tests assumed: yaw pulls pitch just below the pole while pitch input pushes it back up, forming a stable near-pole trap. The ship does not merely cross the singularity for a few hundredths of a second.

## Chosen solution: authoritative forward/up frame

Preserve the existing heading/pitch compatibility surface, but make ship orientation a full orthonormal frame by persisting `up: { x, y, z }` alongside it.

- Forward/nose `N` remains derivable from heading/pitch and drives velocity, targeting, and legacy codecs.
- Persisted `U` carries the missing roll degree of freedom; no player roll control is added.
- Right-hand flight axis is `W = N × U` under the project’s established convention.
- Normalize and Gram–Schmidt-correct the frame at controlled boundaries to prevent numerical drift.

One integration tick applies local rotations to the complete frame:

```text
# body yaw ψ around U
N1 = N cosψ + W sinψ
W1 = W cosψ - N sinψ
U1 = U

# body pitch δ around the already-yawed W1
N2 = N1 cosδ + U1 sinδ
U2 = U1 cosδ - N1 sinδ
W2 = W1
```

Derive wrapped heading/pitch from `N2` only for existing consumers. Persist `U2`; never reconstruct it from heading/pitch during normal integration.

This is equivalent in capability to an authoritative quaternion, while matching the codebase’s existing nose/up math and avoiding engine-specific quaternion conventions inside the deterministic shared simulation.

## Required migration

### Shared simulation

- Add required `up` to authoritative ship transforms and predicted steering state.
- Seed up from authored heading/pitch at every ship/asteroid/projectile spawn that owns a transform.
- Replace nose-only `advanceAttitude` integration with full-frame yaw/pitch integration in both `NavigationSystem` and `flightStep`.
- Keep those paths bit-identical and allocation-free.
- Update boundary reflection to transport/refit up against the reflected nose rather than silently resetting roll.
- Provide pure helpers for frame construction, normalization, interpolation, and body-yaw measurement.
- Make bot steering use the persisted frame rather than rebuilding U/W from heading/pitch.

### Snapshot and wire

- Add authoritative ship up-vector fields to `ShipSnapshot` and Colyseus `PlayerState`.
- Replicate all three components (float32 is acceptable at current ship counts; normalize on decode).
- Bump `PROTOCOL_VERSION` because older clients cannot reconstruct the authoritative frame.
- Carry up through local prediction, rollback/replay, correction, delayed snapshot interpolation, and test fixtures.
- Interpolate full frames/quaternions, not Euler heading and pitch independently.

### Client presentation and controls

- Render hulls from interpolated forward/up using a rotation quaternion (`Quaternion.FromLookDirectionLH` for model +Z forward/+Y up), then apply only the bounded cosmetic bank around local forward.
- Drive chase-camera up and offset from the same interpolated authoritative frame:
  `offset = -N · sin(beta) · radius + U · cos(beta) · radius`.
- Smooth/interpolate the frame, not heading/pitch separately.
- Project the 3D radar in the replicated player frame.
- Derive cosmetic bank from signed body-yaw between consecutive frames, not raw heading-coordinate rate.
- Assert the real rendered camera basis still maps stick-left/right correctly through full loops.

### Documentation cleanup

- Amend `docs/BUBBLE.md` so the authoritative full frame supersedes the roll-less pole trade.
- Remove/replace tests that explicitly expect >1 rad of pole spin.
- Correct stale comments claiming body yaw already preserves persisted U.

## Acceptance criteria

1. Full turn + full pitch for every shipped turn rate crosses both poles; it cannot settle in a near-vertical heading-spin attractor.
2. Per-tick full-frame angular motion is bounded by the commanded yaw plus pitch rotation, with a small floating-point tolerance.
3. Pure body yaw preserves U; pure pitch rotates N/U about W; the frame remains unit length and mutually orthogonal over long runs.
4. Pure-pitch full loops and ±π wire crossings remain continuous.
5. At 80°, 85°, 89°, 90°, and across 89°→91°, the hull and camera frame remain continuous—no one-tick 30–90° up-vector jump.
6. Held left/right retains the correct screen direction using the **actual rendered camera basis**.
7. Cosmetic bank never spikes or flips merely because Euler heading crosses a pole; it remains within authored `juice.bank.maxRad`.
8. Offline simulation and client prediction remain trajectory/frame identical.
9. Online delayed snapshots, correction, and replay preserve frame continuity without snaps.
10. Level-flight fixtures remain bit-identical where the new up vector starts at the legacy derived value.

## Rejected shortcuts

- Camera-only smoothing slows the invalid rotation and lets the camera basis diverge from the sim steering basis.
- Client-only parallel transport is history-dependent and cannot give every peer the same authoritative frame.
- Fading yaw by `|cos(pitch)|` restores a pole dead zone and loses constant turn authority.
- Reauthoring `maxPitchRad` below vertical removes full loops.
- World-up camera locking restores the previous pole flip/inverted-control defects.

The fix must preserve the complete frame through simulation and replication; anything less treats the visible symptom while retaining the broken attitude state.

## Implementation record (2026-07-30, Claude)

Implemented as specified — `shared/src/sim/frame.ts` (advanceFrame, spellAttitude,
transportUp, orthonormalizeUp, interpolateFrame, bodyYawDelta), persisted `up` on
`Transform3D`/`SteerState`/`ShipSnapshot`, `PlayerState.upX/upY/upZ` float32 with
`PROTOCOL_VERSION` 3, frame-carrying prediction/correction/interpolation, quaternion
hull pose with body-yaw cosmetic bank, frame-driven chase rig and radar, bot steering
from the persisted frame, and boundary reflection transporting the up. Acceptance
criteria 2–10 are pinned by `shared/src/sim/frame.test.ts` and the updated
steering/screenSteering/loopSteering/onlineLoop/chase suites. Two deliberate
amendments:

1. **Acceptance criterion 1 is amended, not met as written.** "Full turn + full
   pitch crosses both poles" is unsatisfiable under this document's own chosen
   integration: a constant body-frame angular rate is coning motion for any rigid
   body, so that input flies a fixed tilted circle (max pitch ≈ 40° for the shipped
   interceptor), exactly as a real hull would. What the criterion exists for IS
   met and pinned: the near-vertical heading-spin attractor cannot form, pitch
   oscillates smoothly, per-tick motion is bounded by the commanded rotation, and
   pure pitch still crosses both poles.
2. **`Quaternion.FromLookDirectionRH`, not `FromLookDirectionLH`.** Under the
   row-vector convention `node.rotationQuaternion` actually uses, Babylon's LH
   variant aims the model's −Z at the direction (measured on a NullEngine); the RH
   variant lands +Z on the nose and reproduces the legacy Euler pose bit-for-bit in
   the roll-less case (`client/src/game/shipOrientation.test.ts` pins the
   equivalence at every attitude and bank).

One consequence worth knowing when reading old fixtures: the heading/pitch SPELLING
for a nose is now chosen by agreement with the persisted up (`spellAttitude`), not
by nearest-to-previous-pitch — the history rule mis-picks within one integration
step of a vertical crossing. Tests that poke `tf.heading`/`tf.pitch` directly must
re-seed `tf.up` (`seedUp`) or they hand the sim an inconsistent frame.

