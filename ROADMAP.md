# 🚀 Space Arena — MVP Prototype Roadmap (v2)

> **Fast-paced arcade 3D space arena combat in the browser — one finger is enough.**
> 1v1 & 2v2 PvP inside bounded arenas with hazardous asteroids — built as a **data-driven engine plus a constellation of designer-facing editors**, not a hardcoded game.

**Visual reference:** `examplescreenshot.jpg` — the ORIGINAL tactical concept; the camera, the move-order path and the target ring in it are retired (see the superseded note below). The HUD furniture it shows — minimap top-left, hull/shield bars left, heat/energy gauge top-right, module cluster bottom-right — is still the layout. As drawn: **3/4 tactical camera** (RTS / MOBA style, like League of Legends) looking down into a ring-station arena; blue player ship with a dashed **move-order path**, red enemy with laser fire; asteroids as cover; minimap top-left, hull/shield bars left, heat/energy gauge top-right; **all gameplay buttons in a radial cluster at the bottom-right**: Kinetic, Laser, Missile, Shield, Boost — one thumb reaches everything.

---

> ## ⚠️ PARTIALLY SUPERSEDED — read `docs/FLIGHT.md` first
>
> The **flight overhaul** (2026-07-25) replaced the one-finger RTS control model
> with continuous forward flight. For anything touching **movement, targeting,
> input or camera**, `docs/FLIGHT.md` is the contract and this document is
> history. In particular these are **retired, not deferred**:
>
> | Retired | Replaced by (FLIGHT.md) |
> |---|---|
> | Tap-to-move, `move` orders, `MoveOrder`, seek/arrival steering, asteroid avoidance | Level-triggered `flight` order (throttle / turn / boost), §1 |
> | `target` orders, tap-to-focus a ship | Fully automatic sticky targeting + timed sensor lock, §2 |
> | 3/4 tactical `ArcRotateCamera`, in-match pan/orbit | Chase camera behind the ship, §3 |
> | `OrderInput.ts`, double-tap boost, dashed path line + destination marker | Virtual joystick + throttle strip + boost button + lock reticle, §4 |
>
> Everything else here — modules/energy/heat, LoS, arenas, bots-as-config,
> progression, the editor constellation, the data-driven philosophy — is
> unchanged and still current. Sections below that describe retired systems are
> flagged inline; they are kept for the reasoning, not as instructions.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Control & Combat Model](#2-control--combat-model)
3. [Tech Stack](#3-tech-stack)
4. [Project Architecture & Editor Constellation](#4-project-architecture--editor-constellation)
5. [Phase 0 — Setup & Foundation](#5-phase-0--setup--foundation)
6. [Phase 1 — Core Single-Player Loop + Editor Tools](#6-phase-1--core-single-player-loop--editor-tools)
7. [Phase 2 — Multiplayer Infrastructure](#7-phase-2--multiplayer-infrastructure)
8. [Phase 3 — Authentication & Persistence](#8-phase-3--authentication--persistence)
9. [Phase 4 — Ships, Modules & Data-Driven Content](#9-phase-4--ships-modules--data-driven-content)
10. [Phase 5 — Polish, Bots, Mobile & Advanced Tools](#10-phase-5--polish-bots-mobile--advanced-tools)
11. [Phase 6 — Testing, Deployment & Extensibility](#11-phase-6--testing-deployment--extensibility)
12. [Milestones & Estimated Effort](#12-milestones--estimated-effort)
13. [Risks, Best Practices & Future Extensions](#13-risks-best-practices--future-extensions)

---

## 1. Project Overview

### 1.1 Vision

An **arcade 3D spaceship arena PvP game** with the fitting depth of Eve Online / Elite Dangerous but the accessibility of a mobile MOBA. Matches last 3–5 minutes. Skill expression comes from **positioning, line-of-sight play around asteroids, and module management** (energy budget, heat, deploy/retract timing) — not twitch aiming. Playable instantly in any modern browser, **fully playable with one finger on a phone**.

### 1.2 The Core Philosophy: Data-Driven Engine + Editor Constellation

> **Build an engine that reads content from data. Never hardcode what can be configured.**

| Hardcoded Game (❌ avoid) | Data-Driven Engine (✅ build this) |
|---|---|
| `if (module === "laser") dps = 12` | `dps = moduleConfig.fire.damage / moduleConfig.fire.cycleTime` |
| Overheat logic per weapon in code | One generic module state machine; heat/energy numbers per module JSON |
| Arena layout baked into code | Arena = JSON file placed/edited in the Map Editor |
| Bot behavior in `if/else` spaghetti | Bot = JSON behavior profile (weights, ranges, triggers) |
| Balance change = code change | Balance change = edit value in Tuning Panel, hot-reload, test in 5 s |

The AI agents implement each *system* once (movement orders, module state machine, energy/heat, LoS, arenas, bots, win conditions). After that, the developer creates ships, maps, modules, bots, and rules **through the built-in editors** — no code changes.

**Everything links by string id** (`ship.interceptor`, `module.laser-mk2`, `arena.ring-nebula`, `event.on-shield-down`, `notification.overheat-warning`) — every editor's output is referenceable from every other editor. Unbuilt assets are always tagged placeholders (`[MODEL: brawler_hull]`, `[SOUND: laser_fire]`, `[ICON: shield]`), never fake paths.

### 1.3 MVP Goals

- ✅ Core loop: **menu → hangar (fitting) → matchmaking → arena combat → results → progression**
- ✅ **One-thumb control**: ~~tap-to-move, double-tap afterburner~~ → virtual joystick + throttle strip + boost, module toggle buttons bottom-right (FLIGHT.md §4)
- ✅ ~~**3/4 tactical camera** with pinch zoom and angle adjust~~ → **chase camera** behind the ship, practical on a phone (FLIGHT.md §3)
- ✅ **2–3 ship classes** with upgradeable core systems (hull / engine / energy / heat capacity) — all config-defined
- ✅ **Module system**: lasers, kinetic, missiles, shield, boost — activation states, energy draw (idle vs active), heat & overheat, deploy/retract timers, **auto-fire on target in range + line of sight**
- ✅ **1–2 arenas** with asteroid cover/hazards — built with the Map Editor
- ✅ **1v1 and 2v2** on an authoritative Colyseus server, bots filling empty slots
- ✅ Accounts (guest + email/password), persistent credits, level, ship upgrades, fittings, saved configs
- ✅ **Editor constellation** (see §4.3): Map, Asset, Ship & Fitting, Action, Event, Notification, Theme/UIUX, Tuning Panel, Progression, Behavior editors + config export/import
- ✅ **30–60 FPS on mid-range phones**

### 1.4 Success Criteria for the MVP

| # | Criterion | Measurable Definition |
|---|---|---|
| S1 | Playable match | Two browsers (or browser + bot) complete a full 1v1 with a winner declared |
| S2 | Data-driven proof | A new arena AND a new module type are created **entirely via editors** (zero code edits) and are playable online |
| S3 | Mobile viability | ≥ 30 FPS on a mid-range Android phone; **entire match playable with one thumb** |
| S4 | Persistence | Player returns later and keeps account, credits, ship upgrades, fittings |
| S5 | Netcode quality | Playable at 150 ms latency — order-based input makes this far more forgiving than twitch controls |
| S6 | Extensibility | Exported content pack loads on a fresh server |
| S7 | Depth proof | A playtest shows a player winning through module management (heat/energy/LoS) against a stat-identical opponent |

### 1.5 Explicit Non-Goals (Post-MVP)

Shop/monetization UI, ranked ladders, clans, spectator mode, custom 3D art pipeline, VoIP, replays, free-flight chase-cam mode (the engine's order-based sim doesn't preclude it later, but MVP is tactical view only).

---

## 2. Control & Combat Model

This section is the design contract every phase implements. **Every number named "tunable" lives in config, editable in the Tuning Panel.**

### 2.1 Camera — 3/4 Tactical View ⚠️ RETIRED (see FLIGHT.md §3)

> The in-match camera is a **chase rig** behind the ship: alpha is driven from
> smoothed ship heading, beta/radius/height come from `camera.chase`, and there
> is no in-match pan or orbit. The tactical `ArcRotateCamera` below survives
> only as the dev editor's stage. Everything in this subsection describes the
> retired rig.

- `ArcRotateCamera` locked to a comfortable RTS band: beta (tilt) clamped ~35–65°, radius (zoom) clamped per arena config, alpha (orbit) freely adjustable but with a **snap-back-to-default** option.
- Follows the player ship with smoothed lag; slight look-ahead toward current move order.
- **Touch:** pinch = zoom, two-finger drag = orbit/tilt. **One finger never moves the camera** — single-finger input is 100 % reserved for gameplay.
- All limits/speeds in `camera.json` (tunable).

### 2.2 Movement — Order-Based, One Finger ⚠️ RETIRED (see FLIGHT.md §1/§2/§4)

> Movement is now **continuous flight**: one level-triggered
> `{ kind: "flight", throttle, turn, boost }` order that the sim keeps
> integrating until it is replaced, steered from a left virtual joystick and a
> right-edge throttle strip. There are no move orders, no arrival steering, no
> asteroid avoidance (ships eat `impactDamage`), no path markers, and no
> `target` order — targeting is automatic and gated by a timed sensor lock.
> The one surviving claim below is the **2.5D planar sim**, which flight kept.

- **Tap on arena ground plane** → ship travels to that point at nominal speed (seek + arrival steering, asteroid avoidance).
- **Double-tap** → same, but with **afterburner/boost** engaged (if a boost module is fitted and has energy/heat headroom); boost params from the module config.
- **Tap on an enemy ship** → set as focused target (ring indicator, as in reference image). With no focused target, auto-targeting picks per tunable policy (`nearest | lowestHp | attacker`).
- Move orders render as a **dashed path line + destination marker** (reference image).
- Navigation happens on the **arena plane (2.5D sim)** — full 3D visuals, planar tactics. This is the key simplification that makes one-finger play, readable LoS, AI, and netcode all tractable. Slight vertical bobbing/banking is cosmetic only.
- Tap vs double-tap vs pinch disambiguation handled by a small input state machine (tunable double-tap window, ~250 ms).

### 2.3 Modules — The Heart of Combat

Every fittable item is a **module** on a ship **hardpoint**, and every module runs the same generic state machine:

```
retracted ──(tap: activate)──► deploying (deployTime s)
    ▲                                │
    │                                ▼
retracting (retractTime s) ◄──(tap: deactivate)── ACTIVE
                                     │
                     [weapons] auto-fire when target in range + LoS
                     [shield]  absorbs damage while active
                     [boost]   consumed by double-tap orders
                                     │
                        heat ≥ overheatThreshold
                                     ▼
                          OVERHEATED (forced offline,
                          cooldownTime s + optional self-damage)
```

- **Energy:** ship has a capacitor (`energyMax`, `energyRegen`). Each active module drains `drawIdle` continuously and `drawActive` while firing/absorbing/boosting. Capacitor empty → modules brown-out per tunable priority order. Retracting a module frees its draw — but redeploying costs `deployTime` seconds. **Judgement call by design.**
- **Heat:** ship has `heatCapacity` and `heatDissipation`. Firing/boosting generates heat per module (`heatPerUse`/`heatPerSec`). Cross the module's `overheatThreshold` → forced shutdown; cross ship-level critical heat → hull damage per second (all tunable). Players deactivate modules proactively to manage heat.
- **Auto-fire:** active weapons fire automatically when the focused (or auto-selected) target is within `range` **and has line of sight** (raycast vs asteroid/obstacle colliders, server-authoritative). No aiming input — combat skill = positioning + module timing.
- **Module families (MVP):** `laser` (energy dmg, instant, shield-strong), `kinetic` (projectile travel, hull-strong), `missile` (homing, LoS at launch, can be outrun/blocked), `shield` (active mitigation, heavy idle draw), `boost` (enables double-tap afterburner), plus passive `utility` slots post-MVP. Damage types vs shield/hull resist matrix — all in config.
- **UI:** each fitted module = one radial button bottom-right (reference image): tap toggles activate/deactivate; button shows state ring (deploying progress, active glow, heat fill, overheat flash, no-energy dim). Button layout auto-generated from the ship's fitting.

### 2.4 Ship Core Systems (Upgradeable)

Independent of modules, each ship has four upgrade tracks (levels bought with credits, values per level in config):

| Track | Governs |
|---|---|
| **Hull** | Hit points, kinetic/energy resists |
| **Engine** | Nominal speed, turn/accel, afterburner efficiency |
| **Energy** | Capacitor size, regen rate |
| **Heat** | Heat capacity, dissipation rate |

Ship class + upgrades + fitted modules = final stats, resolved by one deterministic effect stack.

### 2.5 Pre-Match Fitting

In the Hangar, before queueing: choose ship → view hardpoints (count/types per ship config) → drag modules from owned inventory onto hardpoints → live stat panel (energy budget bar: total idle draw vs regen, heat projection, DPS, EHP) warns about non-viable fits (e.g., idle draw > regen). Save as named fitting; fitting id is what's sent at match join.

---

## 3. Tech Stack

| Layer | Technology | Version (pin at start) | Why Chosen | How It Supports Data-Driven Design |
|---|---|---|---|---|
| Language | **TypeScript** | 5.x (strict) | Type safety across client + server + shared configs | Config interfaces inferred from schemas |
| 3D Engine | **Babylon.js** | 8.x latest stable | Full-featured, WebGPU-ready (WebGL2 fallback), built-in GUI, `SceneOptimizer`, glTF, picking/raycasts for tap-to-move & LoS | Scene built from JSON arena configs; `Scene.pick` ground-plane taps; `Ray` LoS checks; `AssetContainer` content packs |
| Build Tool | **Vite** | 7.x | Instant HMR, LAN host for phone testing | Custom plugin = **hot-reload of JSON configs** |
| Multiplayer | **Colyseus** | 0.16.x | Authoritative rooms, `@colyseus/schema` delta sync, matchmaking | Generic `ArenaRoom` loads any arena/mode config; **order-based inputs = tiny messages** |
| Server Runtime | **Node.js** | 22 LTS | Shared TS sim client+server | Same config loader + validation both sides |
| Validation | **Zod** | 4.x | Schema = validator = TS type | Every config validated on load; **editors generate their panels from the Zod schemas** |
| Database | **SQLite** via `better-sqlite3` | latest | Zero-ops MVP scale | Accounts, upgrades, fittings, **user-created configs as JSON** |
| Auth | `jsonwebtoken` + `argon2` | latest | Standard JWT + guest tokens | JWT → playerId → server loads that player's fitting |
| Physics | Custom 2.5D (circle sweeps on arena plane + LoS raycasts) | — | Deterministic, cheap, identical client/server | Collider sizes, ranges, LoS rules all config |
| UI | HTML/CSS overlay (menus, module buttons) + Babylon GUI (in-world markers) | — | HTML radial buttons = easiest to theme/scale; in-world target rings & path lines in Babylon | **Theme/UIUX Editor** restyles HTML via CSS variables from `theme.json` |
| Assets | Procedural meshes + **glTF** import | glTF 2.0 | No art dependency; future-proof | Visual recipes in config; placeholders tagged `[MODEL: x]` |
| Testing | **Vitest** + Playwright smoke | latest | Vite-native | Schema, effect-stack, energy/heat sim, determinism tests |
| Deploy | Docker → Fly.io/Railway/VPS; PWA client | — | Simple single container | Content packs deploy as data — no rebuild |

**Renderer note:** `EngineFactory.CreateAsync(canvas)` — WebGPU with automatic WebGL2 fallback; test both from Phase 0.

---

## 4. Project Architecture & Editor Constellation

### 4.1 Monorepo Folder Structure

```
space-arena/
├── package.json                  # npm workspaces root
├── client/
│   └── src/
│       ├── main.ts
│       ├── core/                 # ConfigService, EntityFactory, SceneBuilder,
│       │                         # EventBus, AssetRegistry, ThemeService
│       ├── ecs/
│       │   ├── components/       # Transform, FlightState, Hull, Shield, Capacitor,
│       │   │                     # HeatSink, Hardpoints, ModuleState[], Collider, AIProfile
│       │   └── systems/          # NavigationSystem, ModuleSystem, EnergySystem,
│       │                         # HeatSystem, TargetingSystem (LoS), CombatSystem,
│       │                         # CollisionSystem
│       ├── game/
│       │   ├── TacticalCamera.ts # chase rig in match; ArcRotate for the editor
│       │   ├── hud/              # joystick, throttle strip, boost, lock reticle,
│       │   │                     # module buttons, energy/heat gauges, minimap,
│       │   │                     # target brackets, notifications
│       │   └── screens/          # MainMenu, Hangar(Fitting), Matchmaking, Arena, Results
│       ├── net/                  # NetClient, OrderReplication, Interpolation
│       └── editor/               # 🛠 EDITOR CONSTELLATION (lazy chunk, F10)
│           ├── EditorShell.ts    # dock layout, mode toggle, Problems panel
│           ├── SchemaFormGen.ts  # Zod schema → property panel (powers ALL editors)
│           ├── MapEditor.ts
│           ├── AssetEditor.ts    # asset states (see 4.3)
│           ├── ShipFittingEditor.ts
│           ├── ActionEditor.ts
│           ├── EventEditor.ts
│           ├── NotificationEditor.ts
│           ├── ThemeEditor.ts
│           ├── TuningPanel.ts
│           ├── ProgressionEditor.ts
│           ├── BehaviorEditor.ts # bots + win conditions (genre-specific)
│           └── PackIO.ts         # export/import content packs
├── server/
│   └── src/
│       ├── rooms/ArenaRoom.ts    # ONE generic room; behavior from configs
│       ├── sim/                  # authoritative sim (imports /shared)
│       ├── bots/BotDriver.ts     # emits the same ORDERS as human clients
│       ├── auth/  db/  api/
├── shared/
│   └── src/
│       ├── schemas/              # Zod: ship, module, upgrade, arena, asteroid,
│       │                         # gamemode, botprofile, action, event,
│       │                         # notification, theme, tuning, progression, camera
│       ├── sim/                  # navigation, module state machine, energy/heat,
│       │                         # LoS, ballistics, collision — client & server
│       ├── messages.ts           # typed order/ack contracts
│       └── constants.ts
├── content/                      # 📦 ALL GAME CONTENT (JSON only)
│   ├── ships/  modules/  upgrades/  arenas/  asteroids/
│   ├── gamemodes/  bots/  actions/  events/  notifications/
│   ├── themes/  tuning/  progression/  camera/
│   └── manifest.json
└── tools/                        # validate-content, gen-types, seed-db
```

### 4.2 Config Loading System

```
content/*.json ──► ConfigService.load(manifest)
                      │  Zod .safeParse() per file
                      │    ├─ ok  → typed, frozen object in registry
                      │    └─ err → structured error → Editor "Problems" panel
                      ▼
              ConfigRegistry (Map<type, Map<id, Config>>)
                      │
        ┌─────────────┼──────────────────┐
        ▼             ▼                  ▼
  EntityFactory   SceneBuilder      ArenaRoom (server)
```

- Every config: `id`, `type`, `version`; cross-references **by string id**, resolved & validated at load (fail fast on dangling ids).
- **Hot-reload (dev):** Vite plugin watches `content/` → HMR push → `ConfigService.replace(id)` → `config:changed` event → live systems rebuild. Balance iteration in seconds.
- **Server trust boundary:** clients send **ids and orders only** (fitting id, move target, module toggle). Server re-validates everything against its own registry. Never raw stats.

### 4.3 The Editor Constellation 🛠

All editors are panels inside the in-browser Editor Shell (F10, dev lazy chunk), and **all property panels are generated from the Zod schemas by SchemaFormGen** — one component, ten editors. Everything each editor saves is id-linked data another editor can reference.

| Editor | Edits | Links to |
|---|---|---|
| **Map Editor** | Arena bounds, asteroid/obstacle placement (gizmos, snap), spawn points, trigger zones | asteroids, events (zone → `event.*`), gamemodes |
| **Asset Editor** | Every asset (ship visual, asteroid, prop, projectile, explosion) with **unlimited states** (e.g. asteroid `intact / cracked / destroyed`), each state = own model recipe/`[MODEL: x]`, own triggers, own linked actions | actions, events, Map Editor palette |
| **Ship & Fitting Editor** | Ship classes: core stats, upgrade tracks (hull/engine/energy/heat per level), hardpoint layout, procedural visual recipe; **Module workbench**: full module configs (state machine timings, energy, heat, damage, range) + **energy/heat budget simulator & TTK matrix** | modules ↔ ships, progression (prices/level gates) |
| **Action Editor** | Reusable data actions: `apply_damage`, `spawn_entity`, `apply_buff`, `impulse`, `play_sound [SOUND: x]`, `show_notification`, `change_asset_state`, `grant_reward` | referenced by modules, events, quests — new module behaviors composed from actions, not code |
| **Event Editor** | Triggers → actions: `on_shield_down`, `on_overheat`, `on_enter_zone`, `on_kill`, `on_match_start`, `on_low_energy` | actions, notifications, Map zones, gamemodes |
| **Notification Editor** | In-match toasts/warnings/popups: text, style, duration, trigger event (e.g. `event.on-overheat` → "WEAPON OVERHEATED") | events, theme |
| **Theme / UIUX Editor** | Colors, fonts, HUD layout & scale, module-button size/position/radius, safe-area offsets — whole game reskinnable from `theme.json` (CSS variables + HUD params) | every screen & HUD element |
| **Tuning Panel** | Catch-all knobs: tick rate, double-tap window, camera clamps, targeting policy, drag, global damage multipliers, feature flags — anything not owned by another editor | everywhere |
| **Progression Editor** | XP curve, level unlocks, credit rewards per mode, upgrade prices, module level gates | gamemodes, ships, modules |
| **Behavior Editor** *(genre-specific)* | Bot profiles (weights, ranges, aim of module usage, heat/energy discipline) + **win-condition/rule builder** for gamemodes | botprofiles, gamemodes, events |
| **PackIO** | Export/import content packs (zip of JSON + manifest), dependency graph auto-resolved | all of the above |

### 4.4 Example Configs

```jsonc
// content/ships/interceptor.json
{
  "id": "ship.interceptor", "type": "ship", "version": 2,
  "name": "Interceptor", "class": "light",
  "core": {
    "hull":   { "base": 80,  "resists": { "kinetic": 0.1, "energy": 0.0 } },
    "engine": { "nominalSpeed": 34, "accel": 22, "turnRate": 3.0 },
    "energy": { "capacitor": 120, "regen": 14 },
    "heat":   { "capacity": 100, "dissipation": 9, "criticalDamagePerSec": 4 }
  },
  "upgradeTracks": { "hull": "upgrade.hull-std", "engine": "upgrade.engine-std",
                     "energy": "upgrade.energy-std", "heat": "upgrade.heat-std" },
  "hardpoints": [
    { "id": "hp1", "accepts": ["laser", "kinetic"] },
    { "id": "hp2", "accepts": ["missile", "kinetic"] },
    { "id": "hp3", "accepts": ["shield"] },
    { "id": "hp4", "accepts": ["boost", "utility"] }
  ],
  "defaultFitting": ["module.laser-mk1", "module.missile-mk1", "module.shield-mk1", "module.boost-mk1"],
  "render": { "recipe": "procedural.arrowhead", "palette": { "primary": "#2f6fb8", "accent": "#57d8ff" } },
  "collider": { "shape": "circle", "radius": 1.4 }
}
```

```jsonc
// content/modules/laser-mk1.json — the generic module contract
{
  "id": "module.laser-mk1", "type": "module", "version": 1,
  "family": "laser", "level": 1, "name": "Pulse Laser Mk I",
  "activation": { "deployTime": 1.5, "retractTime": 1.0 },     // seconds, tunable
  "energy":     { "drawIdle": 3, "drawActive": 11 },           // per second
  "heat":       { "perSecondActive": 6, "overheatThreshold": 55,
                  "overheatCooldown": 5.0, "overheatSelfDamage": 0 },
  "fire":       { "mode": "held",                              // held trigger; "semi" fires on rising edges
                  "range": 38, "cycleTime": 0.4,
                  "damage": 7, "damageType": "energy",
                  "requiresLineOfSight": true,
                  "projectile": null },                        // null = beam; kinetic/missile define speed/homing
  "onFire":     ["action.play-sound-laser"],                   // Action Editor links
  "onOverheat": ["action.notify-overheat"],
  "ui": { "icon": "[ICON: laser]", "label": "Laser" },
  "price": 0, "requiresLevel": 1
}
```

**One schema, every module family.** `shield` uses `mitigation` instead of `fire`; `boost` uses `boost { speedMult, heatPerSec }`; a new family = new optional block interpreted by the generic `ModuleSystem` — new module *instances* = pure JSON.

---

## 5. Phase 0 — Setup & Foundation

**Goal:** Engine skeleton: monorepo builds, config pipeline validates & hot-reloads, config-defined arena renders under the tactical camera at 60 FPS.
**Agent mix:** mostly **Sonnet**; **Opus** for schemas/ConfigService/game loop.

- [ ] **0.1 Monorepo scaffold** — npm workspaces (`client`, `server`, `shared`), strict tsconfig, ESLint/Prettier, Vitest, README stub. *(Sonnet)*
- [ ] **0.2 Vite client bootstrap** — `EngineFactory.CreateAsync` (WebGPU→WebGL2), resize handling, FPS counter, `--host` for phone testing. *(Sonnet)*
- [ ] **0.3 Zod schema foundation** — author all schemas in `shared/schemas` (ship, module, upgrade, arena, asteroid, gamemode, botprofile, action, event, notification, theme, tuning, progression, camera); inferred TS types; `tools/validate-content.ts` CLI (pre-commit + CI). *(Opus — the contract everything builds on)*
- [ ] **0.4 ConfigService + Registry** — manifest load, `safeParse` with readable error aggregation, cross-reference/dangling-id resolution, frozen objects, typed getters. *(Opus)*
- [ ] **0.5 Config hot-reload** — Vite plugin watching `content/**/*.json` → HMR push → `ConfigService.replace()` → `config:changed`; demo: edit asteroid scale live. *(Opus)*
- [ ] **0.6 SceneBuilder v0** — arena bounds (`circle|rect`), boundary visual (glowing ring-station torus per reference image, `GlowLayer`), starfield/nebula skybox, light rig, spawn markers. *(Sonnet)*
- [ ] **0.7 Tactical camera v0** — clamped `ArcRotateCamera` rig from `camera.json` (beta/radius limits, follow smoothing, look-ahead); mouse wheel zoom + right-drag orbit on desktop. *(Sonnet)*
- [ ] **0.8 Procedural asset recipes v0** — `AssetRegistry`: arrowhead ship, 2–3 asteroid variants (icosphere + noise), palette from config; visuals read well **from above** (the only view that matters now). *(Sonnet)*
- [ ] **0.9 Fixed-timestep loop** — render via `runRenderLoop`; **separate 30 Hz fixed sim accumulator** in `shared/sim` (reused verbatim server-side in Phase 2); render interpolation between sim steps. *(Opus)*
- [ ] **0.10 EventBus + logging** — typed pub/sub; namespaced logger with URL-flag levels. *(Sonnet)*

**Key APIs:** `EngineFactory.CreateAsync`, `ArcRotateCamera` (+ `lowerBetaLimit/upperBetaLimit/lowerRadiusLimit/upperRadiusLimit`), `MeshBuilder`, `VertexData`, `GlowLayer`, `Scene.onBeforeRenderObservable`.

**Perf from day 1:** shared materials, thin-instance candidates identified, DPR capped at 2, `setHardwareScalingLevel` hook exposed.

**Exit criteria:** Config-defined arena viewed through clamped tactical camera; JSON edits hot-reload < 1 s; `validate:content` gates bad configs; 60 FPS desktop.

---

## 6. Phase 1 — Core Single-Player Loop + Editor Tools

**Goal:** The full one-thumb combat model working single-player: movement, module state machine, energy/heat, LoS auto-fire, destructible asteroids, target dummies — plus the first editors. *(Tasks 1.1 and 1.2 shipped as written and were later replaced by the flight model — see FLIGHT.md.)*
**Agent mix:** **Opus** for navigation/module/energy-heat systems, **Codex** for the editor framework, **Sonnet** for HUD.

### 6A — Orders, Modules & Combat (all values from config)

- [ ] **1.1 Order input system** ⚠️ **RETIRED — superseded by FLIGHT.md §4.** The current input path is a virtual joystick (`turn`) + throttle strip + boost button + desktop key bindings, all emitting the single `flight` order; the module button tap → `ModuleToggleOrder` half of this task survives unchanged. `OrderInput.ts`, the ground-plane pick and the double-tap window are deleted. *(Opus)*
- [ ] **1.2 NavigationSystem** ⚠️ **PARTIALLY RETIRED — see FLIGHT.md §1.** NavigationSystem now integrates a persistent `FlightState`: `heading += turn * turnRate * dt`, `desiredSpeed = throttle * nominalSpeed * boostMult` approached at `accel`. Seek/arrival steering, asteroid avoidance and path/destination rendering are gone (ships take `impactDamage` from CollisionSystem instead); turn-rate-limited banking visuals and the boost energy/heat cost survive. *(Opus)*
- [ ] **1.3 Module state machine ⭐** — generic `ModuleSystem` implementing §2.3 exactly: retracted/deploying/active/retracting/overheated, timers from config, per-family behavior blocks (`fire`, `mitigation`, `boost`) interpreted generically; `onFire/onOverheat/on*` hooks dispatch **Action Editor actions by id**. *(Opus — the heart of combat, build once, never fork)*
- [ ] **1.4 Energy & Heat systems** — capacitor drain (idle vs active draws), regen, brown-out priority; heat accumulation/dissipation, module overheat shutdown, ship critical-heat hull damage. Deterministic, in `shared/sim`. *(Opus)*
- [ ] **1.5 TargetingSystem + LoS** — focused/auto target selection (tunable policy); **line-of-sight raycasts** against asteroid colliders on the arena plane (cheap 2D segment-vs-circle, not Babylon raycast, so it's identical server-side); LoS state drives auto-fire and target ring style. *(Opus)*
- [ ] **1.6 CombatSystem** — beams (instant, cycle-timed), kinetic projectiles (pooled, travel time), missiles (pooled, turn-rate-limited homing, LoS at launch); damage types vs shield/hull resists; shield-module mitigation while active; death → explosion (pooled particles) → respawn per gamemode. *(Opus, Sonnet for VFX)*
- [ ] **1.7 CollisionSystem** — circle-vs-circle on plane (ships, projectiles, asteroids) + boundary rule from gamemode (`bounce | damage | warning`); **spatial hash grid** sized from arena config; asteroid `impactDamage`, `destructible`, `hp` from config; destroyed asteroids change **Asset Editor state** (`intact → destroyed`) — LoS updates automatically. *(Opus)*
- [ ] **1.8 HUD v1** — HTML overlay: **module radial buttons bottom-right** (auto-generated from fitting; state ring: deploy progress / active glow / heat fill / overheat flash / energy dim), energy + heat gauges, hull/shield bars, minimap (2D canvas blips), notifications area. Babylon GUI/meshes: target rings, path lines, off-screen enemy indicators, floating damage numbers. All layout params from `theme.json`. *(Sonnet)*
- [ ] **1.9 Practice mode** — `gamemode` config spawning stationary/orbiting dummies; win conditions as data (`{"type":"destroyTargets","count":3}`); proves rules interpreter. *(Sonnet)*

### 6B — Editor Constellation v1

- [ ] **1.10 Editor Shell** — F10 toggle (lazy chunk), free camera, dockable HTML panels, pause/step sim, entity list, **Problems panel** (live Zod errors: file, path, message; refuses to save invalid). *(Codex — framework quality pays off for every later editor)*
- [ ] **1.11 SchemaFormGen ⭐** — Zod schema → HTML property panel (number→slider with schema min/max, enum→dropdown, color→picker, nested→collapsible, arrays→add/remove, id-reference fields→**searchable dropdown of matching registry ids**). Writes through `ConfigService.replace()` → instant live preview. **Powers all ten editors.** *(Codex)*
- [ ] **1.12 Map Editor v1** — palette from asteroid/prop configs, click-place, `GizmoManager` move/rotate/scale, snap, spawn points, arena bounds editing, save → validated `arena.json` via dev API. *(Codex)*
- [ ] **1.13 Tuning Panel v1** — flat searchable view over `tuning.json` + `camera.json` (double-tap window, targeting policy, camera clamps, global multipliers); every change hot-reloads into the running practice match. *(Sonnet, on top of 1.11)*
- [ ] **1.14 Asset Editor v1** — asset states list (add/remove states freely), per-state recipe/`[MODEL: x]` placeholder, linked actions/triggers; used first for asteroid `intact/destroyed` states. *(Codex)*
- [ ] **1.15 Action + Notification Editors v1** — CRUD for action configs (the generic primitives: `apply_damage`, `play_sound`, `show_notification`, `change_asset_state`, `apply_buff`, `spawn_entity`) and notification configs (text/style/duration/trigger event). Wire `module.laser-mk1.onOverheat → action.notify-overheat → notification.overheat-warning` as the proof chain. *(Sonnet, on top of 1.11)*

**Key APIs:** `Scene.pick` + predicate mesh (ground plane), `PointerEventTypes`, `GizmoManager`, thin instances, `ParticleSystem`, `AdvancedDynamicTexture` (world-space markers), CSS custom properties (theming).

**Perf notes:** projectiles/particles 100 % pooled; LoS checks are 2D math (no engine raycasts) throttled to sim tick; HUD DOM updated only on state change (no per-frame innerHTML).

**Exit criteria:** One finger (or mouse) plays a full practice match: move, boost, toggle modules, manage heat/energy, use asteroid cover to break enemy LoS; a new arena AND a new laser variant created **entirely via editors**; overheat chain (event → action → notification) works from pure data.

---

## 7. Phase 2 — Multiplayer Infrastructure

**Goal:** Authoritative Colyseus server running the shared sim; 1v1 & 2v2 with matchmaking; order replication with responsive feel; arenas/gamemodes loaded from config server-side.
**Agent mix:** **Codex** for state schema + replication, **Opus** for room lifecycle, **Sonnet** for lobby UI.

> **Netcode advantage of the new design:** clients send *discrete orders* (move target, module toggle, target select) instead of 60 Hz twitch axes. The server simulates; clients **optimistically start orders locally** (path preview, deploy animation) and smoothly correct to server truth. No per-input rewind/replay reconciliation needed — an order-ack + snapshot-interpolation model is enough. **This cuts the hardest task of v1 roughly in half.**

- [ ] **2.1 Colyseus bootstrap** — Express + `@colyseus/core`, `@colyseus/monitor` (dev), health endpoint, `shared/` server-side, Dockerfile. *(Sonnet)*
- [ ] **2.2 State schema design** — `ArenaState { players: MapSchema<PlayerState>, projectiles (missiles only), asteroids (hp/state only — layout comes from config both sides), matchPhase, timer }`. `PlayerState` includes position (quantized int16), velocity, heading, hull/shield, **energy, heat, per-module state enum + timer** (drives remote players' button-independent visuals: deployed turrets, shield bubble). Quantize floats; sync only what clients can't derive. *(Codex)*
- [ ] **2.3 Generic `ArenaRoom`** — `onCreate(options)` loads gamemode + arena configs → server sim world with the **same `shared/sim` systems, 30 Hz tick** from 0.9; `onAuth` JWT; `onJoin` validates fitting id against registry + ownership; team assignment; phase machine (warmup → live → results) from gamemode config. **One room class, every mode.** *(Opus)*
- [ ] **2.4 Order protocol** — `room.send("order", {seq, kind: move|boost|target|moduleToggle, payload})`; server validates (in-bounds target, owned module, legal state transition), applies to sim, acks `{seq, accepted}`; rate-limit orders/sec (anti-spam). Tiny bandwidth. *(Codex)*
- [ ] **2.5 Optimistic orders + correction** — client starts move/deploy locally on tap (instant feedback: path line, deploy ring); on ack + snapshots, blend position/timers toward server truth (exponential for small error, snap for large); rejected orders roll back UI with a notification. *(Codex)*
- [ ] **2.6 Snapshot interpolation** — render all ships ~100 ms behind server time from a snapshot buffer; velocity-aware hermite interpolation; extrapolate max 1 tick on loss. (Local ship: optimistic sim, corrected — see 2.5.) *(Codex)*
- [ ] **2.7 Server-authoritative combat & LoS** — all hits, damage, energy, heat, overheat resolved server-side only (auto-fire means no lag-compensated aiming at all — server checks range+LoS on its own tick); clients render tracers/beams from state + fire events. *(Opus)*
- [ ] **2.8 Matchmaking + lobby** — `define('arena', ArenaRoom).filterBy(['gamemode'])`; mode list **generated from gamemode configs**; ready-up; **bot backfill** after tunable wait (stub bots: idle → real AI Phase 5). *(Opus)*
- [ ] **2.9 Network debug tools (editor suite)** — latency/jitter/loss simulator, overlay graph: RTT, correction error magnitude, snapshot rate, bytes/s. *(Sonnet)*

**Key APIs:** `Room.onCreate/onAuth/onJoin/onLeave`, `setSimulationInterval(dt, 1000/30)`, `setPatchRate(50)`, `@colyseus/schema` (`@type`, `MapSchema`), `client.joinOrCreate`, `room.send/onMessage`, `state.listen/onAdd/onRemove`.

**Perf notes:** patch 20 Hz; beams as events + client rendering (no schema entries); only missiles get schema-synced entities.

**Exit criteria:** Two browsers + phone on LAN complete 1v1 and 2v2 (stub bots); orders feel instant at 150 ms simulated latency; Map-Editor-made arena playable online by id (S5 ✅).

---

## 8. Phase 3 — Authentication & Persistence

**Goal:** Accounts, sessions, persistence of progression, **ship upgrades, fittings, and player-created content**.
**Agent mix:** **Sonnet** CRUD/forms, **Opus** auth flow & data model.

- [ ] **3.1 DB setup** — `better-sqlite3` + SQL migrations. Tables: `users`, `profiles(user_id, display_name, level, xp, credits)`, `ship_upgrades(user_id, ship_id, hull_lvl, engine_lvl, energy_lvl, heat_lvl)`, `owned_modules(user_id, module_id, qty)`, `fittings(id, user_id, ship_id, hardpoint_map JSON, name)`, `user_configs(id, user_id, type, json, visibility)` ⭐, `match_results`. *(Opus)*
- [ ] **3.2 Auth API** — register (argon2), login, **guest** (server token in `localStorage`, upgradeable to full account keeping progress), JWT access+refresh; Colyseus `onAuth` verifies. *(Opus)*
- [ ] **3.3 Client auth UI** — responsive login/register/guest screens; session restore; one-tap guest-into-game default. *(Sonnet)*
- [ ] **3.4 Progression service** — XP/credits granted server-side from `match_results` using **Progression Editor configs** (reward rules per gamemode, level curve, unlock gates). *(Sonnet)*
- [ ] **3.5 Fitting & upgrade persistence** — REST CRUD; server validates every module against hardpoint `accepts` + ownership + level gates (shared Zod logic); **energy-budget sanity check server-side** (reject fits the client UI would warn about? No — allow risky fits, only reject illegal ones); fitting id passed at room join. *(Sonnet)*
- [ ] **3.6 User config storage & sync** — editor "Save to account" → `user_configs` under `user.` id namespace (collision-proof); merges into client registry on login; server loads user arenas on demand for custom rooms. *(Opus)*
- [ ] **3.7 Hardening** — rate limits, payload caps, Zod on every API boundary. *(Sonnet)*

**Exit criteria:** Guest persists across restarts; registered user logs in elsewhere with same credits/upgrades/fittings; account-saved custom arena hostable online (S4 ✅).

---

## 9. Phase 4 — Ships, Modules & Data-Driven Content

**Goal:** Full content model: 3 ship classes with upgrade tracks, ~12 modules across 5 families, hangar fitting UX — and the editors that make more of them code-free.
**Agent mix:** **Opus** for effect/upgrade resolution, **Codex** for Ship & Fitting Editor, **Sonnet** for hangar UI & content authoring.

- [ ] **4.1 Stat resolution stack ⭐** — deterministic pipeline: ship class base → upgrade track levels (`upgrade.*` configs: per-level add/mul on core stats) → module passives → runtime buffs (add → mul → clamp order). One resolver used by sim, hangar stat panel, balance workbench, and bots. *(Opus)*
- [ ] **4.2 Upgrade track content** — `upgrade.*` configs for hull/engine/energy/heat (5 levels each: values + credit prices); Hangar upgrade UI with per-level diff preview. *(Sonnet)*
- [ ] **4.3 Three ship classes** — `interceptor` (fast, 4 hardpoints, small capacitor), `brawler` (slow, tanky, 5 hardpoints, big heat capacity), `support` (medium, utility-leaning hardpoints) — **authored entirely as JSON via editors**; distinct top-down silhouettes + palettes. *(Sonnet)*
- [ ] **4.4 Module catalog (~12)** — 2 lasers, 2 kinetics, 2 missiles, 2 shields, 2 boosts, 2 utility (e.g. capacitor battery = passive energy mod, heat sink = passive heat mod) with levels, prices, gates. Every one exercises only the generic module schema. *(Sonnet)*
- [ ] **4.5 Hangar / Fitting screen** — 3D top-down ship preview (`AssetContainer` isolated scene), hardpoint slot grid, module inventory filtered by `accepts`/owned/level, drag-to-fit (tap-to-fit on mobile), **live budget panel**: idle-draw vs regen bar, projected heat under sustained fire, DPS/EHP diffs (green/red via the 4.1 resolver), viability warnings; buy modules/upgrades with credits; save named fittings. Responsive: side panel desktop / bottom sheet mobile. *(Sonnet UI + Opus resolver integration)*
- [ ] **4.6 Ship Manager — 3D socket editor (dev) ⭐** — ships are **socket graphs, not fixed layouts**. A ship config carries a `sockets[]` array; each socket has a 3D transform (position/rotation/scale relative to the hull), a `kind`, and kind-specific props — **nothing about socket count or placement is hardcoded**:
  ```jsonc
  "sockets": [
    { "id": "hp-nose", "kind": "hardpoint", "transform": { "pos": [0, 0.1, 1.8] },
      "accepts": ["laser", "kinetic"] },                        // module 3D model attaches here
    { "id": "eng-l", "kind": "emitter", "transform": { "pos": [-0.6, 0, -1.9] },
      "effect": "fx.engine-trail",                              // effect = its own config type
      "bindings": [ { "source": "throttle",     "param": "emitRate",  "curve": [[0,0],[1,80]] },
                    { "source": "boostActive",  "param": "power",     "curve": [[0,1],[1,2.2]] } ] },
    { "id": "smoke-hull", "kind": "emitter", "transform": { "pos": [0.3, 0.15, 0.4] },
      "effect": "fx.damage-smoke",
      "bindings": [ { "source": "hullFraction", "param": "emitRate", "curve": [[1,0],[0.5,0],[0.2,60]] } ] }
  ]
  ```
  - **Hardpoint sockets** replace the flat `hardpoints[]` list (sim consumes the derived ordered list; renderer attaches module models at socket transforms).
  - **Emitter sockets** drive particle effects from a **runtime signal registry** (throttle, boostActive, hullFraction, heatFraction, shieldActive, moduleFiring, …) through per-binding response curves — engine trails, damage smoke, overheat venting are pure data. New signals are one registry entry; new effect configs (`content/effects/*.json`) are pure content.
  - Socket kinds are an extensible enum (hardpoint | emitter today; lights, shield anchors, tow points later) — the renderer dispatches per kind, unknown-kind configs fail validation loudly.
  - **Ship Manager editor panel**: pick ship → orbitable 3D preview → add/remove/duplicate sockets of any kind, drag them in 3D with gizmos, edit all props via SchemaFormGen, **signal simulator sliders** (throttle/damage/heat) to preview emitter behavior live, save to config. *(Opus)*
- [ ] **4.6b Balance workbench** — module workbench with **sustained-combat simulator** (energy & heat over a 60 s engagement for a given fit) and **TTK matrix** across ships × fits; edits hot-reload into a running practice match. *(Opus)*
- [ ] **4.7 Content pack round-trip v1** — PackIO export (selected configs + dependency graph) / import (schema version + id-collision checks, rename-on-conflict). *(Opus)*

**Key APIs:** `AssetContainer`, mesh merging/CSG (procedural hulls), `PBRMaterial`, glTF `SceneLoader.ImportMeshAsync` stub for future art (`[MODEL: x]` placeholders until then).

**Exit criteria:** 3 ships + 12 modules + 4 upgrade tracks exist as pure content; fitting choices visibly matter online; **a new 4th ship and a new module family instance created via editors only, playable in multiplayer** (S2 ✅); a heat-disciplined player beats a stat-identical spam player (S7 ✅).

---

## 10. Phase 5 — Polish, Bots, Mobile & Advanced Tools

**Goal:** Data-driven bots that manage modules like players, flawless one-thumb mobile UX, performance to target, juice, completed editor constellation.
**Agent mix:** **Opus** AI architecture, **Codex** perf + Behavior Editor, **Sonnet** touch UI/juice/sound.

### 10A — Data-Driven Bots

- [x] **5.1 Bot architecture** — server-side `BotDriver` emits the **same orders as human clients** (move targets, module toggles, target selects) through the identical pipeline ⇒ bots obey all rules by construction. Utility-based decisions (engage / kite to range / break-LoS behind asteroid / retreat / manage-modules) with all weights, ranges, thresholds from `botprofile` config:
  ```jsonc
  { "id": "bot.aggressive", "type": "botprofile",
    "decisionIntervalMs": 400, "orderJitterMs": 150,
    "preferredRange": [20, 35],
    "behaviors": {
      "engage":   { "baseWeight": 1.0, "doubleTapBoostChance": 0.4 },
      "breakLoS": { "baseWeight": 0.7, "triggerHullBelow": 0.4 },
      "retreat":  { "baseWeight": 0.3, "triggerShieldDown": true }
    },
    "moduleDiscipline": { "heatShutdownAt": 0.85, "reactivateBelow": 0.5,
                          "energyReserve": 0.15, "shieldOnlyWhenEngaged": true } }
  ```
  `moduleDiscipline` makes bot skill = same skill axis as players (heat/energy judgement), and difficulty = config. *(Opus)*
- [x] **5.2 Bot tactics** — *(rewritten for flight, FLIGHT.md §7: bots emit the same `flight` orders a player does — aim point → `turn` axis via a measured hull turn rate — and hold no target order at all.)* orbit-at-range steering, cover-seeking = pick points that break enemy LoS (sample points behind asteroids using the same LoS math), missile-dodge repositioning. *(Opus)*
- [x] **5.3 Behavior Editor (dev)** — SchemaFormGen over botprofile + **live debug overlay** (current behavior, utility scores, chosen move point, LoS lines) during practice; **win-condition/rule builder** for gamemodes (dropdown-driven conditions, timers, scoring, boundary rules). *(Codex)*

### 10B — Mobile & One-Thumb UX

- [x] **5.4 Touch input hardening** — the §2.2 input state machine on real devices: tap-slop, double-tap window, pinch/orbit vs tap disambiguation, palm rejection at screen edges; **portrait AND landscape layouts** (reference image is portrait — support both, layout from `theme.json`); module button cluster size/arc/position tunable in Theme Editor; haptics (`navigator.vibrate`) on overheat/kill (tunable). *(Sonnet, Opus if feel needs tuning)*
- [x] **5.5 Responsive UI pass** — all screens 360×640 → 4K, safe-area insets, HUD scale by theme config, one-thumb reachability audit on every in-match interaction (S3's "one thumb" clause). *(Sonnet)*
- [x] **5.6 Mobile performance sprint** *(Codex — measure first)*:
  - `SceneOptimizer` custom priorities; quality tiers (`low/med/high`) in `quality.json`, auto-selected by device probe + first-seconds FPS
  - Thin instances for asteroids/tracers; `freezeActiveMeshes()`, `material.freeze()` on statics
  - `setHardwareScalingLevel` per tier (low = 0.75× internal res); DPR cap
  - LOD on asteroid masters (`addLODLevel`) — cheap win since camera distance band is known/clamped
  - Zero per-frame allocations in sim & render hot paths; DOM HUD mutations only on state change
  - Particle budgets per tier (config)
  - **Verify on real mid-range Android (`--host` + `chrome://inspect`) — measured, not assumed**
- [x] **5.7 Juice & audio** — hit flashes, shield-bubble ripple while shield active, deploy/retract animations on ship (turrets extend — sells the tradeoff), boost trails, camera micro-shake (tunable, subtle at tactical distance), explosion variants; `AudioManager` (Web Audio, pooled), **sound ids referenced from module/action configs** (`[SOUND: laser_fire]` placeholders); volume settings. *(Sonnet)*
- [x] **5.8 Menus & flow polish** — main menu (dark nebula, cyan/orange per reference), settings (quality, audio, camera, control tunables exposed to players where sensible), results screen with XP/credit animations, Theme Editor pass over the whole flow. *(Sonnet)*

**Key APIs:** `SceneOptimizer.OptimizeAsync`, thin instances, `addLODLevel`, Pointer Events multi-touch, `navigator.vibrate`, `Sound`/`AudioEngine`, `GlowLayer` budget tuning.

**Exit criteria:** 2v2 with 3 bots feels like a real match — bots visibly kite, break LoS, and manage heat; difficulty tuned purely in Behavior Editor; ≥ 30 FPS on mid-range phone in the busiest fight, **entire match played with one thumb** (S3 ✅).

---

## 11. Phase 6 — Testing, Deployment & Extensibility

**Goal:** Ship it: CI, targeted tests, production deploy, PWA, content-pack workflow proven end-to-end.
**Agent mix:** **Sonnet** CI/config, **Opus** deploy, **Codex** load testing.

- [ ] **6.1 Test suite (targeted)** — Vitest: all schemas (valid/invalid/edge fixtures), reference resolution, stat resolver, **module state machine transitions**, **energy/heat sim over scripted 60 s engagements** (regression-guards balance), LoS math, sim determinism (same orders ⇒ same state), TTK sanity bounds. Playwright smoke: guest → hangar fit → practice match → result. *(Sonnet)*
- [ ] **6.2 CI pipeline** — GitHub Actions: typecheck, lint, tests, **`validate-content` gate**, bundle budget (< 5 MB initial, editor chunk excluded). *(Sonnet)*
- [ ] **6.3 Production builds** — Vite manual chunks (babylon / game / lazy editor), server Docker (node:22-slim multi-stage), env config (ports, JWT secret, DB path, CORS). *(Sonnet)*
- [ ] **6.4 Deploy** — single container (Colyseus + static + REST) on Fly.io/Railway/VPS, HTTPS/WSS, SQLite persistent volume + nightly backup, health checks, `@colyseus/monitor` behind admin auth. *(Opus)*
- [ ] **6.5 PWA** — manifest + icons, `vite-plugin-pwa` (precache shell, network-first for content JSON so packs update), installable, offline page. *(Sonnet)*
- [x] **6.6 Load & soak testing** — `@colyseus/loadtest`: 20 rooms of bot fights; tick duration, patch bytes/s, 1 h memory soak; audit `dispose()` on room/scene teardown (classic Babylon leak). *(Codex)*
- [x] **6.7 Content pack workflow — final proof** — export full content set → import on prod via admin endpoint → new arena/module live **without redeploy** (S6 ✅); document in `docs/CONTENT.md`. *(Opus)*
  - Admin API `/api/admin/content` — `GET export`, `GET status`, `POST import`, `POST rollback`; `requireAdmin` (401 unauth / 403 non-admin, role read per request), two rate buckets, own 8 MB body cap.
  - Import validates the **entire** pack through `ConfigService` (schemas + typed refs + relational) before touching disk, then stages → fsyncs → atomically renames (`content.previous/` kept for one-step rollback; Windows EPERM handled with backoff + a named error).
  - Honest live-reload scope: `/content/*`, `/health` and **new** rooms use the new pack immediately; **in-flight** matches keep the pack pinned at room creation; open browser tabs refresh on their next load via the network-first SW. No live-match migration.
  - `tools/export-content.ts` (offline bundling) and `tools/pack-proof.ts` (`npm run content:proof` — 40 checks, prod-mode server, single PID).
- [x] **6.8 Telemetry (minimal)** — match results, error rates, avg tick time, client FPS bucket + device class → SQLite; feeds balance & perf. *(Sonnet)*

**Exit criteria:** Public URL; a stranger on a phone guest-joins and fights a bot within 60 s, one-handed; CI green; pack import proven in prod.

---

## 12. Milestones & Estimated Effort

Assumes a **solo developer, ~20 focused h/week, strong AI assistance** under the collaboration rules.

| # | Milestone (checkpoint) | Phase(s) | Est. Effort | Cumulative |
|---|---|---|---|---|
| M0 | **Engine skeleton** — config pipeline + tactical camera over config arena, 60 FPS | 0 | 1.5 wk | 1.5 wk |
| M1 | **"One finger, real decisions"** — tap-to-move + module state machine + energy/heat + LoS auto-fire vs dummies | 1A | 2.5 wk | 4 wk |
| M2 | **First editors** — Shell + SchemaFormGen + Map/Tuning/Asset/Action/Notification v1; *new arena & module with zero code* | 1B | 1.5 wk | 5.5 wk |
| M3 | **Playable 1v1 online with configurable arena** ⭐ — order replication solid at 150 ms | 2 | 2.5 wk | 8 wk |
| M4 | **Persistent players** — accounts, credits, upgrades, fittings survive restarts | 3 | 1.5 wk | 9.5 wk |
| M5 | **Full content model** — 3 ships, 12 modules, upgrade tracks, hangar fitting; *new ship via editors only* | 4 | 2.5 wk | 12 wk |
| M6 | **Bots & mobile** — module-managing AI 2v2, one-thumb UX hardened, ≥ 30 FPS mid-range phone | 5 | 3 wk | 15 wk |
| M7 | **Deployed MVP** — public URL, PWA, CI, load-tested, pack import in prod | 6 | 1.5 wk | 16.5 wk |

> **Total: ≈ 16–17 weeks part-time (≈ 330–350 focused hours).** Full-time equivalent ≈ 8–9 weeks.
> The order-based control scheme **removed** the twitch prediction/reconciliation monster (Phase 2 shrank), but the module/energy/heat depth **added** sim + UX work (Phase 1 grew). Net wash — with lower netcode risk than v1.
> Highest-variance items now: **1.3–1.5 module/energy/heat/LoS core** and **5.6 mobile perf** — pre-assigned Opus/Codex with Fable escalation.

**De-scope levers if behind (in order):** support ship class → utility modules → 2v2 (keep 1v1) → kinetic family (keep laser+missile) → PWA. **Never cut:** config pipeline, SchemaFormGen, or the module state machine — they are the engine.

---

## 13. Risks, Best Practices & Future Extensions

### 13.1 Key Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Combat feels passive** (auto-fire = no aiming) | Boring game | Depth must come from module tradeoffs + LoS play: validate with S7 playtest at M1, *before* multiplayer; tune deploy/retract times & heat curves in Tuning Panel until decisions feel tense; add more active decisions (manual missile volley?) as config-level option if needed |
| **Tap disambiguation on mobile** (tap vs double-tap vs pinch vs orbit) | Frustrating input = dead on arrival | Dedicated input state machine with tunable windows (1.1), hardened on real devices early (5.4); one-finger = gameplay only, camera strictly two-finger |
| **Energy/heat balance spirals** (12 modules × 3 ships × upgrades) | Endless manual rebalancing | Sustained-combat simulator + TTK matrix in Ship & Fitting Editor (4.6); scripted-engagement regression tests (6.1) freeze intended balance |
| **Network sync of module states** | Remote ships' deploy/shield visuals desync | Module state enum + timer in schema (2.2) — cheap, explicit, server-owned |
| **Mobile perf misses 30 FPS** | Half the audience lost | Tactical camera helps (clamped distance band → aggressive LOD); pooling + thin instances from Phase 0; quality tiers in config; **measure on real hardware every phase** |
| **Config validation gaps** | Bad/hostile content crashes server or enables cheating | Zod on every load and API boundary; ids-and-orders-only protocol; reference-graph fail-fast; CI content gate |
| **Editor scope creep** (ten editors!) | Tools eat the schedule | SchemaFormGen makes each editor mostly free — any editor needing significant bespoke UI beyond it gets re-scoped; editors are dev-only lazy chunks |
| **Cheating (open client)** | Ruined matches | Server-authoritative sim; clients send orders only; order rate limits; server-side range/LoS/energy/heat checks from its own configs |
| **Solo-dev burnout / lost context** | Stalls | Phases end playable; roadmap checkboxes as living status; AI tasks kept small and disposable |
| **Babylon/Colyseus version churn** | Mid-project breakage | Pin exact versions Phase 0; upgrade only at phase boundaries with smoke tests |

### 13.2 Engineering Best Practices (project-wide)

1. **Data first:** before coding any feature, define its Zod schema and a sample JSON. If it can't be expressed as data, reconsider the design.
2. **One sim, two hosts:** all gameplay math (navigation, modules, energy, heat, LoS, collisions) lives in `shared/sim`. Never fork it.
3. **One module state machine:** every current and future module family flows through it. New family = new interpreted config block, never a parallel system.
4. **Pool everything that spawns in combat.** Zero allocations in hot loops.
5. **Ids, not objects,** over the wire and in saves; placeholders (`[MODEL: x]`, `[SOUND: x]`, `[ICON: x]`) — never invented asset paths.
6. **Measure, then optimize** — Inspector perf tab + real-device profiling; perf log per phase.
7. **Dispose discipline:** every scene/screen/room teardown disposes meshes, observers, GUI, sounds — audited at each phase exit.
8. **Content is versioned:** `version` per config + pack manifest; loaders warn on mismatch.

### 13.3 How the Engine Enables Post-MVP Expansion

| Future Feature | What It Takes With This Engine |
|---|---|
| New module families (drones, mines, tractor beams, ECM/sensor jamming) | New config block interpreted by the module state machine + Action Editor primitives — the energy/heat/deploy framework is already there |
| New game modes (CTF, king-of-the-hill, shrinking ring) | Gamemode config + at most one new win-condition primitive in the Behavior Editor's rule builder |
| New arenas/hazards (moving fields, gravity wells, damage zones) | Map Editor zones + one new zone-effect action |
| Shop & monetization | Modules/upgrades already priced/gated; storefront UI over existing catalog + transaction table |
| Seasonal balance patches | Tuning Panel / workbench → export pack → import to prod. **No deploy.** |
| Community content | `user_configs` + PackIO exist → sharing/browsing UI + moderation flag |
| Real 3D art | `render.recipe` → glTF path per asset state; `[MODEL: x]` placeholders mark every swap point |
| 4v4+ | Interest management on schema sync — state design (2.2) anticipates it |
| Ranked/ladders | Match results persisted; add rating math + a matchmaking config |
| Free-flight chase-cam mode (v1 idea) | New input scheme + camera rig as configs; the order-based sim gains a `direct-control` order kind — engine survives the pivot |

### 13.4 AI Collaboration Rules (Critical for Development)

All development is done with Claude-based agents following this strict hierarchy:

- **Sonnet:** straightforward tasks — simple features, basic UI, boilerplate, content authoring, CRUD, CI config.
- **Opus:** medium-to-complex tasks — core systems (navigation, module state machine, energy/heat, LoS, stat resolver), integration, room lifecycle, auth/data model, bot architecture.
- **Codex:** very complex tasks — state schema & order replication, performance optimization, and the editor framework (SchemaFormGen, Map/Asset/Ship & Fitting/Behavior editors).
- **Escalation:** if an agent returns non-working code too often, immediately hand the task to the agent one level above. **Final escalation always goes to Fable.**
- **Communication style:** when thinking or talking to the user, save as many tokens as possible — talk like caveman: short sentences, no fluff, direct.

Per-task assignments marked in *(italics)* throughout. Pre-flagged escalation hot-spots: **1.3–1.5 module/energy/heat/LoS core** and **5.6 mobile performance**.

**These rules must be followed during the entire prototype development.**

---

*Space Arena MVP Roadmap v2.0 — 2026-07-21. Control model changed to one-finger tactical (tap-to-move, module toggles, auto-fire with LoS). This is a living document: check off tasks as they land, amend estimates at phase exits.*

*Amended 2026-07-25: the flight overhaul superseded the movement/targeting/input/camera model — `docs/FLIGHT.md` is the contract for those, see the note at the top.*
