# SpaceArena review: commits dated 2026-08-01 through 2026-08-04

## Executive summary

The reviewed range contains 29 commits, although the review request describes 30. I inspected the actual patch for every commit returned by `c9d70fa..HEAD`, including the integration commits whose patch is empty because their changes are already present through an earlier parent, and followed the affected paths in the current tree.

The three prior-review fix commits do resolve the reported defects. Home-flag contact resolution, online objective/decoy replication, Hangar refresh versioning/cancellation, failed model retry, bounded Hangar preview movement, and flag-material disposal are all fixed in the current tree. The prior performance findings were not fixed by those commits and mostly remain.

This review found three concrete current correctness defects:

1. **High:** the shipped mode named “Capture the Flag — 5v5” declares `teams: "2v2"`. Offline practice happens to create 5v5 through a nine-bot roster, but the authoritative room uses the `teams` field to cap the room at four clients and backfill only two ships per team. The same gamemode therefore changes team size depending on launch path.
2. **Medium:** the dedicated BOOST control blocks pointer input while carrying a flag, but the Shift shortcut bypasses the same rule and still toggles the module. Activating it can shed other modules through the power rail even though boost is unusable.
3. **Medium:** Lunar Crater renders displaced terrain relief while simulation collision remains a flat `floorY` plane. Depending on the deterministic height sample, ships either penetrate visible ridges or hover above visible depressions.

The largest performance issues are continuing per-tick snapshot object graphs, newly duplicated snapshots in server bot rooms, per-patch objective/trail allocations, per-frame trail resampling and GPU line writes, and a synchronous multi-million-iteration terrain texture generator on arena rebuilds.

## Review basis

The requested command produced 29 entries (`git rev-list --count c9d70fa..HEAD` also returns 29):

```text
f803f6b 2026-08-03 Lunar sky: Earthrise and the Orion Arm (#21)
09144fc 2026-08-04 Regenerated lunar sky: gibbous Earthrise and a visible Orion Arm
19b6da6 2026-08-04 Brighten the lunar galactic band into a visible Milky Way river
7370fea 2026-08-04 Lunar sky palette: Earthrise and the Orion Arm
49065bd 2026-08-03 Real lunar terrain floor; skybox vertical-flip fix; shell-only shield (#20)
9f9abcf 2026-08-03 The floor is terrain, not a shield — and the sky was upside down
07d1f4d 2026-08-03 Domed arenas: floorY on sphere bounds; Lunar Crater grows to radius 180 (#19)
9d55d61 2026-08-03 Lunar Crater becomes a domed crater: bigger, floored at the horizon
d913f9d 2026-08-03 Sphere arenas learn an optional floor: the dome above floorY
0e48285 2026-08-03 Lunar soil for Lunar Crater, single CTF mode, ordered mode list (#18)
036bf6e 2026-08-03 Lunar Crater gets real lunar soil; CTF collapses to one mode
6f8db28 2026-08-03 Two example maps authored via the builder prompt
0e20184 2026-08-03 Builder prompt for authoring importable arenas
ab3ea2f 2026-08-03 Lunar Crater: new 5v5 CTF arena and practice gamemode (#17)
a064edc 2026-08-03 Lunar Crater: new 5v5 CTF arena and practice gamemode
a02dc08 2026-08-02 Boost gets a real control in the flight HUD
08b3abc 2026-08-02 Bots miss like pilots, and a blocked carrier waits instead of orbiting
4fa08c5 2026-08-01 CTF carriers no longer pin themselves to the centre rock
8c6a3fc 2026-08-01 Hangar: readable characteristics labels, one set of ship arrows
3a3caf5 2026-08-01 Apply PWA updates at the next safe moment
bf4407f 2026-08-01 Lint: type the module config lookups in ModuleSystem tests
8e8cdf0 2026-08-01 Regression test: a flag carrier delivers from a broadside approach
202645a 2026-08-01 CTF bases glow: an objective beacon shell on every flag home
ad327ff 2026-08-01 Balance: module rail draw halved, heat generation quartered
b8104da 2026-08-01 CTF wayfinding: flags and bases marked in the central HUD and on the minimap
1956d0b 2026-08-01 HUD long-text overlays fit portrait screens
5a7c01f 2026-08-01 Hangar refreshes are cancelable and versioned; stale responses never apply
e10f04a 2026-08-01 Online play replicates CTF flags, heatsink decoys, and capture scores
9cf22fc 2026-08-01 Fix four defects flagged by the retro review
```

