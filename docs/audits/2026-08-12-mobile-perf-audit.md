# Mobile performance audit — 2026-08-12

**Audit target:** Space Arena commit `b09014e`  
**Reported device class:** Android Chrome, Adreno 6xx/7xx or Mali-G7x, 1080 × 2400 physical pixels, DPR 2.5–3, 4–8 slower CPU cores  
**Scope:** read-only code/content audit plus host-side microbenchmarks. Values marked **estimate** have not been captured on a phone.

## Executive summary

The mobile failure is most likely GPU-bound, and it starts with the first-launch quality decision. An 8-core/8-GB Android phone passes the shipped Ultra probe and renders at its full 1080 × 2400 backbuffer. Ultra also enables glow, the costly boundary shader, the largest particle budgets, and the longest terrain LOD range. The auto-tier system waits about eight seconds and may demote only one step, to High, which still renders 44% of native physical pixels and retains glow. A 4–8-core phone below the Ultra memory floor generally starts at Medium, but Medium still enables glow and submits terrain LOD0 out to 190 units.

Three concrete render costs compound that bad starting point:

1. The three ship families have useful LOD1–LOD3 GLBs, but the ship configs reference only LOD0. Ten interceptors can therefore contribute **442,710 triangles** and between roughly **28 and 280 material/submesh batches** when all are in view, before terrain or effects.
2. The 16 Lunar Rift terrain chunks contribute **223,357 triangles at LOD0** and **61,374 at LOD1**. Conservative landscape-camera frustum samples saw 7–14 chunks, producing about **68k–145k placed-prop triangles** at the Medium/High/Ultra 190-unit switch. Low's 0.55 LOD bias reduced sampled totals to about **45k–109k**, but did not address ships.
3. Glow remains enabled on Medium through Ultra. Babylon's GlowLayer uses a half-resolution emissive target, four blur passes at half/quarter linear resolution, and a full-screen compose. This is approximately **1.875 backbuffer-pixel equivalents per frame**, plus re-rendering emissive geometry. At Ultra on the reference phone that is about **4.86 million post-process fragment pixels/frame** (**estimate**) before ordinary scene shading and blending.

The CPU evidence does not support collision as the primary blocker. Shipped Lunar Rift collision contains 65,422 placed triangles; on the host, typical sphere contacts cost 1.5–4.0 µs and rays 8–22 µs. Even a conservative 5× mobile slowdown leaves online static prediction well below 0.1 ms per 30 Hz step (**estimate**). The more credible online CPU issue is allocation churn: snapshot decoding plus interpolation creates approximately **5,000–7,000 short-lived JS objects/second** for ten ships (**estimate**), while the HUD is generally write-guarded and the minimap is capped at 20 Hz.

Offline CTF is not free, but it is not the first blocker either. A 10-bot Lunar Rift run measured about **0.91 ms/30 Hz tick steady-state** on the host after subtracting startup; at 3–5× slower this is **2.7–4.5 ms/tick on a phone** (**estimate**). Bot decisions are already cadence-limited to 250–1,400 ms. Offline play is plausibly viable after the render path is fixed, with bot scheduling as a second-stage safeguard.

The recommended first slice is therefore: force mobile Auto to Low, cap the first-launch backbuffer near 0.37 MP, disable glow on Low/Medium, and make auto-demotion capable of jumping directly to a safe tier. The second slice should wire the existing ship LODs and lower terrain LOD pressure. Those two slices should deliver a much larger win than BVH, server, audio, or micro-HUD work.

## Methodology

