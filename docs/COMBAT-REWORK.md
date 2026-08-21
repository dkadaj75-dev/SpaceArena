# Combat Rework — manual trigger, armed modules, faster lock

> **HISTORICAL (2026-08-20).** This is the design spec as written on
> 2026-07-27, kept for the reasoning behind the manual trigger and the faster
> lock. Everything it says about **heat, cooling, lockouts and re-arm no longer
> describes the game**: the heat system was deleted outright on 2026-08-20 and a
> weapon is now limited by `fire.cycleTime` alone. The `heatsink` module family
> is now `countermeasure` and does nothing but launch a decoy. See
> `docs/CONTENT.md` for the current authoring contract.

Design spec for replacing auto-fire-on-lock with a **pilot-pulled trigger**, and for
making the lock itself land faster. Requested by the owner 2026-07-27. Extends
docs/FLIGHT.md and docs/BUBBLE.md — every invariant in both still stands, above all
the lock gate (FLIGHT.md §2) and the `flightStep` ⇄ NavigationSystem parity contract.

Design rule unchanged: NOTHING per-ship hardcoded. Every knob below flows through a
content config, a schema field, `resolveShipStats`, `tuning`, or `theme`.

## 1. Summary

Today a weapon you switched on shoots by itself the moment the sensors finish their
lock; the only combat decision a pilot makes is *which* modules are running. After
this change, switching a weapon on **arms** it, and nothing leaves the rails until
you pull the trigger — **left mouse button** on PC, a **FIRE button** in the current
boost slot on mobile. Locks also complete roughly 40 % sooner, so the gap between
"enemy in the reticle" and "enemy taking damage" closes from a couple of seconds to
under one. Shields and boost are untouched: a shield is still a toggle you leave
running, and boost is still hold-to-burn.

## 2. Current behavior (as-is)

- **Firing is automatic.** `combatSystem` (`shared/src/sim/systems/CombatSystem.ts:19-108`)
  walks every fitted module with a `fire` block in state `active`, decrements
  `cycleTimer`, and — given `ref.locked`, a live target, 3D range, LoS and energy —
  fires. The pilot is never consulted; line 41 is the whole lock gate
  (`if (!ref?.locked) continue;`). At most one shot per module per tick.
- **The only combat input is a toggle.** `Order` has exactly two members
  (`shared/src/sim/orders.ts:4-28`): the level-triggered `flight` order
  `{throttle, turn, pitchStick?, boost}`, and `{kind:"moduleToggle", hardpointIndex}`.
  `moduleSystem` (`shared/src/sim/systems/ModuleSystem.ts:22-28`) drains toggles and
  runs the retracted → deploying → active → retracting state machine.
- **HUD.** `ModuleButtons` (`client/src/game/hud/ModuleButtons.ts:167-170`) sends one
  `moduleToggle` per click; the button shows `state-*` classes, a deploy/cooldown
  ring, and a `no-energy` class. `BoostButton` (`client/src/game/hud/BoostButton.ts`)
  is a momentary hold anchored by `theme.hud.flight.boost`
  (`shared/src/schemas/theme.ts:178-187`), OR-ed with the Shift key in
  `FlightControls.ts:264-265`.
- **PC input.** `keyAxesFrom` binds only W/S and Shift (`client/src/game/hud/flightInput.ts:140-157`).
  `RelativeSteerInput` takes the mouse **only on button 2** (`RelativeSteerInput.ts:31`)
  and requests pointer lock on that press (line 50). **LMB is entirely unbound.**
- **Wire.** `orderSchema` (`shared/src/net/protocol.ts:129-150`) mirrors the two order
  kinds; `ArenaRoom.validateOrder` (`server/src/rooms/ArenaRoom.ts:605-635`) re-checks
  them for bots, who never cross the wire. Every inbound order — human or bot — is
  charged to a one-second budget of `tuning.maxOrdersPerSec` (`ArenaRoom.ts:654-664`),
  humans get kicked for sustained abuse, bots are simply dropped (`ArenaRoom.ts:538-553`).
- **Bots.** `planModuleOrders` (`shared/src/bots/moduleDiscipline.ts:60-104`) emits
  toggles from heat/energy/engagement rules; `BotDriver.update` (`BotDriver.ts:255,452`)
  appends them to its flight order. Bots have no fire decision because none exists.