I read the amendments at the top of `docs/FLIGHT.md`, `docs/BUBBLE.md`, and `docs/CONTENT.md` before reviewing. I also inspected each commit with `git show`, then reviewed its current production consumers rather than relying on its subject. The `(#17)` through `(#21)` integration commits have empty or duplicate effective patches in this ancestry; their corresponding implementation commits were still inspected in full.

Automated validation could not be executed in this checkout because dependencies are absent. `npm run validate:content` stops immediately with `sh: 1: tsx: not found`, before content validation or Vitest begins. Findings below are therefore based on source/content tracing and arithmetic, not a claimed passing local test run.

## Verification of the 2026-08-01 review fixes

### 1. Friendly home-flag contact blocking enemy pickup — fixed

Current location: `shared/src/sim/systems/CtfSystem.ts:64`

The home-friendly branch now continues scanning contacts; it breaks only after returning a dropped flag:

```ts
if (team === flag.team) {
  if (flag.state === "dropped") {
    sendHome(world, flagId, flag, shipId, false);
    break;
  }
  continue;
}
```

`shared/src/sim/systems/Ctf.test.ts` includes simultaneous friendly/enemy overlaps in both entity-ID orders. A lower-ID defender can no longer shield a home flag.

### 2. Online snapshots discarding flags, decoys, and captures — fixed

Current locations: `server/src/rooms/state/ArenaState.ts:132-160`, `server/src/rooms/ArenaRoom.ts:826-863`, `client/src/net/NetGameSession.ts:830-860`

The room schema now carries decoys, flags, carrier/drop state, and per-team captures. `ArenaRoom.writeState()` creates, updates, and removes authoritative entries, and `NetGameSession.decode()` consumes them instead of substituting empty arrays. The client reconstructs bounded flag wakes because full breadcrumb trails are intentionally not sent.

The original invisible-heatsink and invisible-online-CTF divergence is resolved. The new replication path has allocation costs discussed below, but it is functionally present end to end.

### 3. Hangar refresh responses overwriting newer/hidden state — fixed

Current locations: `client/src/game/HangarApi.ts:57-77`, `client/src/game/screens/Hangar.ts:398-540`

`HangarRefreshScope.begin()` aborts the previous read and advances a version. `show()` and `hide()` invalidate the scope and visit token; results apply only while the signal/version and visit remain current and the Hangar remains visible. Stored-fitting restoration additionally checks the fitting-context token and current ship.

The auth refresh race, ship-change race, hidden-screen mutation, and disposed-screen continuation described in the prior review no longer apply to inventory refreshes. Mutation requests themselves are not aborted, which is appropriate because a purchase/save/delete may already have committed server-side; their UI catch paths guard hidden visits.

### 4. Failed Hangar model loads permanently cached as requested — fixed

Current location: `client/src/game/screens/Hangar.ts:567-578`

```ts
this.modelsRequested.add(loadingFor);
void this.assets.ensureModel(ship.render).then((loaded) => {
  if (!loaded) {
    this.modelsRequested.delete(loadingFor);
    return;
  }
  ...
});
```

A failed load clears the request marker, so a later rebuild/visit retries. Successful loads remain cached by the asset registry and do not loop.

### 5. Hangar preview motion being frame-rate-dependent and unbounded — fixed

Current locations: `client/src/game/screens/Hangar.ts:696-718`, `client/src/game/screens/Hangar.ts:398-406`

The preview position is now derived from elapsed time:

```ts
this.previewClock += dtMs / 1000;
const wave = Math.sin(this.previewClock * 0.6);
this.idleCur.pos.x = wave * 0.35;
```

`resetIdlePreview()` resets clock and snapshots on entry and preview rebuild. The position is bounded to ±0.35 and has the same period at every refresh rate.

### 6. Flag marker material leak — fixed

