# SpaceArena review: commits dated 2026-07-31 and 2026-08-01

## Executive summary

The review found five concrete correctness/lifecycle defects and several measurable hot-path allocation problems.

Highest-priority defects:

1. CTF pickup resolution can let a friendly ship prevent an overlapping enemy from taking a home flag.
2. Online snapshots explicitly discard all flags and heatsink decoys, despite the server accepting jettison orders.
3. Hangar server refreshes are neither cancelable nor versioned; stale responses can overwrite newer state or mutate the hidden/disposed screen.
4. The Hangar preview’s synthetic movement is frame-rate-dependent and accumulates without bound.
5. CTF marker materials are never disposed.

The largest performance concern is not one catastrophic loop but accumulated churn: complete Hangar DOM reconstruction, repeated stat recomputation, per-snapshot object graphs and trail copies, per-frame CTF trail allocations, linear entity lookup, and repeated strings/style writes in HUD rendering.

## Review basis

The requested command produced:

```text
3e4292a 2026-08-01 Hangar: entry resets the view, and the fit judges itself on the stage
74834c5 2026-08-01 Solid asteroids and a flag you can actually find
9e6472a 2026-08-01 Hangar: arrows on the stage, a ship that slides, and a dock worth standing in (#16)
66b832a 2026-07-31 Hangar: the placeholder cubes were the library defaults, not the theme (#15)
568dbe3 2026-07-31 Hangar: a real bay, the real hull, no callouts — and honest asteroid colliders (#14)
5a37493 2026-07-31 Dual energy, capture the flag, ship ownership, and an outfitting screen to match (#13)
0acd07f 2026-07-31 Offline fitting: fit and save without an account (testing affordance) (#12)
d780757 2026-07-31 Ship systems redesign: internal module bay, jettisonable heatsink lure, and drag-and-drop fitting (#11)
```

I inspected the actual diffs for all eight commits and followed the affected production paths into the current tree.

## 1. Code review

### High-severity defects

#### 1. CTF: a friendly ship can block an enemy flag pickup

Location: [CtfSystem.ts](/home/user/SpaceArena/shared/src/sim/systems/CtfSystem.ts:64)

```ts
if (team === flag.team) {
  // Your own flag: nothing at home, an instant return when loose.
  if (flag.state === "dropped") sendHome(world, flagId, flag, shipId, false);
  break;
}
take(world, flagId, flag, shipId, team);
break;
```

When the flag is home, touching it with a friendly ship should do nothing. Instead, the loop still executes `break`.

Ships are deliberately processed in ascending entity-id order. If a friendly ship with the lower ID and an enemy ship both overlap the home flag during the same tick, the friendly is encountered first and terminates contact processing. The enemy cannot take the flag until a later tick. If the friendly remains on the stand, it can continuously shield the flag from pickup.

Concrete failure scenario:

- Team 0 defender parks on its home flag.
- Team 1 attacker enters pickup range.
- Defender has the lower entity ID.
- Every tick stops at the defender, and `take(...)` is never reached.

For a home flag, the friendly branch must `continue`, not `break`. For a dropped flag, returning it and then breaking remains correct. Add a test with simultaneous friendly/enemy overlap in both entity-ID orders.

#### 2. Online snapshots erase the new CTF and jettison state

Location: [NetGameSession.ts](/home/user/SpaceArena/client/src/net/NetGameSession.ts:836)

```ts
return {
  ...
  decoys: [],
  flags: [],
};
```

The server accepts a network `jettisonHeatsink` order, but the client decoder always reports no decoys. It also always reports no flags and forces replicated capture counts to zero.

This causes visible authoritative-state divergence:

- A multiplayer player jettisons a heatsink.
- The server can create the decoy and redirect missiles toward it.
- The client never receives/renderers the decoy, so missiles appear to change target for no visible reason.
- If a CTF gamemode is ever admitted through matchmaking, the server may simulate the objective while the client has no flag markers, minimap objectives, trails, or capture score.

The implementation comment calls CTF “offline for now,” but the type and order surfaces do not enforce that boundary. This is therefore either an incomplete network feature or a missing validation rule. Do one of the following promptly:

- replicate decoys, flags, carrier/drop state, trails and captures through `ArenaState`; or
- reject CTF gamemodes and jettison orders in online rooms until replication exists.

Silent substitution with empty arrays is the worst behavior because it leaves gameplay active while hiding its cause.

### Medium-severity defects

#### 3. Hangar refresh responses can overwrite newer state

Locations: [Hangar.ts](/home/user/SpaceArena/client/src/game/screens/Hangar.ts:441), [Hangar.ts](/home/user/SpaceArena/client/src/game/screens/Hangar.ts:488)