- **Replication.** `PlayerState` already carries `throttle`, `lockProgress`, `locked`,
  `targetId`, and per-module `state`/`heat`/`cycleTimer`/`shieldPool`
  (`server/src/rooms/state/ArenaState.ts:22-95`).
- **Content.** `sensors.lockTimeSec` is 1.2 (interceptor), 1.6 (support), 2.2
  (brawler). Weapon `fire.mode` is the single-member enum `"autoTarget"`
  (`shared/src/schemas/module.ts:16-24`) — a placeholder that has never had a second
  value.

## 3. Target behavior (to-be)

**Armed, not auto.** "Active" keeps its exact current meaning — the `active` state of
the §2.3 module state machine, reached by `moduleToggle`. Nothing about selection is
new; what changes is that an active weapon is now *armed* rather than *firing*.

Rules:

1. **Any number of firing modules may be armed at once.** Do NOT introduce a
   one-weapon-at-a-time mode. The fitting already decides how many weapons a hull can
   carry, each already owns its own `cycleTime`, and a per-ship exclusive-selection
   rule is precisely the kind of per-ship behaviour the iron rule forbids. A pilot who
   wants a single weapon disarms the others — the existing toggle already expresses
   it, at the existing deploy/retract cost. There is no separate switching cost.
2. **The trigger fires every armed weapon that is ready.** One input, applied to all
   armed `fire` modules; each still gates on its own `cycleTimer`, range, LoS and
   energy. This keeps `combatSystem`'s loop shape and keeps the trigger a single bit.
3. **Firing still requires a lock — blocked, with feedback.** FLIGHT.md §2 is
   unambiguous ("all weapon kinds, no exceptions"), and it is load-bearing, not
   stylistic: beams apply damage straight to `targetId` and missiles are spawned
   carrying it (`CombatSystem.ts:72,93`). Dumb-fire is not a permission change, it is
   a new hit-resolution mechanic (a directional raycast, a proximity fuse) and a new
   balance surface. Recommendation: an unlocked trigger pull fires nothing, costs
   nothing, and produces an immediate **client-side** cue (reticle "NO LOCK" flash +
   an authored notification, §8). Revisit dumb-fire only as its own feature.
4. **Held, not tapped, by default.** Holding the trigger fires each armed weapon on
   its own cadence, exactly as auto-fire does today; releasing stops it. Semi-auto —
   one shot per press — is a per-module content choice via `fire.mode` (§9), intended
   for missiles, where a held trigger would empty a rack the pilot wanted to save.
   Ship the pack with lasers/kinetics `held` and missiles `semi`.
5. **Heat, energy and cooldowns are untouched mechanically.** `cycleTimer` keeps
   ticking down whether or not the trigger is held (`CombatSystem.ts:33-37` already
   does this, deliberately). `workedThisTick` still drives the whole cost model in
   `EnergySystem`: an armed-but-silent weapon pays `energy.drawIdle`, a firing one
   pays `drawActive` and accrues `heat.perSecondActive * dt`.
   **Flagged for the owner:** because heat accrues only on the single tick a shot
   leaves the tube, one laser-mk1 shot costs `6 × 1/30 = 0.2` heat against a threshold
   of 55 — weapon heat is already near-irrelevant today, and manual fire makes it more
   so. §9 proposes an explicit `fire.heatPerShot`; §12 asks whether to take it now.
6. **Shield is preserved exactly.** Shield-family modules have no `fire` block, are
   never consulted by the trigger, and keep toggle → `active` → `mitigation` +
   `shieldPool` regen. Zero code paths change for them.
7. **Boost is preserved exactly.** The boost MODULE keeps working as the boost button
   does today: `FlightState.boost` resolved against a fitted, active boost module with
   energy/heat headroom. Only the *screen position* of its input moves (§8, §12).

## 4. Faster targeting

Pure content, no code. All three knobs are already schema-backed and hot-reload
through the Balance Workbench and the Tuning panel.

| Ship | `lockTimeSec` now | proposed | rationale |
| --- | ---: | ---: | --- |
| interceptor | 1.2 | **0.7** | The knife-fighter should convert a snap merge; 0.7 s is about one pass through the cone at 34 u/s. |
| support | 1.6 | **1.0** | Keeps the class ordering intact, still slower than the interceptor. |
| brawler | 2.2 | **1.4** | The outlier, and the ship that feels worst today: 2.2 s of holding an 80° cone is longer than most merges last. |