- Audited source and content at commit `b09014e`; line references below refer to that baseline. Unrelated working-tree changes that appeared during the audit were not read as authoritative and were not modified.
- Parsed all GLBs referenced by `arena.lunar-rift` with `@gltf-transform/core`; counted accessor vertices, indexed/non-indexed primitive triangles, primitives, material slots, attribute formats, and file bytes. Counts are source-asset counts, not runtime GPU captures.
- Expanded the arena prop placements and LOD recipes. Frustum estimates used four representative poses (spawn crater, crater mouth, hub, west lane), the shipped 1.05-radian camera FOV (`content/camera/default.json:20-27`), landscape aspect 2400/1080, and conservative placement bounding spheres. They intentionally do not assume terrain occlusion, because the renderer has no content-level occlusion system. They are estimates, not a Babylon instrumentation capture.
- Computed physical backbuffer dimensions from the exact hardware scaling formula (`client/src/core/QualityManager.ts:203-210`) on a 1080 × 2400, DPR-3 phone.
- Constructed the shipped `StaticWorld` from Lunar Rift collision data, then timed 100,000 sphere/ray queries per scenario after warm-up. Host timings use Node's high-resolution clock and are useful for relative scale, not direct phone timing.
- Ran `tools/bot-ctf-review.ts` for 30 and 60 simulated seconds and used the incremental 30-second window to reduce one-time setup bias. The review tool includes reporting overhead, so the result is a conservative simulation estimate.
- Ran the existing load harness for four `gamemode.practice-ctf-5v5` rooms for 30 seconds. This is a short regression sample, not a soak/leak verdict.
- Inventoried hot-path allocations, DOM/canvas writes, `setInterval` lifecycles, audio creation/decoding, PWA cache rules, and asset preload paths by source inspection.

### Measurement caveats

- Draw-call counts cannot be proven from GLBs alone: Babylon hardware-instances equal hull/paint combinations, while MultiMaterial submeshes remain separate. The audit therefore gives ranges and requires runtime instrumentation as an acceptance criterion.
- Fragment-time savings for cheaper materials and disabled effects are **estimates** until measured with Chrome/Babylon GPU counters on target hardware.
- The host CPU, Node/V8, and browser/mobile thermal behavior differ. Mobile CPU projections explicitly use the requested 3–5× slowdown assumption.

## Findings

| ID | Severity | Area | Evidence | Estimated mobile impact | Fix strategy | Effort |
|---|---|---|---|---|---|---|
| GPU-01 | **P0-blocker** | Resolution / first boot | Ultra is mobile-eligible; DPR-3 Ultra is 2.592 MP. Auto reacts after ~8 s and only one tier. | 2.25–7.1× Low's pixels; immediate poor first impression | Default mobile Auto to Low; GPU-aware probe; multi-step emergency demotion; persist a learned cap | S–M |
| GPU-02 | **P0-blocker** | Ship geometry / draws | Existing ship LODs are unused; 10 LOD0 interceptors = 442,710 tris | Can exceed terrain geometry by 3–6×; 28–280 ship batches | Wire LOD1–3 with screen-size/distance thresholds; reduce far material slots | M |
| GPU-03 | **P0-blocker** | Glow / post-process | Enabled Medium+; ~1.875 backbuffer-pixel equivalents plus emissive redraw | ~1.63M extra fragment pixels/frame at Medium, 4.86M at Ultra (**estimate**) | Off on Low/Medium; 0.25 target ratio or selective bloom on High; validate visual hierarchy | S–M |
| GPU-04 | **P1-major** | Terrain LOD / visibility | 223,357 LOD0 vs 61,374 LOD1; sampled 7–14 chunks and 68k–145k placed-prop tris at 190 u | Sustained vertex and raster load in canyon sightlines | Lower Medium threshold; add LOD2/meshlets/merged chunk groups; screen-space LOD and optional occlusion | M–L |
| GPU-05 | **P1-major** | Particles / blended effects | ~40–50 ship particle systems plus dust; Ultra capacity 5,760–7,200 ship particles | Blend overdraw and update overhead scale with ten ships | Stop invisible/zero-rate systems; distance/offscreen cull; hard mobile budgets; no dust below High | M |
| GPU-06 | **P1-major** | Materials / vertex bandwidth | Matte vertex-color props remain PBR; chunk vertices carry float32 POSITION/NORMAL/COLOR_0 | High fragment ALU and ~7.33 MB LOD0 vertex/index payload | Mobile vertex-color Lambert/Standard path; quantize/meshopt; preserve authored look by tier | M–L |
| GPU-07 | **P1-major** | Alpha / full-screen overdraw | Backside sky, always-blended hex boundary, two large additive beacons, shield/engine effects | Near-full-screen fragment work near walls/bases; poor tile-GPU behavior | Disable boundary mesh at zero opacity; cheap Low/Med boundary; shrink/cull beacon and shield shells | M |
| CPU-01 | **P1-major** | Network snapshots / GC | Decode and interpolation clone ships, transforms, module maps and trails | ~5k–7k transient objects/s at 10 ships (**estimate**); GC/frame spikes | Reusable double buffers, ID maps, immutable module references, render scratch structs | M–L |
| LOAD-01 | **P1-major** | Boot / match loading | Boot waits for 3.39 MiB ship LOD0; Lunar Rift references 9.27 MiB unique GLBs; no app-level GLB compression | Network, parse, upload and shader-compile stalls; memory pressure | Load menu-critical assets only; queue/background ships; meshopt/quantization; precompressed/edge delivery; staged match preload | L |
| OFF-01 | **P1-major** | Offline CPU | Host steady 10-bot tick ~0.91 ms; projected 2.7–4.5 ms mobile | 8–14% of a 33.3-ms step before rendering (**estimate**) | Stagger bot work; mobile cadence floor; measure long-frame p95 after GPU fixes | M |
| CPU-02 | **P2-minor** | HUD / DOM / canvas | Most writes are guarded; minimap redraws at 20 Hz but allocates color strings/arrays | Usually secondary; can amplify GC/layout during combat | Cache colors; skip hidden scoreboard work; instrument writes/layout reads | S–M |
| CPU-03 | **P2-minor** | Static collision | 65,422 placed tris; host queries 1.5–22 µs; build ~279 ms | Per-tick prediction likely <0.1 ms; build can add ~1–1.4 s (**estimate**) | Defer hot-query optimization; serialize/cache BVH or build during loading | S–M |
| BG-01 | **P2-minor** | Periodic / PWA / audio | Match has no persistent polling interval; JSON NetworkFirst, binary SWR; music decode is lazy/cached | No match blocker found; cache revalidation and decode can affect transitions | Retain lifecycles; remove `no-store` music fetch; monitor cache eviction and transition tasks | S |
| SRV-01 | **P2-minor** | Server | 4-room short run: avg 1.484 ms, p95 5.316 ms, max 15.525 ms vs 33.3 ms | No evidence server tick causes client unplayability | Keep server out of first mobile slice; perform a real soak separately | S |

