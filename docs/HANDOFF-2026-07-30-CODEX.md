# Codex handoff — asteroid meshes, combat HUD, radar, and chase camera

Date: 2026-07-30  
Target branch: `main`  
State at handoff: **all gates green** — 1,487 tests across 129 files, typecheck, content validation (61 configs), ESLint, production build, and the Playwright smoke journey.

This file records the owner-requested presentation pass implemented by Codex. It is intentionally explicit because Claude is also working in this repository. Read this together with the current amendments at the top of `docs/FLIGHT.md`, `docs/BUBBLE.md`, and `docs/CONTENT.md` before changing asteroid rendering, flight HUD layout, radar projection, or chase-camera behavior.

## Owner request implemented

- Authored asteroid meshes must appear at every quality setting; procedural rocks are only a real asset-failure fallback.
- Remove the decorative circle around FIRE and move fitted module buttons closer to it.
- Replace the large central lock-zone circle with restrained hull and shield semicircles around the ship; remove those two rows from the lower-left gauge panel.
- Raise the existing throttle and reduce its opacity to about 60%.
- Move the chase view closer and expose its distance in Settings.
- Replace the flat minimap with a subtle Elite-style, ship-relative 3D radar.

## What changed

### 1. Authored asteroid GLBs on low, medium, and high

The first-match bug had two contributing paths:

1. Asteroid views synchronously chose and retained a render master while arena GLBs were still loading asynchronously.
2. Shipped quality content could deliberately choose procedural asteroid LODs; low also had `proceduralOnly: true`.

The fix preserves the procedural recipes but removes both normal paths into them:

- `client/src/core/assetPreload.ts`
  - `preloadArenaModels(...)` now returns `Promise<void>` and awaits all distinct authored arena models.
- `client/src/main.ts`
  - Practice and matchmaking both call `prepareSessionArena(...)` and await the resolved arena's models before `createMatchRuntime(...)` constructs `ViewManager`/asteroid views.
  - Matchmaking cancellation is checked again after the await so an abandoned session is disposed instead of activated.
  - Bootstrap and editor hot-reload preloads remain intentionally fire-and-forget.
- `content/quality/{low,med,high}.json`
  - Authored-to-procedural medium/low LOD distances are `0` for all shipped tiers.
  - Low no longer sets `proceduralOnly`.
  - Tier-specific far-distance culling remains intact.

Do not remove the procedural asteroid recipes. `AssetRegistry.ensureModel(...)` still resolves `null` for a missing/corrupt/unloadable GLB, and that genuine failure must retain a drawable fallback.

### 2. Hull/shield arcs and cleaner combat centre

- New `client/src/game/hud/VitalArcs.ts` renders theme-driven SVG side arcs:
  - hull on the left;
  - fitted-module shield reservoir on the right;
  - shield percentage uses the same `shieldPool / mitigation.absorbPerSecond` convention as the legacy `Gauges` implementation;
  - hull critical state retains the danger-color cue.
- `client/src/game/hud/Gauges.ts` now honors `showHull` and `showShield`. The shipped theme disables both, leaving energy and heat at lower left.
- `client/src/game/hud/LockReticle.ts` now honors `reticle.showZone`. The shipped theme hides only the large projected lock-cone circle; target brackets, labels, progress, and blocked feedback still work.
- `client/src/game/hud/FireButton.ts` hides its decorative SVG ring when the authored stroke or arc is zero. The shipped theme sets both to zero.
- The shipped module arc has a smaller radius and revised offsets/sweep around FIRE in both orientations.

The new theme/schema surface is in `shared/src/schemas/theme.ts`, resolved by `client/src/game/hud/hudLayout.ts` and `flightHudLayout.ts`, and authored in `content/themes/default.json`. Defaults deliberately preserve old themes: legacy lower-left hull/shield rows and the lock zone remain enabled unless a theme opts into the new presentation.

### 3. Ship-relative 3D radar

`client/src/game/hud/Minimap.ts` keeps its historical class name to minimize integration churn, but its implementation is now a player-centred Canvas2D 3D radar:

- tilted elliptical plane with range rings and axes;
- own-ship chevron fixed at the origin;
- friendly/hostile diamonds;
- quiet nearby asteroid contacts;
- target halo;
- lollipop stems for vertical separation;
- out-of-range ships pinned to the rim at reduced opacity;
- redraw capped at 20 Hz.