```ts
void this.refreshFromServer().then(() => {
  if (stored.fittingId && this.fittings.some(...)) {
    this.loadFitting(stored.fittingId);
  }
});
```

```ts
const [shipsRes, modulesRes, fittingsRes] = await Promise.all([
  this.api.ships(),
  this.api.modules(),
  this.api.fittings(),
]);
this.apiShips = shipsRes.ships;
this.apiModules = modulesRes.modules;
this.fittings = fittingsRes.fittings;
...
this.render();
```

There is no request generation, abort signal, current-ship guard, visibility guard, or disposed guard.

Concrete races:

- `show()` starts refresh A.
- An auth change starts refresh B.
- B completes first with the new session’s inventory.
- A completes later and overwrites it with old-session data.

Also:

- `show()` captures `stored` and `ship`.
- The player browses to a different hull before the request completes.
- The completion callback can load the formerly stored fitting against current mutable state.

And:

- The user leaves the Hangar before the request completes.
- The `finally` block still calls `render()`, rebuilding a hidden screen.
- If application teardown disposes the screen before completion, the callback still targets disposed DOM/state.

Use a monotonically increasing visit/request token plus `AbortController`. Apply a result only if the token, auth identity, current visit, and relevant ship still match.

#### 4. Failed Hangar model loads are permanently cached as requested

Location: [Hangar.ts](/home/user/SpaceArena/client/src/game/screens/Hangar.ts:539)

```ts
if (!this.modelsRequested.has(loadingFor)) {
  this.modelsRequested.add(loadingFor);
  void this.assets.ensureModel(ship.render).then((loaded) => {
    if (!loaded) return;
    ...
  });
}
```

The hull ID enters `modelsRequested` before loading. If `ensureModel` returns false because of a transient request/decode failure, the ID is never removed. Every subsequent visit remains on the procedural fallback for the lifetime of the `Hangar` instance.

Concrete failure scenario: a brief content-server outage on the first Hangar visit permanently converts that hull to a placeholder until the entire application is restarted.

Track in-flight promises separately from successful loads, or remove the ID on failure so later visits can retry with bounded backoff.

#### 5. Hangar preview movement is frame-rate-dependent and unbounded

Location: [Hangar.ts](/home/user/SpaceArena/client/src/game/screens/Hangar.ts:670)

```ts
const dtMs = this.scene.getEngine().getDeltaTime();
this.previewClock += dtMs / 1000;
const wave = 0.35 + 0.25 * Math.sin(this.previewClock * 0.6);

this.idlePrev.pos.x = this.idleCur.pos.x;
this.idleCur.pos.x += wave * 0.02;
```

`wave` is always positive: its range is `0.10..0.60`. The code adds it once per rendered frame without multiplying by `dt`.

Consequences:

- At 120 FPS the synthetic ship travels twice as fast as at 60 FPS.
- `idleCur.pos.x` increases indefinitely throughout the visit.
- The position is not reset on `show()` or `rebuildPreview()`.
- Emitters receive an ever-moving snapshot even though the visible hull stays parked.

If the intent is gentle oscillation, derive position from time:

```ts
idleCur.pos.x = amplitude * Math.sin(previewClock * frequency);
```

If the intent is velocity, multiply by `dtMs / 1000` and bound/reset it. Reset both idle snapshots and `previewClock` on each visit.

### Resource-management defect

#### 6. Flag marker materials leak

Locations: [EntityView.ts](/home/user/SpaceArena/client/src/game/EntityView.ts:696), [EntityView.ts](/home/user/SpaceArena/client/src/game/EntityView.ts:681), [EntityView.ts](/home/user/SpaceArena/client/src/game/EntityView.ts:898)

```ts
const mat = new StandardMaterial(`mat.flag.${id}`, this.scene);
...
marker.material = mat;
```

Removal and disposal only do:

```ts
view.marker.dispose();
view.trail.dispose();
```

Babylon mesh disposal does not normally dispose an assigned material unless requested explicitly. Unlike beam materials, which are explicitly disposed elsewhere in the same class, each recreated flag leaves its `StandardMaterial` registered in the scene.

Concrete failure scenario: repeated match/session recreation or a mode reset that removes and recreates flags steadily grows `scene.materials` and retains GPU material resources.

Put the material in `FlagView` and dispose it explicitly, or call a disposal form that owns the material only if it cannot be shared.

## Hot-path and performance findings

### 7. CTF trail resampling allocates every render frame

Location: [flagTrail.ts](/home/user/SpaceArena/client/src/game/flagTrail.ts:53)