## Detailed findings

### GPU-01 — First-launch quality and resolution are unsafe

Quality selection walks from the best tier downward and chooses the first probe that passes (`client/src/core/qualityTier.ts:93-123`). Ultra explicitly permits mobile and requires eight cores/eight GB (`content/quality/ultra.json:4-10`); High disallows mobile (`content/quality/high.json:4-10`). Consequently, a modern 8-core/8-GB Android device is not sent to Medium—it goes to Ultra. The probe uses core count, reported device memory, and a mobile hint, not WebGL renderer/GPU class (`client/src/core/qualityTier.ts:39-73`). Missing `deviceMemory` is treated as unknown and does not fail the memory floor (`client/src/core/qualityTier.ts:27-31,100-103`), making over-selection possible on browsers that omit it.

The effective DPR is `min(deviceDPR, maxDPR) / hardwareScalingMultiplier` (`client/src/core/QualityManager.ts:203-210`). For a 1080 × 2400 DPR-3 phone (360 × 800 CSS pixels):

| Tier | Effective DPR | Approx. backbuffer | Pixels | Native share |
|---|---:|---:|---:|---:|
| Low | 1.128 | 406 × 902 | 0.366 MP | 14.1% |
| Medium | 1.739 | 626 × 1,391 | 0.871 MP | 33.6% |
| High | 2.000 | 720 × 1,600 | 1.152 MP | 44.4% |
| Ultra | 3.000 | 1,080 × 2,400 | 2.592 MP | 100% |

Low is reasonably aggressive; the failure is that Auto does not reliably start there. Engine creation also requests antialiasing (`new Engine(canvas, true)`) and enables device-ratio adaptation (`client/src/main.ts:226-264`), adding bandwidth to an already pixel-heavy configuration.

Auto-tier waits five seconds, samples for three, and permits one adjustment per match (`client/src/core/qualityTier.ts:191-235`; fallback thresholds at `client/src/core/QualityManager.ts:245-249`). An Ultra phone therefore spends its first eight seconds unplayable and can land only on High. Recommended behavior:

- Mobile Auto starts at Low unless a renderer allowlist and prior measured result justify Medium.
- An emergency sampler uses frame-time p90/p95, begins within 1–2 seconds, and can jump multiple tiers to Low.
- Promotion happens only next match or after a long stable window; learned safe tier is persisted by renderer/device bucket.
- Keep user overrides, but warn when a selected tier exceeds a measured budget.