Current locations: `client/src/game/EntityView.ts:1009-1018`, `client/src/game/EntityView.ts:962-971`

`FlagView` now owns both marker and beacon materials, and `disposeFlagView()` explicitly disposes them on flag removal and full `ViewManager.dispose()`. The previous accumulation in `scene.materials` is resolved; the newly added beacon material follows the same ownership rule.

### Prior performance items — mostly not resolved

The three fix commits were correctness/lifecycle changes, not the optimization pass proposed by the prior review:

- **CTF trail cumulative allocation:** not fixed. `flagTrail.ts:53-59` still creates `const cumulative: number[] = [0]` and pushes into it on every resample.
- **Unchanged trail GPU updates:** not fixed. `EntityView.ts:698-703` still resamples and calls `MeshBuilder.CreateLines(... instance: view.trail)` every render frame whenever a trail exists, with no version/change check.
- **Snapshot object graphs:** not fixed. `ArenaSimulation.ts:700-799` still maps all ships/modules/asteroids/projectiles/decoys/flags/trail points/scores into fresh arrays and objects on every snapshot.
- **Repeated linear lookups:** not fixed. Examples remain in `FlightControls.ts:599-602`, `EntityView.ts:711`, and the interpolation/network paths.
- **Minimap alpha/path churn:** not materially changed; CTF wayfinding adds more contacts to the same redraw path.
- **HUD retained-write discipline:** improved locally. `BoostButton` and the expanded `EnemyArrows` pools cache their DOM values. There is still no shared retained-widget abstraction and other HUD consumers retain the earlier inconsistent behavior.
- **Hangar DOM/stat recomputation:** not fixed. The screen still reconstructs substantial panel DOM and repeats fitting/stat work during renders and previews.

## 1. Code review

### High-severity defects

#### 1. The shipped “5v5” gamemode is authoritative 2v2 online

Locations: `content/gamemodes/practice-ctf-5v5.json:5-7`, `server/src/rooms/ArenaRoom.ts:214-215`, `shared/src/bots/roster.ts:56-59`, `client/src/game/GameSession.ts:169-201`

The content says:

```json
"name": "Capture the Flag — 5v5",
"teams": "2v2",
```

The server treats that field as authoritative:

```ts
this.maxClients = gamemode.teams === "2v2" ? 4 : 2;
this.minPlayers = Math.max(1, options.minPlayers ?? this.maxClients);
```

and backfill uses the same two-player team size:

```ts
export function teamSizeOf(gamemode: GamemodeConfig): number {
  return gamemode.teams === "2v2" ? 2 : 1;
}
```

Offline practice masks the mismatch: `GameSession` expands the explicit roster of four team-0 bots and five team-1 bots without consulting `teams`; with the human on team 0 this produces 5v5. An authoritative room ignores that static roster and fills only up to `teamSizeOf(gamemode)`.

Concrete failure scenario:

- Launch the lobby’s offline CTF button: one human + nine authored bots produces 5v5.
- Join or directly create an authoritative room using the same public gamemode ID (the newly reviewed network path supports CTF).
- The room admits at most four human clients; after backfill it contains two ships per team.
- Players selecting the same “Capture the Flag — 5v5” content get a 2v2 match depending solely on transport path.

This is not just a label issue: `teams` is restricted by schema to `"1v1" | "2v2"`, so the content model cannot currently express the shipped contract. Extend team-size representation (for example an integer per team or `"5v5"`), make room capacity/backfill consume it, and validate roster counts/spawn counts against it. If this mode is intentionally offline-only, encode that capability explicitly and reject authoritative joins rather than allowing a different game.

### Medium-severity defects

#### 2. Shift bypasses the BOOST control’s carrier lockout

Locations: `client/src/game/hud/FlightControls.ts:163-173`, `client/src/game/hud/FlightControls.ts:523-550`, `client/src/game/hud/BoostButton.ts:82-93`, `shared/src/sim/systems/ModuleSystem.ts:74-106`

The dedicated pointer control refuses carrier input:

```ts
if (hardpointIndex === null || this.state.blocked) return;
this.onToggle(hardpointIndex);
```

The Shift path does not know or check `blocked`:

```ts
if (key === "shift" && this.boostHardpointIndex !== null) {
  this.toggleBoost(this.boostHardpointIndex);
}
```

`refreshBoostState()` computes the correct carrier state only for `BoostButton.update(...)`; it is not retained for the keyboard handler. The order still enters the generic module state machine. Bringing a boost module online calls `clearRailFor`, which may immediately retract active sibling modules to make rail capacity.

Concrete failure scenario:

- A flag carrier has an inactive boost fitted and a full rail occupied by weapons/shield.
- The on-screen BOOST button is visibly disabled and pointer taps do nothing.
- The carrier presses Shift.
- A `moduleToggle` is sent anyway. The boost deploys and can shed a weapon or shield through `modulesToShedFor`, while `NavigationSystem.resolveBoostMult()` still refuses the carrier any speed multiplier.

The result is a platform-dependent gameplay penalty and contradicts the control’s own explanation. Store the current carrier-blocked state in `FlightControls` and make `toggleBoost()` the single guard for pointer and keyboard paths. A test should assert that neither input emits an order while blocked and that both resume after the flag is dropped.

#### 3. Visual Lunar terrain and the physical floor are different surfaces

Locations: `client/src/core/SceneBuilder.ts:609-639`, `client/src/core/SceneBuilder.ts:739-781`, `shared/src/sim/systems/CollisionSystem.ts:164-180`

The renderer displaces every terrain vertex above or below `floorY`:

```ts
positions.push(x, terrainHeight(x, z, radius), z);
...
floor.position.y = floorY;
```

with height reaching roughly the sum of the authored noise amplitudes before edge taper:

```ts
const broad = valueNoise(...) * 1.35;
const fine = valueNoise(...) * 0.55;
return (broad + fine) * edgeTaper;
```

The simulation knows only the flat plane:

```ts
const floorLimit = bounds.floorY === undefined ? undefined : bounds.floorY + col.radius;
if (floorLimit !== undefined && tf.pos.y < floorLimit) {
  outward = { x: 0, y: -1, z: 0 };
  penetration = floorLimit - tf.pos.y;
}
```

Concrete failure scenario:

- Fly a ship down until its collider rests on Lunar Crater’s `floorY = 0` plane.
- At a positive terrain sample, the visible regolith is up to about 1.9 units above the collision plane and intersects the lower hull before collision stops it.
- At a negative sample, collision stops the collider against an invisible plane above the visible depression, leaving the hull hovering.

The bump texture is correctly cosmetic; displaced mesh geometry is not. Either keep the mesh vertex plane flat and put relief solely in normal/bump/albedo shading, or make the same deterministic height function part of shared collision and projectile rules. The former is much cheaper and preserves `floorY`’s documented planar contract.

## 2. Performance review

### 4. Server bot rooms construct three complete snapshots per tick

Locations: `server/src/rooms/ArenaRoom.ts:558-572`, `server/src/rooms/ArenaRoom.ts:705-717`, `shared/src/sim/ArenaSimulation.ts:700-799`

`driveBots()` starts with:

```ts
const snapshot = this.sim.snapshot();
```

After bot orders and the simulation tick, `update()` calls `writeState()`, which obtains another snapshot, then calls `this.sim.snapshot()` again for timer/countdown/team scores. A bot-backed authoritative room therefore constructs three complete snapshot object graphs per 30 Hz tick; a room without bots constructs two.

Each snapshot copies every ship and module, all projectile/decoy/flag objects, every flag trail point, and team scores. At 10 ships, two flags, and 30 Hz, the room needlessly constructs hundreds of arrays/objects per second before Colyseus serialization. Compute one pre-tick bot view only if bots need it, then have the post-tick `writeState` return or accept the single post-tick snapshot used by timer/scores. Longer term, give bot drivers a stable read-only view rather than a presentation/network snapshot clone.

### 5. Objective replication allocates sets, key arrays, and trail graphs at 30 Hz

Locations: `server/src/rooms/ArenaRoom.ts:802-863`, `client/src/net/NetGameSession.ts:965-1027`

Every server write creates separate `Set<string>` instances for missiles, decoys, and flags, then creates spread arrays of schema keys for deletion sweeps:

```ts
const liveFlags = new Set<string>();
...
for (const key of [...this.state.flags.keys()]) ...
```

On the client, every flag decode creates another `Set<number>`, maps a new flag array, allocates each decoded position/home object, and `FlagTrailAccumulator.update()` both pushes cloned positions and returns a full `trail.map(point => ({ ...point }))` copy. This happens even when a patch changed an unrelated field.

Use generation marks or reusable live-key sets in the room. On the client, retain a fixed-size trail buffer per flag and expose an immutable/versioned view; only append when quantized flag position changes. Avoid converting schema maps to `[...values()]` on every decode where an indexed loop can fill reusable arrays.

### 6. CTF trails still allocate and rewrite geometry every render frame

Locations: `client/src/game/flagTrail.ts:53-59`, `client/src/game/EntityView.ts:698-703`

The prior review’s hot path is unchanged. For every visible trail and render frame it allocates a cumulative-distance array, performs repeated square roots, rewrites 24 Babylon vectors, and updates the line vertex buffer even when no network/simulation snapshot changed.

Give `FlagSnapshot` or the client accumulator a trail version. Cache the last rendered version in `FlagView`; resample and update the line only when it advances. Supply a reusable numeric cumulative scratch buffer or keep the network accumulator already sampled to the renderer’s fixed 24 points.

### 7. Lunar terrain generation is a synchronous arena-rebuild hitch

Locations: `client/src/core/SceneBuilder.ts:609-639`, `client/src/core/SceneBuilder.ts:789-837`

On the high path, arena construction creates two 512×512 dynamic textures. For every one of 262,144 pixels, it computes three value-noise layers and loops over 34 craters with `Math.hypot`; that is about 8.9 million crater-distance evaluations plus noise/hash work, synchronously on the main thread. It also creates two 1 MiB `ImageData` buffers before GPU upload. Quality changes and relevant content hot reloads rebuild the arena and repeat the work.

The result is a visible frame/transition stall on mobile-class CPUs, precisely when changing quality is meant to recover responsiveness. Pre-generate the albedo/normal texture as a content asset, or generate it once per quality/seed in a worker and cache it. If terrain returns to a flat physical plane as recommended above, the mesh can also be a simple disc rather than a 4,481-vertex/roughly 26k-triangle displaced grid.

### 8. New objective wayfinding adds per-frame linear scans

Locations: `client/src/game/hud/FlightControls.ts:402-443`, `client/src/game/EntityView.ts:709-713`

Wayfinding performs two passes over flags after the ship pass, and removal performs `cur.flags.some(...)` for every retained flag. At two flags this is small, but it extends the prior project-wide pattern of repeated linear lookups. More important is that flag projection uses raw current flag positions while ships are interpolated; online flags therefore visibly step at patch cadence while surrounding ships move smoothly.

Build ID-indexed snapshot views once and interpolate objective positions just like ships, or explicitly mark objectives as patch-stepped and update HUD/3D geometry only on objective version changes. The latter pairs naturally with the trail optimization above.

## Maintainability and contract observations

### Team size is encoded in a closed label instead of a numeric rule

The 5v5 defect exists because `gamemodeSchema` accepts only `"1v1" | "2v2"` while roster counts and spawn counts are independently unbounded. Capacity, backfill, offline roster construction, UI naming, and geometry can disagree without validation. Team size should be data with one semantic consumer, and content validation should require enough spawn points and reject rosters that overfill a team unless an explicit exception is intended.

### Online/offline capability boundaries improved but remain implicit in the lobby

CTF and decoys are now genuinely replicated, so the prior silent capability gap is gone. The lobby nevertheless classifies any gamemode with `bots.roster` as offline-only and omits it from Online (`Lobby.ts:154-170`), while the room accepts the same gamemode ID if called directly. A `launch: { offline, online }` or equivalent capability field would make availability deliberate and would have exposed the 5v5/2v2 conflict during validation.

### Arena authoring documentation and shipped validation have drifted

The builder prompt says a map’s practical ceiling is 300 and describes the current geometry tests, but the current `docs/CONTENT.md` top still states that the pack contains two arenas while the manifest now contains five. This is documentation drift rather than a production correctness defect, so it is not counted above, but it weakens the requested “current contract” role of that amendment and should be corrected with the next content-doc pass.