- `coneDeg` stays as authored (60/70/80). The cone is the aiming skill; widening it
  would make the lock easier rather than faster, which is not what was asked.
- `tuning.lockDecayMult` 1.5 → **1.2**. With shorter warm-ups a lock is cheaper to
  re-earn, so a slightly softer break keeps a turning fight continuous instead of
  strobing. Content, `content/tuning/default.json`.
- `sensors.*` already flow through `resolveShipStats`, so a module or upgrade that
  shortens lock time keeps working, and the HUD ring stays correct — it normalizes
  against the ship's own resolved value (`ArenaSimulation.ts:502-506`).
- **Note the asymmetry** for the later balance pass: `STAT_PATHS`
  (`shared/src/sim/resolveStats.ts:21-34`) carries the three `sensors.*` entries but
  **no `fire.*` entries**, so weapon damage/range/cycle are read raw from the module
  JSON and cannot be touched by an upgrade or a utility passive. Targeting is
  tunable per fitting; weapons are not. Out of scope here, worth knowing before
  someone tries to balance this with an upgrade track.

## 5. Wire & sim changes

**Recommended: a `fire` boolean on the existing `flight` order.** Not a new
edge-triggered order kind.

```ts
{ kind: "flight"; throttle: number; turn: number; pitchStick?: number;
  boost: boolean; fire: boolean }
```

Why level-triggered, on the existing order:

- It is the same shape as `boost`, which is the same kind of input — a held button
  whose cost the sim charges per tick. FLIGHT.md §1 chose level-triggering precisely
  so held state survives packet loss; an edge-triggered `fireStart`/`fireStop` pair
  reintroduces the lost-edge problem (a dropped "stop" leaves a ship firing forever).
- It uses the existing flight-order budget. `FlightOrderSender`
  (`client/src/game/hud/flightOrders.ts`) sends boolean edges with no epsilon,
  applies a small fire-edge floor, and retains a final fixed-window guard at the
  effective `tuning.maxOrdersPerSec`.
- Semi-auto still works on a level signal: the sim latches a rising edge (see below),
  so one press = one shot even if the level is held.

**The one trap in this design, and its fix.** `FlightOrderSender` enforces a hard
floor between sends — `orderMinIntervalMs` (`client/src/game/hud/flightHudLayout.ts:505-510`),
the larger of the theme's `minIntervalMs` (shipped: 120 ms) and the flight half of
`tuning.maxOrdersPerSec` (`FLIGHT_ORDER_BUDGET_SHARE = 0.5`; the shipped tuning pack
never sets `maxOrdersPerSec`, so the server default of 20/s applies). A trigger press
riding that sender could therefore sit for up to 120 ms before it leaves the client —
plainly unacceptable for a shot. Give `fire` edges a smaller derived floor:
`min(minIntervalMs, 1000 / (effectiveMaxOrdersPerSec × FLIGHT_ORDER_BUDGET_SHARE))`,
clamped to at most 30 ms (below one sim tick). A fixed-window sender guard still
bounds all outbound flight traffic at the effective server cap. Add a sustained
15 press/release-pairs-per-second test that stays under that cap.

Changes:

- `shared/src/sim/orders.ts` — `fire: boolean` on the flight order, documented as
  held state like `boost`.