### GPU-02 — Existing ship LOD assets are not used

The three shipped ship configs reference one render model and no authored LOD ladder (`content/ships/interceptor.json:353-355`, `content/ships/support.json:353-355`, `content/ships/brawler.json:353-355`). Preload therefore visits only each ship's primary render recipe (`client/src/core/assetPreload.ts:74-94`). This leaves existing LOD1–LOD3 GLBs unused.

Measured source assets:

| Hull | LOD0 tris | LOD0 vertices | LOD0 primitives | Existing lower LOD tris |
|---|---:|---:|---:|---:|
| Interceptor | 44,271 | 61,314 | 28 | LOD1 22,029; LOD2 10,423; LOD3 3,641 |
| Support | 19,844 | 26,803 | 17 | LOD1 8,922; LOD2 1,915 |
| Brawler | 9,248 | 10,347 | 13 | LOD1 4,690; LOD2 1,418 |

Ten visible interceptors submit 442,710 triangles at LOD0. LOD2 would cut that by 76.5%; LOD3 by 91.8%. `AssetRegistry` merges model parts but retains MultiMaterial submaterials (`client/src/core/AssetRegistry.ts:546-568`), and EntityView uses Babylon instances so identical hull/paint combinations can batch (`client/src/game/shipPaint.ts:9-13`; `client/src/game/EntityView.ts:741-745`). Thus the all-interceptor draw range is roughly 28 batches if all share a paint variant to 280 if all ten variants split; actual draw calls must be captured.

Wire the existing assets into a ship LOD ladder. Prefer screen-space projected radius with hysteresis; distance-only thresholds are acceptable initially. Keep the local ship at LOD0, use LOD1 for nearby opponents, LOD2 for ordinary combat distance, and LOD3 for markers/silhouettes. Collapse far-LOD materials to one or very few slots so LOD reduces draw calls as well as triangles.

### GPU-03 — Glow is too expensive for the mobile default

Only Low disables glow; Medium, High, and Ultra enable it with blur kernels 16, 32, and 48 (`content/quality/low.json:9-10`; `content/quality/med.json:19-26`; `content/quality/high.json:19-26`; `content/quality/ultra.json:19-26`). SceneBuilder creates a normal Babylon `GlowLayer` without overriding its default texture ratio (`client/src/core/SceneBuilder.ts:842-863`). The installed Babylon implementation defaults the main glow texture ratio to 0.5 (`node_modules/@babylonjs/core/Layers/glowLayer.js:89`) and builds horizontal/vertical blur stages at half and quarter linear resolution (`node_modules/@babylonjs/core/Layers/effectLayer.js:274-275`).

Counting the emissive target, four blur draws and final compose gives approximately 1.875 backbuffer-pixel equivalents per frame, excluding emissive geometry re-render. That is about 1.63M pixels/frame at Medium and 4.86M at Ultra (**estimate**). The source already records a representative draw-call change from 47 with glow to 24 without it (`client/src/core/SceneBuilder.ts:842-845`).

Disable glow on Medium as well as Low. On High, test a 0.25 target ratio, a smaller/selective emissive set, and a cheaper bloom implementation. Ultra may retain the current effect for desktop. Acceptance should be based on GPU/frame counters, not only visual similarity.

### GPU-04 — Terrain LOD0 remains visible across canyon-scale sightlines

All 16 Lunar Rift chunks switch at 190 units (`content/props/lunar-rift-chunk-5.json:9-15`, representative; the other chunk recipes match). SceneBuilder multiplies that distance by placement scale and tier terrain bias (`client/src/core/SceneBuilder.ts:758-762`), so the switch is 190 on Medium/High/Ultra and 104.5 on Low.

Measured chunk totals are 223,357 triangles / 128,813 vertices at LOD0 and 61,374 / 39,295 at LOD1—a 72.5% triangle reduction. Conservative frustum samples produced:

| Pose | Visible chunks | Chunk tris at 190 u | All placed-prop tris at 190 u | All placed-prop tris at Low 104.5 u |
|---|---:|---:|---:|---:|
| Spawn crater | 14 | 114,826 | 144,834 | 109,302 |
| Crater mouth | 12 | ~100k | 130,548 | 75,176 |
| Hub | 8 | 107,251 | 120,479 | 49,362 |
| West lane | 7 | 67,975 | 72,989 | 44,984 |