Projection math is isolated in `client/src/game/hud/radarProjection.ts` and tested independently. For world delta `D`, raw full-loop heading/pitch build this ship basis:

- `R = (sin h, 0, -cos h)`
- `U = (-cos h sin p, cos p, -sin h sin p)`
- `N = (cos p cos h, sin p, cos p sin h)`

The disc plots `D·R` and `D·N`; the stem plots `D·U`. Do not canonicalize pitch or substitute world-y altitude: either causes the display to flip while vertical or inverted.

Legacy `minimapSizePx`, `minimapRangeUnits`, and `minimapAltitudeTickPx` remain fallbacks when a content pack does not author the new `hud.radar` block.

### 4. Throttle and chase camera

- The existing throttle design is unchanged, but the shipped theme raises it and applies `opacity: 0.6`.
- The chase baseline is now 12 units instead of 14 in both `content/camera/default.json` and the hardcoded fallback.
- Settings now exposes **Camera distance** from 80% to 150% of the content-authored chase radius.
- Persistence key: `sa.camera.chaseDistance`.
- `TacticalCamera` applies the multiplier consistently to the chase pose and both Babylon radius limits, including live setting changes.

This is a player-local presentation setting. No sim, wire protocol, or server behavior changed.

## Important files and tests

Primary implementation:

- `client/src/core/assetPreload.ts`
- `client/src/main.ts`
- `client/src/game/TacticalCamera.ts`
- `client/src/game/screens/SettingsScreen.ts`
- `client/src/game/hud/VitalArcs.ts`
- `client/src/game/hud/Minimap.ts`
- `client/src/game/hud/radarProjection.ts`
- `client/src/game/hud/hudLayout.ts`
- `client/src/game/hud/flightHudLayout.ts`
- `client/src/game/hud/hudStyle.ts`
- `shared/src/schemas/theme.ts`
- `content/themes/default.json`
- `content/quality/{low,med,high}.json`

Focused regression coverage:

- `client/src/core/assetPreload.test.ts`
- `client/src/game/arenaRouting.test.ts`
- `shared/src/schemas/shippedPresentation.test.ts`
- `client/src/game/hud/VitalArcs.test.ts`
- `client/src/game/hud/radarProjection.test.ts`
- `client/src/game/hud/hudLayout.test.ts`
- `client/src/game/hud/flightHudLayout.test.ts`
- `client/src/game/hud/FireButton.test.ts`
- `client/src/game/hud/LockReticle.test.ts`
- `client/src/core/userSettings.test.ts`
- `client/src/game/TacticalCamera.test.ts`

## Verification performed

- `npm run typecheck` — pass
- `npm run validate:content` — pass, 61 configs
- `npx eslint .` — pass
- `npx vitest run` — pass, 129 files / 1,487 tests
- `npm run build` — pass; the existing Babylon large-chunk advisory remains
- `npm run test:e2e` — pass; guest login → fitting → practice match → lobby
- `git diff --check` — pass (Windows LF/CRLF conversion notices only)
- Live browser QA:
  - portrait `390 × 740`;
  - landscape `1280 × 800`;
  - authored irregular asteroid GLBs visible;
  - FIRE ring and central lock-zone circle absent;
  - hull/shield arcs, tighter module cluster, raised translucent throttle, and 3D radar visible;
  - clean reload and practice entry produced no new browser warnings/errors.

All temporary preview processes were stopped after QA.

## Coordination notes for Claude

- These are owner-directed current presentation contracts, not speculative experiments. The dated amendments near the top of `FLIGHT.md`, `BUBBLE.md`, `CONTENT.md`, and `ROADMAP.md` supersede stale historical descriptions later in those documents.
- If your branch predates this commit, rebase or merge before touching the listed systems. In particular, avoid restoring low-tier `proceduralOnly`, positive authored-to-procedural LOD distances, the full lock-zone circle, or the old flat minimap.
- Preserve backward-compatible theme defaults and legacy minimap fallbacks unless the owner explicitly drops content-pack compatibility.
- There are no known functional failures at handoff. The remaining useful check is subjective phone/device feel: arc subtlety, thumb reach around FIRE, and preferred default camera distance.