```ts
const cumulative: number[] = [0];
for (let i = 1; i < trail.length; i++) {
  total += dist(trail[i - 1]!, trail[i]!);
  cumulative.push(total);
}
```

`syncFlags()` invokes this for every visible flag on every render frame. The output vectors are pooled, but the cumulative-distance array is not. It also calls `Math.hypot` repeatedly.

The simulation separately creates and copies the trail:

```ts
trail: f.trail.map((p) => ({ x: p.x, y: p.y, z: p.z })),
```

Thus each frame/tick pays for snapshot point objects, a renderer cumulative array, resampling, and Babylon line updates. With two flags this is not currently catastrophic, but it is avoidable regular GC in the main render path.

Accept a caller-supplied numeric scratch buffer, or maintain a fixed-size sampled trail in the snapshot/view. Do not transmit or clone the entire breadcrumb history when only 24 render vertices are used.

### 8. EntityView updates line geometry every frame even when the trail is unchanged

Location: [EntityView.ts](/home/user/SpaceArena/client/src/game/EntityView.ts:670)

```ts
if (resampleTrail(flag.trail, this.sTrail, TRAIL_POINTS)) {
  ...
  MeshBuilder.CreateLines(
    view.trail.name,
    { points: this.sTrailVectors, instance: view.trail },
    this.scene,
  );
}
```

The code rebuilds the updatable line’s vertex data every render frame whenever a trail exists, including frames between simulation snapshots where the trail data is unchanged. Cache a trail version, snapshot tick, or last head/tail/count signature and update the GPU buffer only when the authoritative trail changes.

### 9. Snapshot production builds extensive temporary object graphs every tick

Location: [ArenaSimulation.ts](/home/user/SpaceArena/shared/src/sim/ArenaSimulation.ts:731)

The current `snapshot()` maps every asteroid, projectile, decoy, flag, flag trail point and score into new arrays and objects. CTF adds a nested `trail.map(...)` per flag. This occurs in both local simulation and authoritative server paths.

Expected server impact scales as:

```text
rooms × 30 ticks/s × entities per room × objects per entity
```

Before micro-optimizing individual systems, profile snapshot serialization. Likely improvements are reusable snapshot buffers, delta replication for server rooms, and fixed-size/quantized trail representations.

### 10. Repeated linear lookups in render and HUD paths

Examples:

- [EntityView.ts](/home/user/SpaceArena/client/src/game/EntityView.ts:815): `findShip` or `findAsteroid` for each channeling ship.
- [Hud.ts](/home/user/SpaceArena/client/src/game/hud/Hud.ts:272): `cur.ships.find(...)` every frame.
- [EntityView.ts](/home/user/SpaceArena/client/src/game/EntityView.ts:683): `cur.flags.some(...)` once per retained flag.
- Hangar repeatedly uses `apiShips.find`, `apiModules.find`, and configuration filtering while rendering.

These are currently tolerable at small arena sizes but will become quadratic in crowded modes. Build ID-indexed maps once per received snapshot, or expose lookup tables alongside snapshot arrays.

### 11. Minimap recreates alpha strings and paths on each redraw

Location: [Minimap.ts](/home/user/SpaceArena/client/src/game/hud/Minimap.ts:173)

Every contact performs several calls such as:

```ts
ctx.strokeStyle = withAlpha(color, alpha * 0.55);
ctx.fillStyle = withAlpha(color, alpha);
```

`withAlpha` creates strings, and each asteroid/contact/flag repeatedly creates canvas paths. The minimap is already redraw-throttled, which limits the damage, but static disc/grid geometry and common RGBA variants can be cached. An `OffscreenCanvas` or cached background bitmap would remove the repeated disc/grid draw entirely.

### 12. HUD lookup and DOM-write discipline is inconsistent

`EnemyArrows` caches last values before writing styles, which is the right pattern. Other widgets independently implement similar state caches, while some still perform searches, text formatting, or class operations every frame.

There is no common retained-widget abstraction defining:

- cached text;
- cached class/visibility state;
- cached numeric style values;
- redraw cadence;
- teardown ownership.

This makes new HUD work likely to regress into per-frame DOM churn.

## Maintainability and design issues

### Hangar.ts is a god object

[Hangar.ts](/home/user/SpaceArena/client/src/game/screens/Hangar.ts:187) is about 2,100 lines and currently owns:

- authentication refresh behavior;
- API mutation and error state;
- online/offline fitting persistence;
- ship and module ownership policy;
- carousel/swap state;
- Babylon preview lifecycle;
- Hangar bay lifecycle;
- camera framing;
- particle preview snapshots;
- gauge projection;
- all DOM construction and event wiring;
- the entire stylesheet.