These estimates include 64 boulders, 28 guide lights, two flag pads, and four beacon props. They use bounding-sphere frustum inclusion and may overcount geometry behind terrain, but without occlusion that geometry can still be submitted.

Lower Medium's terrain bias to approximately 0.55–0.7 immediately. Then author a much cheaper LOD2/impostor or merge spatially coherent static pieces, use screen-space error with hysteresis, and evaluate conservative software/Hi-Z occlusion for canyon walls. Preserve the recent compile-then-freeze path: placements freeze matrices and compiled materials (`client/src/core/SceneBuilder.ts:788-830`), which is a sound CPU optimization but does not reduce GPU work.

### GPU-05 — Ten ships multiply additive particle systems

Each ship constructs and starts socket particle systems even when current emit rate is zero; updates are throttled to 15 Hz (`client/src/game/ShipSocketRig.ts:201-247,307-325`). Interceptor/support expose four emitter sockets, brawler five, yielding roughly 40–50 systems in a 10-ship match. From tier scale/cap settings, aggregate theoretical ship capacities are approximately 560–700 Low, 1,440–1,800 Medium, 3,200–4,000 High, and 5,760–7,200 Ultra. Lunar dust adds 0/180/340/560 particles by tier (`content/quality/low.json:14`; corresponding `scene.dust.count` in Medium/High/Ultra).

Capacity is not the same as live count, so this is an upper-bound pressure indicator. The dangerous part is additive blending and screen coverage from many nearby engines, smoke, boost, dust, and combat effects. Stop rather than merely zero-rate dormant systems, do not animate/copy emitters for offscreen distant ships, reduce each remote ship to one engine effect on Low/Medium, and disable dust below High.

### GPU-06 — PBR and unquantized attributes overspend on matte rocks

Imported glTF materials remain Babylon PBR materials; registry normalization adjusts metallic/roughness but does not replace the shader (`client/src/core/AssetRegistry.ts:546-568`). The scene uses hemispheric and directional lights (`client/src/core/SceneBuilder.ts:339-359`). For mostly textureless, vertex-colored matte terrain, that is more fragment shader than Low/Medium needs.

All 16 measured chunk primitives store POSITION, NORMAL, and COLOR_0 as float32 VEC3, plus uint32 indices: 36 attribute bytes/vertex before indices. LOD0's source attribute/index payload is approximately 7.33 MB, of which COLOR_0 alone is 1.55 MB. No meshopt/Draco or quantized accessor path was present in the audited assets.

Introduce a tier-specific vertex-color Lambert/StandardMaterial or compact custom shader with one directional term and baked AO. A 20–40% terrain fragment-time reduction is a plausible **estimate**, not a guarantee; validate with a controlled GPU capture. In the asset pipeline, quantize positions/normals/colors where visual error allows, pack colors to normalized 8-bit, use 16-bit indices for split meshes, and apply meshopt compression. This reduces download, parse, memory, upload, and vertex bandwidth together.

### GPU-07 — Alpha/full-screen surfaces stack on tile GPUs

The sky is a 32-segment backside sphere rendered every frame (`client/src/core/SceneBuilder.ts:362-394`), measured at 4,624 triangles. That triangle count is harmless; its near-fullscreen pixel coverage is not free. Lunar boundaries add a ceiling and four double-sided planes. Their fragment shader evaluates `fract`, `floor`, `mod`, `abs`, and `smoothstep`, and always requests alpha blending (`client/src/core/SceneBuilder.ts:1164-1203`). Opacity may become zero away from the wall, but the mesh remains renderable, so zero visual contribution can still incur fragment/blend work.

Each flag base also creates a dynamic, double-sided, additive/Fresnel beacon sphere (`client/src/game/EntityView.ts:1020-1053`): measured 1,936 triangles each and potentially large screen coverage at a 16-unit radius. Shield bubbles and engine/combat particles add more transparent layers.

Set boundary meshes disabled when opacity is zero, with hysteresis to avoid churn. On Low/Medium replace the procedural hex fragment with a flat/dithered edge cue, reduce beacon segmentation/radius, and cull transparent shells by distance and projected size. Render the opaque scene front-to-back before transparent effects and verify overdraw using a false-color capture.

### CPU-01 — Network decode/interpolation creates avoidable garbage

