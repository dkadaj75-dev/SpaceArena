# Sky textures

`milkyway_{px,nx,py,ny,pz,nz}.webp` — a Milky Way cubemap, used as the main
menu's starfield backdrop (`theme.menu.backdrop.starfield.sky`).

## Source

Obtained from the `mrdoob/three.js` repository (MIT), at
`examples/textures/cube/MilkyWay/dark-s_*.jpg`, converted to WebP at the
original 1024×1024 per face (459 KiB total, down from ~2 MiB).

## Attribution — read this before a commercial release

This cubemap is derived from **"The Milky Way panorama" by Serge Brunier**,
published by **ESO**, which ESO releases under **CC BY 4.0** — a licence that
*requires* attribution.

Stated plainly: no licence or credits file accompanied these files in the
three.js repository, so the attribution above rests on the image's documented
provenance rather than on a licence shipped with the asset. That is good enough
to credit correctly and to keep developing against; it is **not** a substitute
for confirming the terms yourself before shipping commercially. The alternative,
if that check does not come back clean, is to swap the six files for any other
cubemap — nothing in the renderer knows or cares which one is in the theme.

Credit line to carry wherever the game credits its art:

> Milky Way panorama: ESO / S. Brunier (CC BY 4.0)

The Earth maps under `textures/planets/` are a different case entirely — NASA
imagery, not copyrighted, no attribution required. See that folder's CREDITS.