The split into pure helpers such as `hangarOverlayModel`, `hangarStats`, `hangarSwipe`, `shipSwap`, and `HangarBay` helps locally, but lifecycle and state transitions remain centralized. The async race and model retry defect are direct consequences of having network, scene and view state under one mutable owner.

A sensible decomposition is:

- `HangarController`: visit lifecycle, current selection, commands.
- `HangarRepository`: API calls, local fitting storage, request cancellation/versioning.
- `HangarState` or reducer: ship/category/slot/picker/busy/error transitions.
- `HangarStage`: `stageRoot`, bay, ship mesh/rig, swap animation, camera framing.
- `HangarOverlay`: retained gauge nodes and preview interaction state.
- `HangarPanelView`: DOM sections and delegated actions.
- `hangar.css`: stylesheet outside the TypeScript module.

### Online and offline capability boundaries are implicit

The same shared simulation exposes CTF and jettison behavior, while `NetGameSession` silently strips their state. Capability checks should exist at matchmaking/room creation and be represented in gamemode metadata. Consumers should not discover “offline only” by receiving empty arrays.

### Ownership is documented in comments rather than types

Examples include:

- whether a mesh owns its material;
- whether `AssetRegistry` owns loaded masters;
- whether per-visit callbacks may survive `hide`;
- whether a snapshot array can be retained;
- whether a stage resource is visit-scoped or Hangar-scoped.

Comments are useful, but explicit disposable aggregates, abort scopes, and resource-owner objects would prevent the observed leaks and races.

### Fitting/stat computation is repeated

A single `render()` can compute the same ship fit in:

- `renderGauges`;
- `buildStatPanel`;
- `buildStatusBar`.

Hover previews compute base and projected panels again. Cache the base `HangarStatPanel` by ship, upgrades and fitted module IDs; calculate the ghost only when the preview candidate changes.

### UI construction lacks event delegation

Every full Hangar render creates new elements and closures for buttons and hover/focus signals. Removed nodes make those listeners collectible, so this is not a permanent listener leak, but it generates avoidable short-lived functions and DOM nodes.

Use stable section roots, keyed updates, and one delegated click/pointer/focus handler per section.

### Generated bot identity has inconsistent semantics

Offline `GameSession` generates a whole unique name roster, while the server calls `generateBotName(rosterRng)` separately. If uniqueness is only guaranteed by `generateBotNames`, server bot names can collide. Even if collisions are accepted, the two paths do not implement the documented “same seed ⇒ same roster” contract identically.

## 2. Optimization plan

### Do soon

| Order | Work | Where | Expected payoff | Effort |
|---:|---|---|---|:---:|
| 1 | Fix home-flag contact resolution and add simultaneous-contact tests in both entity-ID orders. | `shared/src/sim/systems/CtfSystem.ts`, `Ctf.test.ts` | Removes a gameplay exploit that can make a flag untakeable. | S |
| 2 | Define the online capability boundary. Either replicate flags/decoys/captures or reject those features online. Never decode active authoritative features as empty arrays. | `server/src/rooms/ArenaRoom.ts`, room schema, `client/src/net/NetGameSession.ts`, matchmaking validation | Restores client/server consistency and prevents invisible missile retargets or unusable online CTF. | L for replication; S for explicit rejection |
| 3 | Introduce an abortable/versioned Hangar visit scope. Ignore stale refresh/model callbacks after a newer request, ship change, hide, or dispose. | `client/src/game/screens/Hangar.ts`, `HangarApi` | Eliminates stale inventory/fitting overwrites and hidden-screen work. | M |
| 4 | Correct and reset Hangar idle preview motion. Make it time-derived or `dt`-scaled. | `client/src/game/screens/Hangar.ts:662-681` | Deterministic animation across refresh rates; prevents unbounded synthetic position drift. | S |
| 5 | Dispose flag materials and add a scene-resource-count lifecycle test. | `client/src/game/EntityView.ts` | Stops material/GPU resource growth across sessions and mode resets. | S |
| 6 | Make model-load tracking distinguish in-flight, success and failure; retry transient failures. | `client/src/game/screens/Hangar.ts`, `AssetRegistry` | Avoids permanent placeholder hulls after one failed request. | S |
| 7 | Cache the current Hangar stat panel and retained gauge DOM. Recompute only when ship, upgrades, fitted modules or preview candidate change. | `Hangar.ts`, `hangarOverlayModel.ts`, `hangarStats.ts` | Removes repeated fit resolution and gauge DOM destruction during hover and general render. | M |
| 8 | Split Hangar stage lifecycle out first, before broader UI decomposition. Move mesh/rig/bay/swap/camera logic into `HangarStage`. | `Hangar.ts`, `HangarBay.ts`, `shipSwap.ts` | Creates a clear Babylon resource owner and makes teardown testable without the whole outfitting UI. | M |
| 9 | Add profiling counters around snapshot construction, serialization size, server tick time and client render/HUD time. | `ArenaSimulation.snapshot`, `ArenaRoom`, client loop, telemetry | Establishes evidence for the next allocation/network changes and prevents speculative optimization. | M |
| 10 | Reuse CTF trail scratch storage and skip GPU line updates when the authoritative trail has not changed. | `flagTrail.ts`, `EntityView.ts` | Removes steady render-frame GC and unnecessary vertex-buffer writes. | S–M |