Online `tick()` invokes `renderAt()` from the fixed GameLoop, so interpolation currently runs at 30 Hz rather than display refresh (`client/src/net/NetGameSession.ts:548-550`; loop setup at `client/src/main.ts:1102-1119`). Each interpolation creates a snapshot, ship array, ship object and position/up objects per ship, then clones every module object (`client/src/net/NetGameSession.ts:1109-1131`). Ten ships with roughly 7–10 modules produce about 102–132 objects per interpolation, or 3,060–3,960 objects/s (**estimate**).

At the 20 Hz schema patch rate, decoding maps players into fresh ship/transform objects (`client/src/net/NetGameSession.ts:832-910`), maps modules (`client/src/net/NetGameSession.ts:929-969`), spreads collection iterators (`client/src/net/NetGameSession.ts:1100`), and recreates flag/trail structures (`client/src/net/NetGameSession.ts:1072-1093`). A conservative ten-ship estimate adds roughly 2,000+ objects/s, bringing the known path to about 5,000–7,000 objects/s before projectiles/events.

Use two reusable snapshot buffers keyed by entity ID, mutate numeric fields in place on patch, retain module metadata references until modules actually change, and interpolate into EntityView scratch data rather than cloning a complete public snapshot. Replace repeated `.find()` scans with entity/module maps. Add an allocation-count test or browser heap-allocation profile around 60 seconds of synthetic ten-player patches.

### LOAD-01 — Startup and match loading front-load too much work

At the audited baseline, boot loads the content manifest/config set and waits for all three primary ship models before revealing the menu (`client/src/main.ts:148-169,295-317`). The three configured LOD0 GLBs total 3,551,044 bytes (3.39 MiB). Match preparation selects the arena and awaits arena preloading (`client/src/main.ts:1080-1101`); `preloadArenaModels` resolves all referenced unique render/LOD models concurrently (`client/src/core/assetPreload.ts:61-71`). Lunar Rift references 39 unique GLBs totaling 9,723,188 bytes (9.27 MiB).

`express.static` serves the site without an application compression/precompressed-asset layer (`server/src/staticSite.ts:62-75`). GLB is already a binary container, so generic gzip is not a substitute for mesh compression; use meshopt/quantized data first, plus Brotli/precompressed delivery where it measures beneficial. AssetRegistry memoization prevents repeat fetches within a page (`client/src/core/AssetRegistry.ts:20-24`).

Scene creation then compiles prop materials against placements before freezing them (`client/src/core/SceneBuilder.ts:788-830`). This avoids later surprise compiles but serial placement setup can concentrate jank at match start. Load only menu-critical visuals before interaction, queue non-selected hulls in idle time, stream arena LOD1/low-tier assets first, and bound parallel decode/upload concurrency. Instrument download, decode, GPU upload, shader compile, and first-interactive separately.

### OFF-01 — Offline simulation is material but probably viable after GPU fixes

The 30-second ten-bot review took 2,189.8 ms wall time; the 60-second run took 3,007.7 ms. The incremental 900 ticks therefore cost 817.9 ms, or approximately 0.91 ms/tick on the host. Applying the requested 3–5× mobile factor gives 2.7–4.5 ms per 33.3-ms tick (**estimate**, about 8–14% of one core). This is meaningful alongside rendering but is not enough to explain an otherwise idle 16–33 ms render failure.

Bots are invoked each fixed simulation step (`client/src/game/GameSession.ts:289-299`), but full decisions are cadence-gated and only trigger maintenance runs between decisions (`shared/src/bots/BotDriver.ts:375-390`). Shipped profiles range from 250 ms aggressive through 1,400 ms tutorial (`content/bots/aggressive.json:6`, `cautious.json:6`, `flagrunner.json:6`, `rookie.json:6`, `tutorial.json:6`).

After render fixes, stagger bot decision phases, enforce a 500-ms mobile floor for noncritical full decisions, and distribute expensive navigation/ray batches across ticks. Preserve 30 Hz flight integration. Gate these changes on simulation p95/p99 and behavior-quality regression tests rather than average tick alone.

### CPU-02 — HUD work is secondary, with targeted cleanup available