## 3. Prioritized recommendation and optimization plan

### Do soon

| Order | Work | Where | Expected payoff | Effort |
|---:|---|---|---|:---:|
| 1 | Make team size represent 5v5 end to end; update room capacity/backfill and validate roster/spawn counts. If CTF is offline-only, encode and enforce that instead. | `shared/src/schemas/gamemode.ts`, `shared/src/bots/roster.ts`, `server/src/rooms/ArenaRoom.ts`, CTF gamemode content | Removes transport-dependent match rules and makes the shipped mode truthful. | M |
| 2 | Put the carrier lockout in the shared `toggleBoost` path used by touch and Shift; add both-input regression tests including full-rail siblings. | `FlightControls.ts`, `BoostButton.test.ts`, flight-input tests | Prevents unusable boost from shedding combat modules and restores input parity. | S |
| 3 | Make Lunar’s rendered floor geometrically flat and keep relief in textures/normals, or share terrain height with collision. | `SceneBuilder.ts`, floor collision tests | Eliminates visible hull penetration/hovering and preserves the `floorY` contract. | S for flat geometry; L for shared heightfield collision |
| 4 | Reuse one post-tick snapshot in `ArenaRoom`; avoid an extra snapshot after `writeState`, and design a cheaper bot read view. | `ArenaRoom.ts`, `ArenaSimulation.snapshot()` | Immediate server GC/CPU reduction in the new 5v5 bot mode. | S–M |
| 5 | Version flag trails and update resampling/GPU geometry only when the trail changes; reuse cumulative scratch storage. | `NetGameSession.ts`, `flagTrail.ts`, `EntityView.ts` | Removes persistent render-frame allocation and vertex-buffer writes. | M |
| 6 | Move lunar regolith texture generation out of synchronous rebuilds; ship/cache generated textures. | `SceneBuilder.ts`, `content/` | Removes multi-million-operation quality/arena transition stalls. | M |

### Next optimization and maintainability pass

| Order | Work | Where | Expected payoff | Effort |
|---:|---|---|---|:---:|
| 7 | Replace per-tick live `Set` + spread-key deletion sweeps with reusable generation marks or retained sets. | `ArenaRoom.writeState()` | Reduces authoritative-room allocation churn for missiles/decoys/flags. | M |
| 8 | Retain objective decode buffers and trail points; copy only on quantized position changes. | `NetGameSession.ts` | Reduces patch-time object graphs and makes trail versions natural. | M |
| 9 | Add explicit gamemode launch capabilities and consume them in Lobby and room validation. | gamemode schema/content, `Lobby.ts`, room creation | Makes online/offline support auditable instead of inferred from bot rosters. | M |
| 10 | Build ID-indexed lookup tables once per snapshot and share them with HUD/view interpolation. | session snapshot layer, HUD, `EntityView` | Removes repeated scans and scales better to actual 5v5. | M |
| 11 | Cache Hangar stat panels and move toward retained section DOM/event delegation. | `Hangar.ts`, Hangar stat helpers | Addresses the prior review’s remaining Hangar recomputation/DOM churn. | L |
| 12 | Add measurable lifecycle/performance gates: scene resource counts, snapshot allocations/bytes, room tick time, objective decode time, arena rebuild duration. | client tests/e2e, server telemetry | Converts the remaining optimization concerns into regression budgets. | M |

### Nice to have

| Work | Where | Expected payoff | Effort |
|---|---|---|:---:|
| Cache the radar/minimap static background and common alpha colors. | HUD canvas code | Reduces unchanged canvas path/string work. | S–M |
| Update `docs/CONTENT.md`’s arena table to the five manifest arenas and their actual modes. | `docs/CONTENT.md` | Restores the document’s role as the current content contract. | S |
| Extend content validation to cross-check gamemode team size, bot roster, flag-base teams, and arena spawn capacity. | shared content/reference validation | Prevents another valid-but-contradictory shipped mode. | M |
| Add a source-independent generated-asset verification step for lunar sky and terrain inputs. | skybox/asset tools and CI | Ensures checked-in images match generator parameters without runtime work. | M |
