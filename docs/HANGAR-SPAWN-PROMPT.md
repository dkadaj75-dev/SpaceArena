# Open Ship Hangar — CTF spawn asset prompt pack

This pack is for one **open** static hangar prop, `prop.open-ship-hangar`, to be placed once at each CTF base. It is deliberately a visual-only prop in the initial registration stub: the present prop collision format is an embedded triangle mesh, and a closed/approximate collision shell would be unsafe around spawn points. Add collision only after exporting a deliberately open collision mesh whose mouth and departure volume contain no triangles.

## Hard constraints and derived dimensions

- **Engine / asset convention.** Babylon arena space is left-handed with Y up; a spawn `heading` rotates about +Y, where `0` faces +X and positive angles turn toward +Z (`docs/MAPS-AND-SKYBOXES.md`, `shared/src/schemas/arena.ts`). Export the model with its nose/forward direction along **Blender -Y**; it imports as engine +Z. Normalize its forward extent to `1.0`, then set its arena size with `render.modelScale` (`docs/MAPS-AND-SKYBOXES.md`, `docs/HANDOFF-2026-07-27.md`).
- **The mouth is open, not a facade.** Ships spawn inside the volume and must fly straight through one large, completely unobstructed mouth. The exit vector is the model's local forward/+Z after import. No door, force field, lintel, landing craft, crane, antenna, cable, hanging sign, centre post, or collision face may enter that volume. Model readable interior depth: deck, side bays, ceiling ribs, rear bulkhead and recessed machinery, but leave the central flight corridor empty.
- **Authoritative ship envelope.** The shipped Brawler is the largest collision hull: `radius: 2.1`, therefore `diameter = 2 × 2.1 = 4.2` arena units (`content/ships/brawler.json`). The other shipped radii are Interceptor `1.4` and Support `1.7` (`content/ships/interceptor.json`, `content/ships/support.json`). The shipped geometry test independently derives its maximum ship diameter from `collider.radius × 2` (`shared/src/schemas/shippedArenaGeometry.test.ts`). The repo does not publish per-axis rendered GLB bounds as content metadata, so the collision sphere is the only authoritative all-axis fit envelope; do not invent narrower width/height measurements from the art.
- **Required shared-mouth arithmetic.** Lunar Rift's five same-team pads are at `x = -28, -14, 0, 14, 28`, a `56`-unit centre-to-centre span, at `y = 8`, and blue/red fly toward +Z/-Z respectively (`content/arenas/lunar-rift.json`). With one Brawler diameter at each outer edge plus `2` units clearance on each side: `56 + 4.2 + 2 + 2 = 64.2` units minimum clear mouth width. Vertically, with 2 units clearance above and below: `4.2 + 2 + 2 = 8.2` units minimum clear mouth height. **Author a 66 × 10 unit clear opening** (width × height): it exceeds both minima and keeps the nominal five-pad launch formation viable. Use an interior clear depth of at least 42 units; the five spawn transforms belong 12–18 units behind the mouth plane, centered near its vertical midline. With a normalized depth of 1.0, a 42-unit deep model uses `modelScale: 42`; author its normalized proportions as depth `1.000`, clear-mouth width at least `1.571` (`66 / 42`), and clear-mouth height at least `0.238` (`10 / 42`).
- **Materials.** The runtime clamps imported PBR materials to metalness ≤ `0.25` and roughness ≥ `0.5` when no IBL is active (`client/src/core/AssetRegistry.test.ts`; see also `docs/HANDOFF-2026-07-27.md`). Do not ask for mirror chrome, polished black metal, or clean reflection-dependent contrast. Use painted, brushed, anodized, or weathered metal; rely on panel seams, roughness variation, edge wear, decals-free hazard colour blocks, vents, bolts and greeble breakup for readability. Lunar Rift's generated deck material itself uses metalness `0.05`, roughness `0.72` (`tools/lunar-rift/props.ts`).

## IMAGE prompt — Meshy image-to-3D