The HUD's architecture explicitly avoids unconditional writes (`client/src/game/hud/Hud.ts:95`), and EnemyArrows caches rounded transform/rotation/distance/opacity state before writing (`client/src/game/hud/EnemyArrows.ts:419-472`). Vital arcs similarly guard percentage writes (`client/src/game/hud/VitalArcs.ts:91-112`). The minimap caps redraws to 50 ms/20 Hz and caps its own DPR at 2 (`client/src/game/hud/Minimap.ts:24,153-157`).

Remaining churn includes `withAlpha()` regex/split/map/string creation during minimap drawing (`client/src/game/hud/Minimap.ts:352-360`), a module `reduce()` every HUD frame (`client/src/game/hud/ModuleButtons.ts:205`), and scoreboard team-class toggles/signature construction every render even while hidden (`client/src/game/hud/Scoreboard.ts:58-66,107-124`). Touch controls also write transforms while actively dragged, which is expected (`client/src/game/hud/RelativeSteerInput.ts:234-246`).

Cache parsed RGBA colors, use canvas `globalAlpha`, return immediately from hidden scoreboard updates, and update roster stats on patch/change rather than rendering signatures. Instrument actual `style`, `textContent`, canvas redraw, and forced-layout counts; do not replace the HUD wholesale without evidence.

### CPU-03 — Static collision is not the online hot spot

The shipped Lunar Rift world expands to 86 collision placements, 57,382 unique source triangles, and 65,422 placed triangles. Host construction took approximately 279 ms. After warm-up, 100,000-query averages were:

| Query | Host mean | Hit rate |
|---|---:|---:|
| Random sphere contact | 1.54 µs | 4.3% |
| Navigation-jitter sphere contact | 4.01 µs | 50.9% |
| Random short ray | 8.02 µs | 1.3% |
| 120-unit bot/navigation ray | 22.02 µs | 93.2% |

Online prediction calls a swept ray and sphere contact, sometimes a second sphere resolution (`shared/src/sim/staticStep.ts:94-121`; caller at `client/src/net/NetGameSession.ts:750-768`). A typical host step is therefore around 10–16 µs; at 5×, about 0.05–0.08 ms (**estimate**). `StaticWorld` does allocate transformed points/contacts per placement/query (`shared/src/collision/staticWorld.ts:49-66,97-104`), but optimizing that is lower priority than snapshot garbage.

The build pause is more relevant: 279 ms projects to roughly 1–1.4 seconds at 4–5× (**estimate**). Consider serialized/prebuilt BVHs or building during the visible loading phase, but do not spend the first performance slice rewriting collision.

### BG-01 — No periodic match-time regression found

The interval inventory found only three client intervals:

- Lobby offline health refresh, created only while offline and cleared on recovery/hide (`client/src/game/screens/Lobby.ts:331-360`).
- Matchmaking UI tick every 250 ms, cleared on stop/hide (`client/src/game/screens/MatchmakingScreen.ts:105-180`).
- Tutorial highlight sync every 200 ms, cleared when inactive/disposed; it performs a `getBoundingClientRect` only while the guided overlay is active (`client/src/game/tutorial/TutorialOverlay.ts:121-175,217`).

No lobby/health/matchmaking interval continues through a normal match. Telemetry's per-frame path is counter accumulation and one end-of-match POST (`client/src/core/TelemetryClient.ts:85-145`). Content hot reload immediately returns without `import.meta.hot`, so it is inert in production (`client/src/core/contentHotReload.ts:19-21`).

The PWA uses NetworkFirst with a five-second timeout for content JSON and StaleWhileRevalidate for binary content, capped at 60 entries (`client/vite.config.ts:290-312`). Thus binary assets are not synchronously network-first every match; however, a page request can revalidate in the background, and 60 entries is close to a single large arena plus ships/effects, so eviction should be measured. AssetRegistry prevents another fetch during the same page lifetime.

Audio is lazy: no AudioContext is created before user interaction (`client/src/audio/AudioManager.ts:44-58,161-194`), its one-second noise buffer is created once (`client/src/audio/AudioManager.ts:274-286,337-343`), and synth events create oscillator/buffer-source nodes (`client/src/audio/synths.ts:48-79`). Music buffers are decoded and memoized by track, but track fetches use `cache: "no-store"` (`client/src/audio/MusicController.ts:121-150,211`). Remove `no-store` or use revisioned URLs; schedule decode away from match transition. No continuous audio synthesis loop was found.

### SRV-01 — Short server sample is within the fixed-step budget

