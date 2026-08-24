/**
 * ROADMAP §10 5.7 — the shield shell's PANEL LAYOUT (owner 2026-08-23): where
 * each hexagon of the bubble sits, how big it is, and the per-panel jitter the
 * assemble and shatter animations run on.
 *
 * Pure and Babylon-free, like the rest of `juiceSettings.ts`'s neighbours: the
 * renderer ({@link import("./ShieldBubble.js").ShieldBubble}) turns these
 * numbers into thin-instance matrices, and everything below can be pinned by a
 * test with no scene at all.
 *
 * WHY A FIBONACCI SPHERE, not a subdivided icosahedron's dual (a true Goldberg
 * "hex ball"): the dual is the textbook answer and it is genuinely prettier at
 * rest — every panel a real hexagon meeting its neighbours edge to edge — but
 * it only exists at 12 pentagons + 10(4^n − 1) hexagons, i.e. 42, 162, 642…
 * That ladder steps straight over the 80-200 budget this has to live in, and it
 * gives no way to spend a quality tier's smaller allowance. The spiral places
 * ANY count with near-uniform spacing, which is what lets `panelCount` be a
 * theme knob and lets a low tier simply ask for fewer. The panels are drawn as
 * regular hexagons sized to the spiral's local spacing and slightly overlapped
 * ({@link ShieldRippleSettings.panelOverlap}), so at rest the shell reads as a
 * hex-tiled bubble; only a static screenshot at high zoom shows the seams are
 * not perfectly shared.
 */

import type { ShieldRippleSettings } from "./juiceSettings.js";

/** The golden angle — the spiral's turn between consecutive panels. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * One panel's fixed identity: where it sits on the unit sphere, and the two
 * deterministic random-looking numbers the animations use to make its motion
 * differ from its neighbours'. Nothing here changes over time — the per-frame
 * pose is {@link import("./shieldAnim.js").panelPose}'s job.
 */
export interface ShieldPanel {
  /** Outward unit normal — also the panel's seat direction from the hull. */
  nx: number;
  ny: number;
  nz: number;
  /** Hexagon circumradius as a fraction of the bubble radius. */
  radius: number;
  /**
   * Stable 0..1 draw for this panel, used as its stagger position in the
   * assemble sweep. Deliberately NOT the panel index: assembling in spiral
   * order reads as a machine printing a ball, and the owner asked for panels
   * flying out of the ship, which wants a scattered order.
   */
  jitter: number;
  /** Unit tumble axis for the shatter, and a 0.6..1.4 speed multiplier. */
  spinX: number;
  spinY: number;
  spinZ: number;
  speed: number;
}

/**
 * Panels for one shell, spiral-ordered. Allocated once per distinct count and
 * shared by every shield on screen (the layout is identical for all of them —
 * only the radius each is drawn at differs), so ten shielded ships cost one
 * array, not ten.
 */
export function shieldPanelLayout(count: number, overlap: number): ShieldPanel[] {
  const n = Math.max(1, Math.floor(count));
  // Hexagon circumradius that tiles the sphere with `n` cells: each cell owns
  // 4π/n of unit-sphere area, and a regular hexagon of circumradius R covers
  // (3√3/2)R². Solved for R, then opened up by the overlap knob so neighbours
  // meet instead of leaving the hull visible between them.
  const radius = Math.sqrt((8 * Math.PI) / (3 * Math.sqrt(3) * n)) * Math.max(0.01, overlap);
  const panels: ShieldPanel[] = [];
  for (let i = 0; i < n; i++) {
    // Offset by half a step so neither pole gets a panel exactly on it (a panel
    // there has no well-defined tangent basis and would spin visibly).
    const y = 1 - (2 * i + 1) / n;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i;
    const spin = unitFromHash(hash01(i * 3 + 1), hash01(i * 3 + 2));
    panels.push({
      nx: Math.cos(theta) * ring,
      ny: y,
      nz: Math.sin(theta) * ring,
      radius,
      jitter: hash01(i),
      spinX: spin.x,
      spinY: spin.y,
      spinZ: spin.z,
      speed: 0.6 + 0.8 * hash01(i * 7 + 5),
    });
  }
  return panels;
}

/**
 * Panels this quality tier will pay for. The theme authors the full-fat count;
 * a tier scales it by the same particle budget multiplier that decides how many
 * sparks a hit throws — one dial for "how much decoration is this machine
 * willing to draw" — and the result is clamped into a band where the shell
 * still reads as hexagons (below ~40 it reads as scattered plates) and can
 * never become a thousand-panel buffer write per shield per frame.
 */
export function shieldPanelCount(authored: number, budgetMultiplier: number): number {
  const scaled = Math.round(authored * Math.max(0, budgetMultiplier));
  return Math.min(200, Math.max(40, scaled));
}

/**
 * Tangent basis for a panel: two unit vectors spanning the plane its hexagon
 * lies in, written into `out`. Built from whichever world axis is least aligned
 * with the normal, so it never degenerates at the poles.
 */
export function panelBasis(
  panel: Pick<ShieldPanel, "nx" | "ny" | "nz">,
  out: { tx: number; ty: number; tz: number; bx: number; by: number; bz: number },
): void {
  // Least-aligned cardinal axis as the seed — cross-producting with a nearly
  // parallel vector is what makes a naive basis flip at the poles.
  const ax = Math.abs(panel.nx);
  const ay = Math.abs(panel.ny);
  const az = Math.abs(panel.nz);
  let sx = 0;
  let sy = 0;
  let sz = 0;
  if (ax <= ay && ax <= az) sx = 1;
  else if (ay <= az) sy = 1;
  else sz = 1;
  let tx = sy * panel.nz - sz * panel.ny;
  let ty = sz * panel.nx - sx * panel.nz;
  let tz = sx * panel.ny - sy * panel.nx;
  const tlen = Math.hypot(tx, ty, tz) || 1;
  tx /= tlen;
  ty /= tlen;
  tz /= tlen;
  out.tx = tx;
  out.ty = ty;
  out.tz = tz;
  out.bx = panel.ny * tz - panel.nz * ty;
  out.by = panel.nz * tx - panel.nx * tz;
  out.bz = panel.nx * ty - panel.ny * tx;
}

/**
 * Deterministic 0..1 from an integer — a small integer hash, not `Math.random`,
 * so a shell looks the same every time it goes up and a test can assert on an
 * exact panel. (Determinism is not a sim requirement here: shields are pure
 * decoration. It is a debugging one — "the panel that clipped" has to be the
 * same panel next run.)
 */
export function hash01(i: number): number {
  let x = (Math.floor(i) + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** A unit vector from two 0..1 draws, uniform over the sphere. */
function unitFromHash(u: number, v: number): { x: number; y: number; z: number } {
  const z = 2 * u - 1;
  const ring = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * v;
  return { x: Math.cos(phi) * ring, y: z, z: Math.sin(phi) * ring };
}

/** Panel count and overlap a settings block asks for, at one quality budget. */
export function layoutFor(settings: ShieldRippleSettings, budgetMultiplier: number): ShieldPanel[] {
  return shieldPanelLayout(shieldPanelCount(settings.panelCount, budgetMultiplier), settings.panelOverlap);
}