```text
Single isolated OPEN SHIP HANGAR for a futuristic CTF space-combat spawn point, ultra-realistic hard-surface sci-fi prop, a broad freestanding armored hangar with one huge rectangular-arched open mouth facing the viewer and a visibly deep, fully modeled interior: empty central flight corridor, matte deck, recessed side service bays, ribbed ceiling, rear bulkhead, structural frames, vents, conduits, landing guidance strips, layered physically plausible panel seams, bolts and restrained greebles; the mouth must be a genuinely unobstructed 66-by-10-unit clear aperture with no door, force field, central pillar, hanging object, vehicle, crane or blockage, and the interior must remain open for ships to spawn inside and fly straight out; make the object about 42 units deep, with the opening centered and large enough for five ships abreast; durable painted gunmetal, desaturated navy and charcoal panels, subtle team-neutral amber/cyan utility lights only, brushed/anodized/painted metal with roughness variation and edge wear, never mirror chrome; transparent alpha background, isolated single subject only, no ground plane, no shadow catcher, no environment; three-quarter elevated view looking into the open mouth and showing interior depth, full object entirely in frame with generous margin; even neutral studio lighting, readable midtones, no blown highlights and no crushed blacks, sharp focus, no motion blur, no lens distortion, no depth-of-field, no text, logos or symbols.
```

## NEGATIVE prompt

```text
background, sky, stars, planet, landscape, hangar bay environment, ground plane, floor outside the prop, shadow catcher, multiple buildings, multiple subjects, ship, spacecraft, pilot, people, robots, cargo, crates, parked vehicle, sealed box, closed blast door, partially closed door, force field, central pillar, centre post, hanging crane, hanging cable, overhead obstruction, blocked doorway, narrow doorway, tunnel with no interior, flat facade, open back with no rear bulkhead, text, lettering, logo, emblem, watermark, UI, mirror chrome, polished reflective black metal, blown white highlights, pure black interior, extreme contrast, cinematic lighting, coloured rim-light haze, smoke, fog, fire, explosion, motion blur, bokeh, depth of field, fisheye, wide-angle distortion, cropped object, cut-off roof, cut-off mouth
```

## TEXT-TO-3D prompt — Meshy text mode

```text
Create one game-ready static prop: an OPEN SHIP HANGAR for a CTF spawn. Hard dimensions in final arena units: 42 deep, with one single completely empty 66 wide × 10 high mouth. The mouth is on the model's forward side; make the central 66 × 10 × 42 flight corridor empty from rear spawning area through the mouth—no door, shield, centre support, crane, vehicle, cable, antenna, prop or collision geometry in it. The interior must be real geometry and visibly deep: matte deck, side maintenance alcoves outside the corridor, ceiling ribs outside the 10-unit opening, rear bulkhead, recessed vents and machinery, layered structural frames. Model as a single isolated hard-surface sci-fi hangar with painted charcoal/gunmetal and restrained navy panels, brushed/anodized/painted metal, roughness variation, panel lines, bolts, vents and light edge wear; avoid mirror chrome and reflection-only detail. Team-neutral, no text or logos. Export orientation: in Blender the open mouth/forward exit points -Y; normalize forward/depth extent to 1.0, preserve proportions of 1.000 deep × at least 1.571 mouth width × at least 0.238 mouth height. Intended engine scale is modelScale 42. Keep it an isolated asset with no ground plane or surrounding scene.
```

## Why these choices