- `shared/src/sim/components.ts` — `FlightState.fire: boolean`, plus
  `FlightState.firePrev: boolean` (last tick's value) so semi-auto can detect the
  rising edge deterministically inside the sim rather than trusting the client to
  send one order per shot. `firePrev` is sim-internal and never replicated.
- `NavigationSystem` stores axes from the last valid order drained in a tick and
  ORs the drained `fire` flags for that tick. It retains the final ordered fire
  level for the next tick, so a sub-tick press/release is visible for exactly one
  combat tick. Movement still never reads `fire` — see §6.
- `CombatSystem` — replace the implicit auto-fire with an explicit trigger test,
  evaluated per module after the cycle timer and before the lock gate:
  `held` modules require `fs.fire`; `semi` modules require `fs.fire && !fs.firePrev`.
  A ship with no `FlightState` (unordered, or a practice dummy) never fires.
  `firePrev = fire` is assigned once per ship at the END of the tick, after
  CombatSystem, so every module in a fitting sees the same edge.
- `shared/src/net/protocol.ts` — `fire: z.boolean()` in the flight case of
  `orderSchema`. Required, not optional: unlike `pitchStick` (whose absence and whose
  centred value mean the same thing) an absent `fire` is genuinely ambiguous, and
  every sender in the tree is updated in the same change.
- `server/src/rooms/ArenaRoom.ts` — `validateOrder`'s flight case adds
  `typeof order.fire === "boolean"`, keeping the two sides of the trust boundary
  identical for bots. No new reject reason; a bad `fire` is `malformed` like any other
  bad axis.
- **Firing stays server-authoritative.** Nothing about the shot decision moves to the
  client.
- **No new replicated state.** The HUD's needs are already on the wire: armed =
  `ModuleState.state === active`, cooling = `ModuleState.cycleTimer > 0`, lock =
  `PlayerState.locked` / `lockProgress`, energy = `energyCur`. `ArenaState` is
  unchanged, which is the strongest argument for this design.
- **Events unchanged.** `projectileFired` / `FireEventMessage` already carry every
  shot; the manual trigger produces fewer of them, not different ones.

## 6. Prediction & parity

The client predicts **nothing** about firing. Shots are events from the server, as
they are today, and a trigger pull's only local response is HUD/audio juice (§8).

The parity contract is protected by one rule: **`fire` must never be read by
`NavigationSystem` or `flightStep`.** `flightStep`'s signature and body do not change,
so `shared/src/sim/steering.test.ts:52` ("flightStep ⇄ NavigationSystem parity") keeps
passing untouched, and `NetGameSession`'s predictor needs no change beyond passing the
extra field through when it echoes the local input. Add a parity test asserting that
two `flightStep` runs differing only in `fire` produce bit-identical trajectories, so
a future edit that reaches for the flag in the movement path fails loudly.

## 7. Bots

Bots must gain a fire decision or they stop shooting entirely — this is the one part
of the change that is not optional.

- New `shared/src/bots/fireDiscipline.ts`, mirroring `moduleDiscipline.ts`:
  `decideFire(ctx, configs, fireDiscipline, engaged) → { fire: boolean, reason }`.
  It returns a flag, not an order; `BotDriver` folds it into the flight order it is
  already building (`BotDriver.ts:439`), so bot order traffic does not rise at all
  and the existing budget/validation path (`ArenaRoom.ts:548-550`) is unchanged.
- Default rule: fire when **locked**, AND the target is inside the shortest range
  among the bot's armed weapons × `engageRangeMult`, AND every armed weapon's heat
  fraction is below `heatHeadroom`, AND `energyFraction >= minEnergyFraction`.
  Optional `burstSec`/`pauseSec` produce a human-looking trigger rhythm from the
  driver's own tick counter (never a wall clock — determinism, FLIGHT.md §1).
- `shared/src/schemas/botprofile.ts` gains a `fireDiscipline` object beside
  `moduleDiscipline` with those five knobs, all `.optional()` with documented
  defaults. Because it is a plain zod object of numbers, the Behavior Editor picks it
  up with no editor code (§9).
- Export a `FireDecisionReason` union like `ModuleDecisionReason` so
  `BotDebugOverlay` can show *why* a bot is holding fire.
- Bots gain no privilege: they cannot fire without a lock, and their orders go through
  the same `validateOrder`.

## 8. HUD / UX

All geometry theme-driven, all new DOM following the `ModuleButtons` contract (own
nodes, `HUD_CONTROL_ATTR`, layout from the resolved theme, portrait + landscape).

- **Module cluster states.** Extend the existing class set rather than inventing a
  second visual language: `state-active` now reads as ARMED (add an `armed` class so a
  theme can style it distinctly from today's "running"), plus `cooling` while
  `cycleTimer > 0` (drive the existing `--ring` from `cycleTimer / fire.cycleTime`,
  which the ring code already understands), and the existing `no-energy`. Add
  `unarmable` when the ship holds no lock, so a glance at the cluster explains why the
  trigger is doing nothing.
- **FIRE button (mobile)** takes the boost button's slot. New
  `theme.hud.flight.fire` block, identical in shape to `boostButtonSchema` (anchor,
  radiusPx, offsetXPx/YPx, icon), with the shipped theme giving it the boost button's
  current values. New `FireButton.ts` modelled on `BoostButton.ts` — momentary, with
  `HUD_CONTROL_ATTR` set. That attribute is not cosmetic: `RelativeSteerInput`'s touch
  path starts a steer drag on any free surface (`RelativeSteerInput.ts:33`), so without
  it, jabbing FIRE would yank the nose.
- **LMB (PC).** Confirmed free — `RelativeSteerInput` ignores anything but button 2
  (line 31) and `TacticalCamera`'s pan is dev-editor-only. Bind LMB-down/up on the
  game canvas to the trigger. Pointer-lock semantics are in our favour: while RMB is
  held the canvas holds pointer lock, and a locked element still receives LMB
  `pointerdown`/`pointerup`, so **steer and fire compose** — which is the whole point.
  Suppress the default context menu (already required for RMB steering) and call
  `preventDefault()` on the LMB press so no text selection starts on an unlocked
  canvas. Also bind a keyboard alternative (`space`) through `flightKeyOf`/`FLIGHT_KEYS`
  for accessibility and for players on trackpads.
- **Boost is a module toggle.** There is no standalone boost button or theme
  geometry. Clicking the fitted boost module toggles it like shield; desktop
  Shift is a convenience edge that toggles the first fitted boost module. A
  ship with no boost module has no boost control.
- **Juice.** No new subsystem: the trigger reuses `Haptics.ts` (a short pulse on a shot
  that lands, a distinct pattern for a blocked no-lock pull) and the existing audio
  cue path — a weapon's own sound already rides its `onFire` actions, so shots need
  nothing new. Add a `theme.audio.cues` entry for the blocked pull and an authored
  notification for the first no-lock pull of a match (the notification pipeline already
  handles rearm/duration; see the boundary warning in BUBBLE.md).

## 9. Content & schema changes

| Config type | Field | Notes |
| --- | --- | --- |
| module | `fire.mode` | Enum retired and replaced: `["held","semi","continuous"]` (`continuous` added in §13). See migration below. |
| module | `fire.heatPerShot` | **Optional**, nonneg. Heat added on the tick a shot fires, on top of the existing per-tick accrual. Fixes the "0.2 heat per shot" problem in §3.5 and gives manual fire a real trigger-discipline cost. Absent ⇒ exactly today's behaviour. |
| ship | — | No schema change. `sensors.lockTimeSec` values retuned (§4). |
| tuning | — | No new key. `lockDecayMult` retuned (§4). |
| theme | `hud.flight.fire` | New block, shape-identical to `hud.flight.boost`; also legal inside `hudOrientationSchema.flight` for portrait/landscape overrides, which comes free from `flightHudSchema` being reused there (`theme.ts:275-300`). |
| theme | `hud.flight.boost` | Removed; boost is represented only by its fitted module button. |
| theme | `audio.cues.fireBlocked` | Optional sound ref, omitting it silences the cue. |
| botprofile | `fireDiscipline` | New optional object (§7). |

**Editor coverage** is automatic and requires no editor code. `SchemaFormGen`
(`client/src/editor/SchemaFormGen.ts`) converts the zod schema to JSON Schema and
renders controls generically: objects become fieldsets, numbers with `min`/`max`
become bounded inputs, `z.enum` becomes a select, booleans a checkbox. Every field
above is one of those shapes. The rules a new field must follow: plain object /
number / boolean / enum (no `z.record` of author-defined keys — that needs a bespoke
`FieldRenderer`, which is why `botprofile.behaviors` has one), `.optional()` with the
default documented in the doc comment rather than baked in with `.default()`, and an
action-id array named from the `REFERENCE_TYPES` map if it should get a reference
picker. Given that, the Module, Ship, Theme, Tuning and Behavior editors all gain the
new fields the moment the schema lands.

**Migration / back-compat.** `fire.mode` is the only breaking field. Follow FLIGHT.md
§7's philosophy — replace, do not keep a gated legacy path:

- Update all six shipped weapon JSONs in the same commit (lasers + kinetics `held`,
  missiles `semi`). This is a six-file edit, not a migration problem.
- Bump `manifest.version`, and bump `PROTOCOL_VERSION` (`shared/src/constants.ts:5`,
  gated in `shared/src/content/pack.ts:158-175`) — a bundle authored before this change describes
  weapons the new sim cannot interpret, and per docs/CONTENT.md that constant exists
  exactly to make such a bundle fail loudly on import instead of half-loading.
- Accept `"autoTarget"` as a deprecated alias for `"held"` for exactly one release
  **only if** the owner has external packs in the wild. Default recommendation: do
  not, since the shipped pack is the only one that exists.

Note that the shipped balance shifts even with identical numbers: weapons now fire
only when a pilot asks, so sustained DPS falls and the effective heat/energy load of a
fitting falls with it. Expect a retune pass in the Balance Workbench after phase 3.

## 10. Test plan

- **Sim units** (`CombatSystem.test.ts`): armed + locked + `fire:false` fires nothing;
  `fire:true` fires; `held` fires repeatedly across cycles; `semi` fires exactly once
  for a held flag and again only after a release/press; `cycleTimer` still drains while
  the trigger is released; no lock + `fire:true` spends no energy and emits no event; a
  ship with no `FlightState` never fires; `firePrev` is per-ship and applies uniformly
  across a multi-weapon fitting.
- **Determinism/parity**: the `fire`-invariance case from §6 in `steering.test.ts`;
  re-record `Regression.test.ts` and `balanceRegression.test.ts` fixtures deliberately
  (the numbers MUST move — that is the feature).
- **Wire** (`ArenaRoom.test.ts`): a missing or non-boolean `fire` is `malformed`; a
  trigger pull consumes exactly one budget slot; the bot path rejects the same shapes.
- **Bots**: hold fire without a lock, open fire inside the envelope, stop above the
  heat headroom; a full bot match still produces kills in its existing tick budget.
- **HUD**: `FireButton` press/release maps to `fire` and carries `HUD_CONTROL_ATTR`; a
  FIRE press does not start a steer drag; LMB works while RMB steering is active; a
  fire edges use the sub-tick rate floor and remain under the effective cap; module buttons show
  armed/cooling/no-energy/unarmable correctly.
- **e2e smoke**: arm a weapon, pull the trigger, assert hull loss on the dummy — the
  current smoke would otherwise pass on a build where nothing can shoot at all.

## 11. Rollout phases

Each phase lands with tests green and the game playable.

1. **Content-only: faster lock.** §4 numbers plus `lockDecayMult`. No code. Shippable
   and reversible on its own, and it lets the owner feel the targeting half of the
   request before any of the rest exists.
2. **Sim + wire trigger.** `fire` on the order/FlightState/schema/validateOrder,
   `CombatSystem` trigger test, `fire.mode` schema swap and the six module JSONs, bot
   `fireDiscipline`. Client sends `fire: true` unconditionally at this stage, so
   behaviour is identical to today and the whole phase is invisible in play — which is
   what makes it reviewable.
3. **Client input.** LMB + space binding, `FireButton` in the boost slot, boost
   relocated per §12, theme blocks, order sender edge. This is the phase the player
   feels.
4. **HUD states + juice.** Armed/cooling/unarmable visuals, haptics, blocked-pull cue
   and notification.
5. **Balance pass + docs.** Retune in the Balance Workbench against the new fire
   cadence, decide `heatPerShot`, fold the outcome back into this document.
   - `fire.heatPerShot` is schema-complete but **UNAUTHORED**; shipped values must
     be decided explicitly in this balance pass.

## 12. Open questions for the owner

1. **Where does boost live on mobile once FIRE takes its slot?** (The one genuine
   ambiguity in the request.)
   - **(a) Relocated smaller boost button — recommended default.** Keep `BoostButton`
     exactly as it is and move it in the theme: mirror it to the opposite bottom
     corner, or park it just above FIRE at a smaller `radiusPx`. Zero new code, zero
     new gestures, one theme edit, and boost stays a deliberate held input.
   - (b) Double-tap-and-hold on the touch-steer area. No screen real estate, but it
     collides with the steer drag and reintroduces the tap-window tuning that FLIGHT.md
     §7 deliberately deleted (`doubleTapWindowMs`, `tapSlopPx`).
   - (c) An overdrive zone past 100 % on the throttle strip. Thematically the best fit
     — boost *is* throttle — but it makes boost a sticky lever rather than a momentary
     cost, which changes how the sim's energy/heat drain feels.
2. **Semi-auto for missiles?** Recommended yes (`fire.mode: "semi"` on both missile
   modules) so a held trigger cannot dump the whole rack. Say no and missiles simply
   stream at their 2.0-2.5 s cycle.
3. **Add `fire.heatPerShot` now, or defer to the phase-5 balance pass?**
   Recommended: add the optional schema field in phase 2 (free, back-compatible) and
   leave every shipped value absent until phase 5 decides the numbers.
4. **Does anyone hold an exported content pack?** If no (the expected answer), retire
   `fire.mode: "autoTarget"` outright with a `PROTOCOL_VERSION` bump. If yes, keep the
   deprecated alias for one release.

## 13. Continuous beam (`fire.mode: "continuous"`)

Requested by the owner 2026-07-27: *"In the laser modules, I want a laser also
that is 'continuous', basically it DPS."* A third `fire.mode` beside `held` and
`semi`. Everything in §3 still applies verbatim — this is a new *cadence*, not a
new permission model.

**Semantics.** While the trigger is HELD and the SAME gates pass (module
`active`, lock, live target, 3D range, LoS, energy), the weapon CHANNELS:
`fire.damage` is read as **damage per second** and applied as `damage * dt` every
tick. There are no shots, `cycleTimer` is never set, and the module is
`workedThisTick` on every channelling tick — which is the whole point, because
the existing cost model (`energy.drawActive` and `heat.perSecondActive`, both per
second) then charges it naturally. Release the trigger, break the lock, leave
range/LoS, retract or brown out, and the channel stops on the NEXT tick with no
lingering damage: every gate is re-evaluated from scratch each tick and there is
no ordnance in flight and no timer to run down.

**Schema.** `fire.cycleTime` stays **required** and positive for continuous
modules and is documented as ignored. Making it conditionally optional would
either turn `fire` into a union (which `SchemaFormGen` cannot render as a
fieldset) or hide the requirement behind an effect the JSON-Schema conversion
drops — and it would ripple `number | undefined` through every consumer that
reads it today. A `superRefine` on `moduleSchema` (same pattern as `shipSchema`,
so the editor is unaffected) rejects the one combination the sim cannot
interpret: `continuous` with a non-null `projectile`. `fire.heatPerShot` is a
per-shot field and does not apply.

**Replication & events.** One new replicated field: `ModuleState.channeling`
(boolean). No protocol change beyond it — the trigger already rides the flight
order. A channel emits **one** `projectileFired` (`kind: "beam"`, carrying
`onFire`) on its rising edge, then banks its `damage` / `shieldAbsorb` amounts
and flushes them as aggregate events every `CHANNEL_EVENT_INTERVAL_SEC` (0.25 s,
i.e. 4/s) — the damage itself still lands every tick, so throttling the events
costs nothing mechanically and the flushed totals sum exactly to the hull lost. A
lethal tick flushes first so the ledger reads damage-then-destroyed. The client
draws a persistent beam for as long as `channeling` is set, pinning one slot of
the existing beam pool and letting it fade out through `beamFadeMs` on release.

**Bots.** No new bot code. `decideFire` already emits a level-triggered held
flag, which is exactly what a channel consumes.

**HUD.** No cooldown ring (a channel has no cadence); `ModuleButtons` adds a
`channeling` class instead, currently unstyled.

**Content.** `module.beamlaser-mk1` ("Beam Mk1"), laser family, level 1, DPS 16
against pulse-laser-mk1's 17.5 sustained, range 34 vs 38, `drawActive` 20 and
`perSecondActive` 14 — the first shipped weapon whose heat is actually binding
(~11 s of channel to overheat on an interceptor). Deliberately in NO
`defaultFitting`, so every balance anchor in `balanceRegression.test.ts` is
unmoved.
# 2026-08-05 amendment — finite rack cooling and heatsink purge

Heat remains stored on each fitted module rack; the replicated ship pool and HUD
gauge remain the sum of those rack values. Once per simulation tick the ship's
resolved `heat.dissipation` (heat units/second) is shared across every hot rack,
including overheated/locked racks, in proportion to each rack's share of pool
heat. This makes cooling deterministic, fair across simultaneously hot racks,
and finite: ordinary state transitions never clear heat. The hull's authored
base dissipation is passive cooling when no heatsink is fitted, while heatsink
and utility-sink passive modifiers provide the quality ladder.

Overheat lockout timers retain their existing state-transition rules. Heat now
continues draining during lockout and is not reset when the timer expires.

The sole instant heat-removal path is a successful `jettisonCountermeasure` order.
Jettisonable sinks author `jettison.purgeAmount`; that bounded budget is removed
proportionally from hot racks (never below zero), then the existing decoy is
spawned and overheated racks receive the existing emergency re-arm behavior.
Unsuccessful/no-order jettison ticks do not purge heat.

# 2026-08-07 amendment — the heat/energy overhaul (per-module stores)

Everything above about a **ship heat pool** and a **shared capacitor** is
superseded. Both are gone from the schema, the sim, the snapshot and the wire.

## Why

The 2026-08-07 design audit measured what those two pools had become: over five
tuning passes weapon heat had been multiplied roughly twentyfold while hull heat
capacity never moved, so `laser-mk1` put a ship **120% of its entire capacity**
over the line with one shot, `criticalDamagePerSec` burned hull from there, and
holding the trigger at a target that never fired back killed the firer in
20.0 s / 36.7 s / 53.4 s. In a shipped five-minute practice match **58.8% of all
hull damage and 13 of 19 deaths were self-inflicted**, four of five stock
matchups had literally unbounded TTK, and the balance bench certified all of it —
it restored both hulls every tick, and `timeToKill()` reported an attacker's
suicide as "the defender is unkillable".

A pool that every module shares is also the wrong shape for the game: it makes a
second weapon a tax on the first, and it gives the HUD one number that cannot
tell a pilot *which* trigger to release.

## The model

**Heat is per weapon.** Every weapon owns a `heat` block:

| field | meaning |
|---|---|
| `capacity` | heat the rack holds before it locks itself out |
| `coolingPerSec` | passive cooling, before the hull's `cooling.multiplier` |
| `perShot` | heat added on the tick a discrete shot fires |
| `perSecondActive` | heat per second while a channel works |
| `rearmBelow` | fraction of capacity a lockout must decay to before re-arming |

Reaching `capacity` forces the rack `overheated`. **The lockout carries no timer
at all** — it ends when cooling brings the rack back under
`capacity × rearmBelow`, which is what makes the punishment proportional to how
hard the trigger was abused. There is no self-damage, no hull burn, no critical
state: the cost of cooking a rack is the seconds you do not have it. A ship can
no longer hurt itself by firing, and `balanceRegression.test.ts` asserts exactly
that on all three hulls.

Two identities do all the authoring work:

```
burn (s)     = (capacity - perShot) / (generation - cooling)
recovery (s) = capacity / cooling
duty         = cooling / generation          ⇒ sustained DPS = nominal × duty
```

Duty is independent of capacity, so a hull may carry deeper racks (longer
bursts, longer refills) without silently rebalancing its damage.

**Energy is per module.** Boost tanks, shield reserves and active utilities own
an `energy` block (`capacity`, `rechargePerSec`, `drawPerSec`, `rearmAbove`):
drain while the module works, refill while it rests, cut offline the tick it runs
dry, and refuse to come back up until the tank passes `rearmAbove` — the energy
twin of the heat re-arm, and what stops an empty afterburner from stuttering one
tick of thrust per three of trickle-charge. **Weapons cost no energy at all.** A
shield's reserve *is* its tank: every point it soaks spends a point of charge.

**Ship-wide levers.** Heatsinks author `cooling.multiplier` and generators
`recharge.multiplier`, both multiplicative across fitted modules and applied to
every module's own rate. Hulls carry `cooling` / `recharge` / `heatStore` /
`energyStore` multipliers in place of the deleted `energy` and `heat` blocks.
The transformer keeps its `efficiency` pair, now applied per module. Jettisoning
a heatsink **purges every rack to zero and clears every lockout** — the one
instant clear in the game, which is why it costs the sink.

## Replication

`ModuleSnapshot` (offline) and `ModuleState` (Colyseus) both carry `heat`,
`heatCapacity`, `energy`, `energyCapacity`. A capacity of 0 means "this module
has no ring of that kind", which is the only signal the HUD needs. `PlayerState`
lost `energyCur`/`energyMax`/`heatCur`/`heatCapacity` — there is nothing
ship-wide left to send.

## Shipped numbers (free kit: radiator ×1.6, plant ×1.25, light hull ×1.0)

mk1 weapons burn ~5 s and cool in ~2.5 s; mk2 ~6 s / ~2.3 s; mk3 ~7 s / ~2.1 s.
Boost tanks give ~3 s of afterburner and refill in ~6 s. A shield soaks its
reserve in ~4 s of focused fire and refills in ~8 s. Every stock matchup resolves
in 12.6–35.4 s, inside the 8–45 s design band, with no attacker ever killing
itself. Reproduce all three tables with:

```
node --import tsx tools/heat-feel-bench.ts
```

## Bench

`timeToKill()` now returns a discriminated `killed | attackerDied | neither` and
the matrix forbids `Infinity` anchors; `runEngagement()` never restores the
subject's hull and reports the hull it lost, which must be zero.
