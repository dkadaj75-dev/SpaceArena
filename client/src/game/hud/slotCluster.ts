import type { HudAnchorName } from "@space-arena/shared";
import type { Viewport } from "./hudLayout.js";

/**
 * Pure layout math for the two HARDPOINT SLOT CLUSTERS (owner HUD pass,
 * 2026-08-21), in the same spirit as {@link import("./hudLayout.js")} and
 * {@link import("./flightHudLayout.js")}: a plain function of a count and the
 * viewport, so every position and every diameter is unit-testable without a
 * browser and nothing about the clusters is hardcoded in CSS.
 *
 * ## What replaced what
 *
 * Before this file the flight HUD placed every fitted module on ONE arc hugging
 * the bottom-right FIRE pedestal, with BOOST and JETTISON queued behind them on
 * the same rail (`flightHudLayout.actionArcSlots`). Weapons and utilities were
 * therefore interleaved by fitting order, the pilot's primary weapon was a
 * visibly larger "pedestal" than its neighbours, and the arc grew or split as
 * the fitting changed — the HUD literally changed shape between hulls.
 *
 * The clusters replace that with one rule per thumb:
 *
 *  - **right cluster = every weapon hardpoint**, **left cluster = every
 *    utilitarian skill** (deployables, BOOST, JETTISON). A pilot learns "guns
 *    right, kit left" once and it never moves.
 *  - **uniform diameter within a cluster**, sized by how many mounts that side
 *    carries ({@link slotSizePx}) — no pedestal, no odd one out.
 *  - **packed into the corner** in staggered rows ({@link slotClusterRows}),
 *    slot 01 nearest the corner, so the first slot is always the easiest reach.
 *
 * Offsets follow the same convention as the rest of the HUD: `offsetXPx` and
 * `offsetYPx` are the gap between the anchored CORNER and the button's NEAR
 * edges, ready for `anchoredOffset` — so a widget never does corner math.
 */

/** Which thumb a cluster belongs to. Weapons fire; utilities do everything else. */
export type SlotSide = "weapons" | "utilities";

/** Anchor corner for each side. Both hug the bottom, inside the safe-area inset. */
export const SLOT_SIDE_ANCHORS: Readonly<Record<SlotSide, HudAnchorName>> = {
  weapons: "bottom-right",
  utilities: "bottom-left",
};

/**
 * Diameter ramp, in the owner's own numbers: 2 mounts → 82 px, 4 → 70, 6 → 58.
 * Those three points are exactly linear, so the ramp IS the line through them
 * (`94 − 6·count`) rather than a table with invented values in the gaps — a
 * 3-mount hull lands on 76 and a 5-mount hull on 64 with no special-casing.
 */
export const SLOT_SIZE_INTERCEPT_PX = 94;
export const SLOT_SIZE_PER_MOUNT_PX = 6;

/**
 * Hard floor: 44 px is the smallest reliable touch target, and this game is
 * played on phones. A fitting dense enough to want smaller buttons gets
 * 44 px ones packed tighter, never a 38 px one nobody can hit.
 */
export const SLOT_MIN_SIZE_PX = 44;

/** Ceiling, so a single-mount hull does not get a dinner plate. */
export const SLOT_MAX_SIZE_PX = 88;

/** Centre-to-centre spacing within a row, as a multiple of the diameter. */
export const SLOT_PITCH_RATIO = 1.1;

/** Centre-to-centre spacing between rows. Slightly tighter: the stagger opens it back up. */
export const SLOT_ROW_PITCH_RATIO = 1.04;

/**
 * How far each odd row is pushed inward along its row axis, as a multiple of the
 * diameter. This is what makes the cluster a CLUSTER rather than a grid — and at
 * two mounts (one button per row) it is the whole of the "stacked with a slight
 * offset" shape.
 */
export const SLOT_STAGGER_RATIO = 0.34;

/** Gap between the anchored corner and the nearest button's near edges. */
export const SLOT_MARGIN_PX = 12;

/**
 * Share of the viewport width ONE cluster may occupy. Two clusters plus a
 * breathing gap have to coexist on a 360 px phone, so a wide fitting shrinks its
 * buttons (down to {@link SLOT_MIN_SIZE_PX}) rather than sliding under the other
 * thumb's cluster.
 */
export const SLOT_MAX_CLUSTER_WIDTH_FRACTION = 0.44;

export interface SlotClusterOptions {
  /** Viewport, for the width clamp. Omitted ⇒ no clamp (unit tests, headless). */
  viewport?: Viewport;
  /** `theme.hud.scale`, applied to the ramp exactly like every other dimension. */
  scale?: number;
  /** Corner gap override; defaults to {@link SLOT_MARGIN_PX} (scaled). */
  marginPx?: number;
}

