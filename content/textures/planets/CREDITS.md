# Planet textures

Equirectangular Earth maps used by the main menu's earthrise backdrop
(`client/src/game/screens/MenuDiorama.ts`).

## Source and licence

All five are **NASA imagery**, which is not copyrighted and may be used without
permission — see NASA's media usage guidelines. They were obtained from the
`mrdoob/three.js` repository (MIT), whose `examples/textures/planets/` set is
the widely mirrored redistribution of these NASA products.

| File | NASA product | Original |
| --- | --- | --- |
| `earth-albedo.webp` | Blue Marble — land surface, ocean colour, sea ice | `earth_atmos_2048.jpg`, 2048×1024 |
| `earth-clouds.webp` | Blue Marble cloud fraction | `earth_clouds_1024.png`, alpha channel only |
| `earth-night.webp` | Earth at Night ("Black Marble") city lights | `earth_lights_2048.png`, halved |
| `earth-normal.webp` | Blue Marble elevation, as a tangent-space normal map | `earth_normal_2048.jpg`, halved |
| `earth-ocean.webp` | Land/water mask, used as the ocean specular mask | `earth_specular_2048.jpg`, halved to one channel |

## What was changed

Converted to WebP and re-sized for the web (436 KiB total, down from ~1.7 MiB).
Two encoding choices worth knowing before anyone "fixes" them:

- **Clouds are a grayscale COVERAGE map, not RGBA.** The clouds are white; only
  their density varies. One channel says that, and the material reads it as
  opacity — an alpha channel repeating the same information cost four times as
  much.
- **The normal map is kept at a higher quality than the rest.** Normals encode
  direction in colour, so chroma loss shows up as lighting artefacts rather than
  as softness.

The moon regolith under the ship is NOT from here — it reuses the pack's
existing `props/textures/game/moon_dusted_01_*` PBR set.
