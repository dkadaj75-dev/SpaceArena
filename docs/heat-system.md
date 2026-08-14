# Weapon heat system

## Status and kill switch

Weapon heat is a per-module system: every fitted module has its own runtime
`heat` and `heatCapacity`; there is no ship-wide heat pool. It is currently
disabled in the shipped pack by `content/tuning/default.json`:

```json
"featureFlags": { "heatSystem": false }
```

Set `featureFlags.heatSystem` to `true` in the active tuning config to restore
the previous behaviour. `heatSystemEnabled()` in
`shared/src/sim/tuningDefaults.ts` is the single runtime reader. It returns true
only for the literal boolean `true`, so omitted flags are safely off.

The authoritative sim reads it via `World.tuning`; the client HUD, notification
consumer, and audio consumer read the active tuning config from `ConfigService`.
This means a normal config replacement is observed by both offline simulation
and the relevant client presentation paths.

When disabled, `CombatSystem` does not add per-shot heat, `EnergySystem` skips
the complete heat step (per-second generation, cooling, trip, and re-arm), and
therefore an authoritative module cannot enter `overheated`. Existing runtime
and wire heat values are intentionally retained for compatibility. The weapon
ring is hidden, and the notification consumer defensively ignores an
`overheated` event in case one arrives from a stale or mismatched peer. Because
the authoritative sim emits no such event, its authored overheat sound has no
trigger while the flag is off.

## Feature map

### Schema and authored content

- `shared/src/schemas/tuning.ts` declares the generic `featureFlags` record;
  `heatSystem` is an authored key in the default pack, not a special schema
  field.
- `content/tuning/default.json` supplies the shipped `heatSystem: false` kill
  switch (and `showDebugOverlay`).
- `shared/src/schemas/module.ts` defines a module's `heat` block: `capacity`,
  `coolingPerSec`, `rearmBelow`, `perShot`, and `perSecondActive`; its invariant
  checks enforce valid ranges and heat/fire relationships. The same schema also
  defines heatsink cooling and jettison purge authoring.
- Weapon module heat blocks are authored in `content/modules/beamlaser-mk1.json`,
  `beamlaser-mk2.json`, `beamlaser-mk3.json`, `kinetic-longbarrel.json`,
  `kinetic-mk1.json`, `kinetic-mk2.json`, `kinetic-mk3.json`,
  `laser-burst.json`, `laser-mk1.json`, `laser-mk2.json`, `laser-mk3.json`,
  `missile-heavy.json`, `missile-mk1.json`, `missile-mk2.json`,
  `missile-mk3.json`.
- Cooling/jettison-related module data is in `content/modules/heatsink-ablative.json`,
  `heatsink-basic.json`, `heatsink-cryo.json`, `heatsink-mk2.json`,
  `heatsink-mk3.json`, `utility-heat-sink.json`, and
  `utility-heat-sink-mk2.json`.
- `content/actions/notify-overheat.json`,
  `content/actions/play-sound-overheat.json`, and
  `content/notifications/overheat-warning.json` provide the authored warning
  and sound route. `content/effects/overheat-vent.json` and
  `content/upgrades/heat-std.json` are also heat-named content that must be
  reviewed during removal.

### Simulation and runtime state

- `shared/src/sim/tuningDefaults.ts` owns `heatSystemEnabled()`.
- `shared/src/sim/systems/CombatSystem.ts` adds `heat.perShot` on both discrete
  firing paths when enabled. Continuous weapons mark themselves worked here;
  their per-second cost is billed later.
- `shared/src/sim/systems/EnergySystem.ts` owns the gated `stepHeat`: active
  generation, cooling, capacity trip, `overheated` event emission, and
  hysteretic re-arm below `rearmBelow`.
- `shared/src/sim/systems/ModuleSystem.ts` contains the `overheated` member of
  the module state machine and the transition helpers used on trip/re-arm.
- `shared/src/sim/components.ts` declares `ModuleRuntime.heat` and
  `heatCapacity`; `shared/src/sim/spawn.ts` resolves capacity from module heat
  config and hull heat-store multipliers at spawn.
- `shared/src/sim/systems/JettisonSystem.ts` purges all module heat and clears
  an existing overheat lockout when an ablative heatsink is jettisoned.
- Related supporting paths include `shared/src/sim/events.ts` (`overheated`),
  `shared/src/sim/signals.ts` (hottest-rack signal), and heat-aware bot policy
  in `shared/src/bots/context.ts`, `fireDiscipline.ts`, and
  `moduleDiscipline.ts`.