### Next maintainability pass

| Order | Work | Where | Expected payoff | Effort |
|---:|---|---|---|:---:|
| 11 | Extract `HangarRepository` and a pure state reducer/controller for selection, ownership, fittings and busy/error transitions. | `Hangar.ts`, offline fitting/ownership modules, API layer | Makes request races, online/offline policy and state transitions independently testable. | L |
| 12 | Replace whole-panel `innerHTML = ""` rendering with stable section roots and delegated events. Key module rows and slot buttons. | `Hangar.ts` UI layer | Less DOM churn and fewer closure allocations; preserves focus/scroll during updates. | L |
| 13 | Introduce a small retained HUD widget pattern: cached text, class, transform, visibility and cadence helpers. | `client/src/game/hud/` | Consistent no-op update behavior across HUD widgets; less duplicated lifecycle code. | M |
| 14 | Build entity lookup maps once per snapshot/frame and pass them to ViewManager/HUD systems. | `GameSession`, `NetGameSession`, `EntityView.ts`, HUD | Removes repeated linear scans and prevents quadratic growth in larger bot modes. | M |
| 15 | Rework snapshots/network state around deltas and reusable storage, especially flag trails. Quantize trail points and send them only on change. | `ArenaSimulation.ts`, room schema, `ArenaRoom.ts`, `NetGameSession.ts` | Largest prospective server GC and bandwidth reduction for many concurrent rooms. | L |
| 16 | Unify server/offline bot roster generation through one shared `generateRoster(seed, mode)` API. | `shared/src/bots`, `GameSession.ts`, `ArenaRoom.ts` | Removes behavioral drift and makes hull/fitting/name determinism identical. | M |

### Nice to have

| Work | Where | Expected payoff | Effort |
|---|---|---|:---:|
| Cache the minimap’s static disc/grid in an offscreen canvas and cache common palette alpha strings. | `client/src/game/hud/Minimap.ts` | Reduces canvas path work and string garbage on redraws. | S–M |
| Replace `Math.hypot` in comparison-only paths with squared distance; keep square roots only for displayed distances. | CTF contact, targeting/LoS candidates, HUD where applicable | Small tick/render CPU reduction in entity-heavy modes. | M |
| Avoid `[...modules].sort(...)` in `railAdmitted` if modules are already stored in hardpoint order, or reuse a scratch array. | `shared/src/sim/powerRail.ts:99` | Removes a spawn-time allocation; minor unless respawn volume is high. | S |
| Move the embedded Hangar stylesheet to a dedicated stylesheet/module and split view sections by responsibility. | `Hangar.ts` | Better navigation, CSS tooling and bundle caching; limited runtime effect. | M |
| Add automated Babylon lifecycle assertions: material, mesh, particle system, observer and light counts before/after repeated Hangar and match cycles. | client tests/e2e | Detects future scene leaks earlier than visual smoke tests. | M |
| Add bundle/content budgets by asset category and validate GLB texture/mesh compression. | `tools/bundle-budget.ts`, `content/` | Protects download size as ship/asteroid art grows. | M |

## Bundle and asset observations

The content directory is approximately 13 MB in the working tree:

- ships: approximately 6.7 MB;
- asteroids: approximately 4.8 MB;
- skyboxes: approximately 964 KB.

No binary asset was added in the reviewed commit window; most new content is JSON. Therefore the immediate bundle risk comes from code growth and future art expansion, not these commits’ raw asset additions.

Still, ship and asteroid assets should be checked for:

- mesh compression such as Meshopt or Draco where platform support permits;
- KTX2/Basis texture compression;
- duplicated embedded materials/textures across LODs;
- manifest-driven lazy loading by screen/mode;
- avoiding preload of CTF-only and Hangar-only assets in unrelated modes.