The authorized four-room, 30-second practice CTF run measured 1,608 simulation ticks: mean 1.484 ms, p50 0.843 ms, p95 5.316 ms, p99 9.400 ms, max 15.525 ms against a 33.3-ms step budget. Patch traffic averaged 3.05 KB/s/room (302-byte writes, 10.3/s/room). All rooms tore down; heap ended +4.4 MB from baseline.

Only four populated sample windows were available, so the harness correctly reported insufficient data for tick-stability and leak-trend verdicts. This result rules out an obvious 10-ship server regression in the tested process; it does not replace a 10-minute soak or prove mobile client latency.

## Recommended execution plan

### Slice 1 — Establish a safe mobile render baseline (S–M)

Scope: mobile Auto tier, hardware scaling, emergency auto-tier, glow, and transparent boundary behavior. Do not combine this slice with asset-format conversion.

Acceptance criteria without a phone:

- A DPR-3 mobile probe starts at Low unless explicitly allowlisted; computed backbuffer is **≤ 0.40 MP** on 1080 × 2400.
- Medium renders **≤ 0.90 MP** and has GlowLayer absent/disposed; Low remains glow-free.
- A synthetic 20-FPS stream moves Ultra/High/Medium directly to Low within **≤ 3 seconds** of match rendering, and no promotion occurs in the same match.
- Boundary meshes are disabled after opacity reaches zero; a Babylon instrumentation scene shows zero boundary draw calls outside the proximity band.
- A representative arena frame has no more post-process passes on Low/Medium than the base scene requires.

### Slice 2 — Cut submitted geometry and transparent effects (M–L)

Scope: ship LOD wiring/material collapse, Medium terrain bias, particle/dust culling, beacon/shield simplification. Keep the visual style, but make projected size the resource signal.

Acceptance criteria without a phone:

- Ten ships at representative combat distances submit **≤ 150k ship triangles**; far ten-interceptor case submits **≤ 110k** (roughly current LOD2).
- Far ship LOD uses **≤ 4 material/submesh draws per hull/paint**, and automated Babylon counters record the expected hardware-instance batching.
- The four audited camera poses submit **≤ 80k placed-prop triangles on Medium** and **≤ 60k on Low**, or documented exceptions are supported by occlusion measurements.
- Low/Medium create at most **one active remote engine particle system per ship**, zero dust systems, and zero offscreen zero-rate systems.
- A transparent-mesh counter and overdraw test show beacon/boundary/shield pixel coverage reduced by at least **50%** in spawn/base/wall fixtures.

### Slice 3 — Reduce load cost, bandwidth, and JS churn (L)

Scope: quantized/meshopt asset pipeline, staged loading, cheap mobile terrain material, snapshot buffers, and small HUD/cache fixes. Keep collision work out unless profiles overturn this audit.

Acceptance criteria without a phone:

- Boot-blocking model bytes are **≤ 1 MiB** and menu becomes interactive without waiting for all hulls.
- Lunar Rift transferred model bytes fall at least **40%** from 9.27 MiB, with visual error/golden-image checks and no float32 VEC3 color accessor on terrain.
- Shader/material fixtures confirm Low/Medium terrain does not compile the full PBR path; a desktop GPU benchmark shows a material-pass reduction of at least **20%** or the change is reconsidered.
- A 60-second synthetic 10-player/20-Hz network test creates **< 1,000 snapshot/interpolation objects/s** and has no recurring GC pause over **4 ms** on the host browser.
- Offline 10-ship Lunar Rift simulation p95 is **≤ 3 ms/tick on the reference development host**; bot decisions are staggered and behavior regression tests remain green.
- Match-start timing records separate fetch, decode, upload, shader compile, BVH build, and first-render durations.

### Final on-device validation

After the three slices, test one cold-cache and one warm-cache 5v5 Lunar Rift match on the reported midrange Android class, with Chrome remote profiling and thermal state noted. The release gate should be: **30 minutes without thermal-collapse or input-loss, p95 frame time ≤ 33.3 ms, p99 ≤ 50 ms, no GC pause > 8 ms, no match-start main-thread stall > 250 ms after the loading screen, and backbuffer/quality never silently promotes above the measured safe tier.** Capture one spawn-crater fight, one hub fight, and sustained boundary flight so geometry, glow replacement, particles, and transparent overdraw are all exercised.