- The five-pad, 56-unit Lunar Rift CTF formation is the concrete reference for a shared team spawn hangar; its heading values make the blue launch direction +Z (`heading: π/2`) and red direction -Z (`heading: -π/2`) (`content/arenas/lunar-rift.json`). A 66-unit mouth provides the calculated `64.2` unit minimum with a small production tolerance.
- Ship collision is radius-only and is treated as a sphere by simulation (`shared/src/schemas/common.ts`), so the Brawler's `2.1` radius—not a visually guessed mesh silhouette—is the reliable width and height envelope. `shared/src/schemas/shippedArenaGeometry.test.ts` uses that same diameter logic for shipped spawn capacity.
- `propPlacements` supply `propId`, `position`, optional Euler `rotation`, optional uniform `scale`, and optional `locked` (`shared/src/schemas/arena.ts`). The configuration does not encode a spawn-to-prop relationship; it is the arena author's responsibility to co-locate the spawn formation inside the mouth and orient the placement toward each team's heading.
- Existing authored props use content-relative `props/*.glb` paths, `recipe: "model.static"`, and categories such as `structure` and `decor` (`content/props/lunar-rift-flagpad.json`, `content/props/lunar-rift-guidelight.json`). The proposed hangar follows that schema.
- The terrain post-process extracts embedded GLB images into shared `content/props/textures/game/` files (`tools/postprocess-terrain-glbs.mjs`). The Lunar Rift GLB fix enforces non-metallic, high-roughness boulder materials (`tools/fix-lunar-rift-glbs.mjs`). Together with the runtime material clamp, that is why the prompt calls for physical surface breakup instead of chrome.

## Proposed `content/props/open-ship-hangar.json` registration stub

```json
{
  "id": "prop.open-ship-hangar",
  "type": "prop",
  "version": 1,
  "name": "Open Ship Hangar",
  "category": "structure",
  "impactDamage": 0,
  "render": {
    "recipe": "model.static",
    "model": "props/open-ship-hangar.glb",
    "modelScale": 42,
    "modelRotationY": 0
  }
}
```

This is valid against `shared/src/schemas/prop.ts` and intentionally has no `collision` block. If collision is later required, use that schema's base64-encoded `positions`, `indices`, and containing `bounds`; keep it below 150,000 triangles and remove every triangle from the interior flight corridor and mouth.

## Post-generation checklist

1. In Blender, point the open mouth / intended exit **-Y**, apply transforms, and normalize the forward/depth extent to exactly `1.0`. On import this is engine +Z. If the delivered asset is off-axis, correct it with `render.modelRotationY` in radians rather than silently changing arena headings.
2. Verify the normalized model has a clear opening no smaller than `1.571` wide × `0.238` high and a forward/depth extent of `1.000`; register it with `modelScale: 42`, yielding a 66 × 10 clear mouth and 42 depth in Lunar Rift-style arena units. Do not use visual scale to hide a too-small mouth.
3. Inspect every imported PBR material under match lighting. Keep authored metalness at or below `0.25` and roughness at or above `0.5` where possible; replace mirror-like materials with painted/brushed/anodized surfaces and visible albedo/roughness breakup.
4. Add the GLB at `content/props/open-ship-hangar.glb`, add the JSON path to `content/manifest.json`, and run `npm run validate:content`. Binary assets are referenced by config and are not manifest entries (`docs/MAPS-AND-SKYBOXES.md`).
5. Place one hangar per CTF team. Rotate each prop so its local +Z exit aligns with the spawn heading: blue Lunar Rift uses `heading: 1.570796` (+Z); red uses `-1.570796` (-Z). The repository's local-axis convention for a prop's `rotation.y` relative to its GLB forward is not stated explicitly, so verify this visually in the editor rather than assuming a rotation sign.
6. Put the five spawn transforms inside each hangar, 12–18 units behind the mouth plane along the inward opposite of the exit vector, near the mouth's vertical centre. Preserve their current 14-unit lateral spacing (`x = -28…28` for Lunar Rift); their hull envelopes then remain inside the calculated 66 × 10 clear aperture. Keep the flag base separate: Lunar Rift's flag bases are at `z = ±255`, while its spawn line is `z = ±278` (`content/arenas/lunar-rift.json`).
7. If adding collision, test all three shipped hulls flying straight out from every pad, including boost and small pitch offsets. The collision mesh must model only walls/roof/rear features outside the central corridor; a visual opening is not sufficient if its collision triangles remain in the exit vector.