/** One placed hardpoint button. */
export interface SlotPlacement {
  /** 0-based position in the cluster. The button PRINTS `index + 1` as "01", "02"… */
  index: number;
  /** Row 0 is the row nearest the corner. */
  row: number;
  /** Column 0 is the column nearest the screen edge the cluster hugs. */
  column: number;
  anchor: HudAnchorName;
  sizePx: number;
  /** Gap from the corner to the button's near edges — feed to `anchoredOffset`. */
  offsetXPx: number;
  offsetYPx: number;
}

export interface SlotClusterLayout {
  side: SlotSide;
  anchor: HudAnchorName;
  count: number;
  sizePx: number;
  /** Buttons in the widest row. */
  perRow: number;
  /** Buttons per row, corner row first. Sums to `count`. */
  rows: number[];
  slots: SlotPlacement[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Buttons in the widest row: 1 up to two mounts, 2 up to four, 3 beyond. This is
 * `ceil(count / 2)` capped at three, which reproduces the three shapes the owner
 * drew — 2 stacked, 4 as 2×2, 6 as two rows of 3 — from one expression, and
 * keeps a 7- or 8-mount hull at three columns rather than spilling sideways.
 */
export function slotsPerRow(count: number): number {
  if (count <= 0) return 0;
  return clamp(Math.ceil(count / 2), 1, 3);
}

/**
 * Buttons per row, corner row first, balanced so no row is left with a single
 * straggler when an even split exists: 7 mounts is 3/2/2, never 3/3/1.
 */
export function slotClusterRows(count: number): number[] {
  const perRow = slotsPerRow(count);
  if (perRow === 0) return [];
  const rowCount = Math.ceil(count / perRow);
  const base = Math.floor(count / rowCount);
  const extra = count % rowCount;
  const rows: number[] = [];
  for (let r = 0; r < rowCount; r++) rows.push(base + (r < extra ? 1 : 0));
  return rows;
}

/**
 * Uniform button diameter for a cluster of `count` mounts: the ramp, clamped to
 * the touch-target floor and the sensible ceiling, then clamped again so the
 * whole cluster still fits inside {@link SLOT_MAX_CLUSTER_WIDTH_FRACTION} of the
 * viewport. The floor wins over the width clamp — a button too small to hit is
 * worse than two clusters that nearly meet.
 */
export function slotSizePx(count: number, opts: SlotClusterOptions = {}): number {
  if (count <= 0) return 0;
  const scale = opts.scale ?? 1;
  const ramp = SLOT_SIZE_INTERCEPT_PX - SLOT_SIZE_PER_MOUNT_PX * count;
  let size = clamp(ramp, SLOT_MIN_SIZE_PX, SLOT_MAX_SIZE_PX) * scale;
  const viewport = opts.viewport;
  if (viewport && viewport.width > 0) {
    const margin = (opts.marginPx ?? SLOT_MARGIN_PX) * scale;
    // Width of the cluster in multiples of the diameter: the leading columns at
    // their pitch, the staggered inset of the odd rows, and the last button.
    const perRow = slotsPerRow(count);
    const widthPerSize = (perRow - 1) * SLOT_PITCH_RATIO + SLOT_STAGGER_RATIO + 1;
    const budget = viewport.width * SLOT_MAX_CLUSTER_WIDTH_FRACTION - margin;
    if (widthPerSize > 0) size = Math.min(size, budget / widthPerSize);
  }
  return Math.max(SLOT_MIN_SIZE_PX * scale, size);
}

/**
 * The full placement for one side's cluster. Slots are filled row-major from the
 * corner outward, so slot 01 is the corner button and the numbering a pilot
 * reads matches the order their thumb reaches them in.
 */
export function resolveSlotCluster(
  count: number,
  side: SlotSide,
  opts: SlotClusterOptions = {},
): SlotClusterLayout {
  const anchor = SLOT_SIDE_ANCHORS[side];
  const scale = opts.scale ?? 1;
  const margin = (opts.marginPx ?? SLOT_MARGIN_PX) * scale;
  const sizePx = slotSizePx(count, opts);
  const rows = slotClusterRows(count);
  const pitch = sizePx * SLOT_PITCH_RATIO;
  const rowPitch = sizePx * SLOT_ROW_PITCH_RATIO;
  const stagger = sizePx * SLOT_STAGGER_RATIO;

  const slots: SlotPlacement[] = [];
  let index = 0;
  for (let row = 0; row < rows.length; row++) {
    const inRow = rows[row]!;
    for (let column = 0; column < inRow; column++) {
      slots.push({
        index,
        row,
        column,
        anchor,
        sizePx,
        offsetXPx: margin + column * pitch + (row % 2 === 1 ? stagger : 0),
        offsetYPx: margin + row * rowPitch,
      });
      index++;
    }
  }
  return { side, anchor, count, sizePx, perRow: slotsPerRow(count), rows, slots };
}

/** `1` → `"01"`. Two digits up to 99, then however many the fitting needs. */
export function slotNumberLabel(oneBasedIndex: number): string {
  return oneBasedIndex < 10 ? `0${oneBasedIndex}` : String(oneBasedIndex);
}