### Network and presentation

- `shared/src/net/protocol.ts` replicates each module's `heat` and
  `heatCapacity`, along with the `overheated` state enum.
- `client/src/game/hud/ModuleButtons.ts` shows the per-weapon heat ring and
  `ring-heat`/danger classes only while the flag is enabled.
- `client/src/game/hud/Gauges.ts` aggregates module heat for the heat gauge
  model and overheat notification state.
- `client/src/game/hud/Notifications.ts` resolves authored overheat actions to
  toast notifications and suppresses overheat events while disabled.
- `client/src/audio/AudioFeedback.ts` resolves the overheat action/theme cue;
  `client/src/audio/soundIds.ts` maps `overheated` to `module.onOverheat`.
  Both remain dormant because the disabled authoritative sim never emits that
  event.
- `client/src/game/hud/Haptics.ts` has an optional overheat haptic pattern; it
  remains retained with the rest of the dormant feature.

### Tests and tools

- `shared/src/sim/heatFeel.test.ts` measures burn, cooldown, and uptime feel.
- `shared/src/sim/systems/EnergySystem.test.ts` tests the heat step, including
  the disabled kill switch; `ModuleSystem.test.ts` tests lockout/re-arm; and
  `Combat.test.ts` tests per-shot and continuous costs.
- `shared/src/sim/systems/Jettison.test.ts` covers heat purge; the balance
  regression suite also deliberately enables heat.
- `client/src/game/hud/ModuleButtons.test.ts` covers enabled and disabled ring
  rendering.
- `tools/heat-feel-bench.ts` is the standalone feel benchmark.

All heat-dependent simulation tests explicitly call
`loadTestConfigs({ heatSystem: true })`; `shared/src/sim/testutil.ts` applies
that fixture override through schema-validated config replacement.

## Permanent deletion checklist

Do this only after the flag has remained off long enough to retire compatibility
with clients/servers that still understand the fields.

1. Remove `heatSystemEnabled()` from `shared/src/sim/tuningDefaults.ts`, remove
   `heatSystem` from `content/tuning/default.json`, and delete any tests or docs
   describing the flag. Keep or remove generic `featureFlags` only according to
   its other consumers (for example `showDebugOverlay`).
2. Delete the `heat` schema block and every heat-specific invariant in
   `shared/src/schemas/module.ts`. Remove heat-store/cooling schema fields and
   jettison purge fields only if the associated heatsink design is being
   retired too; otherwise redesign those features first so their schemas do not
   retain dead heat references.
3. Remove `heat` blocks from every weapon JSON listed above. Remove or redesign
   heatsink/utility heat-sink module fields, `heat-std` upgrade, overheat vent
   effect, and the overheat notification/action/sound content; update the
   content manifest/reference graph as required and run content validation.
4. Remove `heat`, `heatCapacity`, and `overheated` from `ModuleRuntime` and all
   component comments in `shared/src/sim/components.ts`; remove spawn-time heat
   capacity resolution from `shared/src/sim/spawn.ts` and hull heat-store stat
   resolution if it then has no users.
5. Delete `stepHeat` and its call/import from `EnergySystem.ts`; delete
   per-shot additions from both `CombatSystem` firing branches and adjust its
   continuous-weapon comments. Remove `overheated` transitions/guards from
   `ModuleSystem.ts`, `JettisonSystem.ts`, events, signals, and bots.
6. Change `shared/src/net/protocol.ts` in one coordinated protocol version:
   remove heat fields from snapshot encode/decode and `overheated` from the
   state mapping. Update server/client compatibility policy before deploying;
   old peers cannot safely decode a changed packed layout without a version
   boundary.
7. Remove HUD heat ring and gauge aggregation (`ModuleButtons.ts`, `Gauges.ts`,
   and their styling in `hudStyle.ts`), notification/audio/haptics overheat
   handling (`Notifications.ts`, `AudioFeedback.ts`, `soundIds.ts`,
   `Haptics.ts`), and the overheat theme schema/config entries.
8. Delete heat tests, fixtures, balance expectations, and
   `tools/heat-feel-bench.ts`; update broader bot, signal, protocol, and content
   tests that construct module snapshots or enumerate legal states.
9. Search the whole repository for `heat`, `overheat`, `heatsink`,
   `heatCapacity`, `onOverheat`, and `ring-heat`; resolve every remaining result
   intentionally. Finally run typecheck, full test suites, and content
   validation after the protocol/content migration.
