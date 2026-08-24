import type { ModuleConfig } from "@space-arena/shared";
import type { HangarStatPanel } from "./hangarStats.js";
import { buildOverlayModel, type HangarGaugeKey, type HangarGaugeTrend } from "./hangarOverlayModel.js";

/**
 * The LOADOUT DECK's view model (owner 2026-08-22) — everything the redesigned
 * Hangar panel needs that is arithmetic or string work rather than DOM.
 *
 * The screen is a 3D viewer on the left and a deck of slot TILES on the right;
 * tapping a tile bursts a radial of the modules that socket accepts over the
 * ship. Each piece of that has a pure function here, so the interesting parts
 * (the fan geometry, the two-letter codes, the before/after readout, the power
 * pips) are testable without a DOM, a Babylon scene or a network.
 *
 * Nothing here resolves stats: the compare rows are built from two
 * {@link HangarStatPanel}s the caller has already had `computeStatPanel`
 * resolve, so a preview and the fit it is compared against always come out of
 * the same resolver the sim uses.
 */

// --- module codes -----------------------------------------------------------

/**
 * Tokens that identify a module's TIER rather than what it is. Dropped before a
 * code is derived, so "Pulse Laser Mk I" and "Pulse Laser Mk III" both read as
 * the same weapon — the tile and the radial item print the full name beside the
 * code, which is what separates the marks.
 */
const TIER_TOKEN = /^(?:mk|mark|purity|engineered|[ivx]+|\d+)$/i;

/**
 * The two-letter code a module is known by on the deck (spec: "module identities
 * use 2-letter mono codes"; no icon assets required).
 *
 * DERIVED, never authored: content ships no short code and the HUD's glyph set
 * (`hud/moduleIcons.ts`) answers a different question — it draws a FAMILY, so
 * every laser resolves to one picture and the deck needs the module. The rule is
 * the initials of the first two significant words, or the first two letters of a
 * one-word name; it is stable for a given name, which is what matters when the
 * same code has to mean the same module across tiles, radial items and tests.
 */
export function moduleCode(cfg: Pick<ModuleConfig, "id" | "name"> | undefined): string {
  if (!cfg) return "--";
  const words = (cfg.name ?? "").split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0 && !TIER_TOKEN.test(w));
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  if (words.length === 1 && words[0]!.length >= 2) return words[0]!.slice(0, 2).toUpperCase();
  // A name that is nothing but tier tokens (or empty) still has to read as
  // something: the id's last segment is the only other stable handle.
  const tail = cfg.id.split(/[.\-_]/).filter((s) => s.length > 0).pop() ?? "?";
  return tail.slice(0, 2).toUpperCase().padEnd(2, "-");
}

// --- module lines (the radial's first level) --------------------------------

/**
 * Tier SUFFIXES the content overhaul settled on: `-mk1..mk4` for weapons and
 * systems, `-p1..p4` for the alloy purities, `-eng1..eng4` for the engineered
 * engine and generator ladders.
 *
 * Parsed off the ID rather than read from a field because there is no field:
 * `ModuleConfig` carries `family` (laser / kinetic / hull …) and `level`, and
 * nothing that says "these four entries are the same weapon, four marks apart"
 * — `shopModel.moduleGroups` groups by the coarse family for the same reason.
 * The id is the only place the relationship is recorded, and it is recorded
 * consistently; a module with no tier suffix is simply a line of one.
 */
const TIER_SUFFIX = /-(?:mk|mark|p|eng)\d+$/i;

/** The id every tier of one module line shares — `module.laser-mk3` → `module.laser`. */
export function moduleLineKey(cfg: Pick<ModuleConfig, "id">): string {
  return cfg.id.replace(TIER_SUFFIX, "");
}

/** The line's name: the module's own, with its tier words taken off the end. */
export function moduleLineName(cfg: Pick<ModuleConfig, "id" | "name">): string {
  const words = (cfg.name ?? "").split(/\s+/).filter((w) => w.length > 0);
  // A name that is NOTHING but tier words has no line name to find, so it keeps
  // its own rather than being stripped to a fragment of itself.
  while (words.length > 0 && TIER_TOKEN.test(words[words.length - 1]!)) words.pop();
  const name = words.join(" ").trim();
  return name.length > 0 ? name : (cfg.name ?? cfg.id);
}

export interface ModuleLine<T extends Pick<ModuleConfig, "id" | "name" | "level">> {
  key: string;
  /** What the radial's first level calls it, e.g. `Pulse Laser`. */
  name: string;
  /** The two-letter code, which every tier of a line shares by construction. */
  code: string;
  /** Every tier in the line, lowest first. */
  tiers: T[];
}

/**
 * Group a socket's candidates into LINES (owner 2026-08-22): the radial's first
 * level offers "Pulse Laser", not four marks of it, and picking a line with more
 * than one variant opens a second fan of just that line's tiers.
 *
 * Lines come back in the order their lowest tier had — level, then name — so a
 * line keeps its seat in the fan from one open to the next.
 */
export function groupModuleLines<T extends Pick<ModuleConfig, "id" | "name" | "level">>(
  modules: readonly T[],
): ModuleLine<T>[] {
  const lines = new Map<string, ModuleLine<T>>();
  const ordered = [...modules].sort((a, b) => a.level - b.level || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  for (const mod of ordered) {
    const key = moduleLineKey(mod);
    const line = lines.get(key);
    if (line) line.tiers.push(mod);
    else lines.set(key, { key, name: moduleLineName(mod), code: moduleCode(mod), tiers: [mod] });
  }
  return [...lines.values()];
}

/**
 * The slot label under a tile, from the socket id — `hp-nose-l` → `HP-NOSE L`,
 * `in-engine` → `ENGINE`.
 *
 * The spec's `HP-NOSE` / `ENGINE` labels are representative; these are the real
 * socket ids the hulls author, uppercased and with the internal bays' `in-`
 * prefix dropped (the section heading above them already says CORE / INTERNAL,
 * so repeating it on every tile would be noise).
 */
export function slotLabel(socketId: string): string {
  if (socketId.startsWith("in-")) return socketId.slice(3).replace(/-/g, " ").toUpperCase();
  if (socketId.startsWith("hp-")) return `HP-${socketId.slice(3).replace(/-/g, " ")}`.toUpperCase();
  return socketId.replace(/-/g, " ").toUpperCase();
}

/*
 * A note on AVAILABILITY (owner 2026-08-22). Ownership in this game is BINARY:
 * `OwnershipStore` holds a set of unlocked module ids and there are no
 * quantities anywhere in it, so the radial has no count to print and its
 * "unavailable" state means UNLOCKED-NO, never "you have run out". Whether one
 * unlocked module may sit in two sockets at once is the fitting validation's
 * question, not this file's — and today it says yes (the brawler's stock fit
 * carries the same generator twice).
 */

// --- before / after compare -------------------------------------------------

export interface DeckCompareRow {
  key: HangarGaugeKey;
  /** Caption, e.g. `INTEGRITY`. */
  label: string;
  /** The reading for the fit as it stands. */
  value: string;
  /** The reading the candidate would produce, or null when nothing is previewed. */
  projected: string | null;
  /** `▲` / `▼`, or null when there is no change to point at. */
  arrow: string | null;
  trend: HangarGaugeTrend;
  /** The projected fit is in the danger band (power past the rail). */
  warn: boolean;
}

/**
 * The four rows of the SHIP SPECS — BEFORE / AFTER box, in the spec's order.
 *
 * Built on {@link buildOverlayModel} rather than beside it: that module already
 * owns which way a change counts as an improvement and when a gauge turns
 * dangerous, and having two answers to those questions on one screen is exactly
 * the bug this avoids. Only the labels and the row set are the deck's.
 */
const COMPARE_LABELS: ReadonlyMap<HangarGaugeKey, string> = new Map([
  ["hull", "INTEGRITY"],
  ["speed", "SPEED"],
  ["dps", "DPS"],
  ["power", "POWER"],
]);

export function deckCompareRows(base: HangarStatPanel, ghost: HangarStatPanel | null): DeckCompareRow[] {
  const model = buildOverlayModel(base, ghost);
  const byKey = new Map(model.gauges.map((g) => [g.key, g]));
  const rows: DeckCompareRow[] = [];
  for (const [key, label] of COMPARE_LABELS) {
    const gauge = byKey.get(key);
    if (!gauge) continue;
    // A change too small to survive the reading's own rounding is not a change
    // the pilot can see: quoting "5 / 10 ▲ 5 / 10" reads as a bug, not a
    // preview. The gauge still knows the delta is there; the box stays quiet.
    const changed = gauge.delta !== null && gauge.ghostValueText !== gauge.valueText;
    rows.push({
      key,
      label,
      value: gauge.valueText,
      projected: changed ? gauge.ghostValueText : null,
      arrow: changed ? (gauge.delta! > 0 ? "▲" : "▼") : null,
      // POWER is reported NEUTRAL unless it would break the rail (spec): drawing
      // more is the price of every module, not a regression by itself.
      trend: key === "power" ? "none" : gauge.trend,
      warn: gauge.ghostWarn,
    });
  }
  return rows;
}

// --- power pips -------------------------------------------------------------

export type DeckPipState = "filled" | "over" | "empty";

export interface DeckPower {
  used: number;
  capacity: number;
  /** One pip per point of capacity; a fit past the rail turns every filled pip red. */
  pips: DeckPipState[];
  /** `used / cap`, already rounded for display. */
  text: string;
  over: boolean;
}

/** Cap on how many pips are drawn — a pathological hull must not print a mile of them. */
const MAX_PIPS = 40;

export function deckPower(panel: HangarStatPanel): DeckPower {
  const used = Math.round(panel.powerDrawTotal);
  const capacity = Math.max(0, Math.round(panel.powerCapacity));
  const over = used > capacity;
  const count = Math.min(MAX_PIPS, capacity);
  const pips: DeckPipState[] = [];
  for (let i = 0; i < count; i++) pips.push(i < used ? (over ? "over" : "filled") : "empty");
  return { used, capacity, pips, text: `${used} / ${capacity}`, over };
}

// --- radial geometry --------------------------------------------------------

/** Diameter of one radial button, px (spec). */
export const RADIAL_ITEM_PX = 68;
/** Minimum distance between adjacent item CENTRES, px (spec). */
const RADIAL_SPACING_PX = 76;
/** Smallest fan the ring is ever drawn at, px (spec). */
const RADIAL_MIN_RADIUS_PX = 92;
/** Entrance stagger per item, ms (spec). */
export const RADIAL_STAGGER_MS = 25;
/**
 * Widest single fan we will draw before wrapping into a second arc.
 *
 * The prototype fanned five modules; a real hardpoint accepts six families and
 * therefore up to ~20 catalogue entries, and the spec's own radius formula grows
 * linearly with the count — twenty items want a 508px fan, which is wider than a
 * landscape phone's viewer is tall. Nine items (a 244px fan) is where the single
 * arc stops being a burst and starts being a wall, so beyond it the items wrap
 * onto concentric arcs one spacing apart. Everything at nine or fewer is exactly
 * the spec's geometry.
 */
const RADIAL_WRAP_RADIUS_PX = 244;

export interface RadialSeat {
  /** Offset from the radial's centre, px. */
  xPx: number;
  yPx: number;
  /** Entrance delay, ms. */
  delayMs: number;
}

export interface RadialLayout {
  seats: RadialSeat[];
  /** Distance from the centre to the outermost item's centre, px. */
  outerRadiusPx: number;
}

/** Items that fit on one upward fan of `radius` with centres ≥ one spacing apart. */
function arcCapacity(radius: number): number {
  return Math.max(1, Math.floor((Math.PI * radius) / RADIAL_SPACING_PX) - 1);
}

/** The spec's fan radius for `count` items: big enough that adjacent centres clear. */
function fanRadius(count: number): number {
  return Math.max(RADIAL_MIN_RADIUS_PX, Math.ceil(((count + 1) * RADIAL_SPACING_PX) / Math.PI));
}

/** One upward arc of `count` items: angle for item i is `-180° + (i+1)·180/(count+1)`. */
function arc(count: number, radius: number, indexOffset: number): RadialSeat[] {
  const seats: RadialSeat[] = [];
  for (let i = 0; i < count; i++) {
    const deg = -180 + ((i + 1) * 180) / (count + 1);
    const rad = (deg * Math.PI) / 180;
    seats.push({
      xPx: Math.round(radius * Math.cos(rad)),
      yPx: Math.round(radius * Math.sin(rad)),
      delayMs: (indexOffset + i) * RADIAL_STAGGER_MS,
    });
  }
  return seats;
}

/**
 * Where each radial item sits, as an offset from the radial's centre.
 *
 * Up to {@link RADIAL_WRAP_RADIUS_PX} this is the prototype's `radialPos()`
 * verbatim: one upward fan whose radius grows with the count. Past it the items
 * wrap onto concentric arcs, innermost first, each one spacing further out —
 * see the constant for why.
 */
export function radialLayout(count: number): RadialLayout {
  if (count <= 0) return { seats: [], outerRadiusPx: RADIAL_MIN_RADIUS_PX };
  const single = fanRadius(count);
  if (single <= RADIAL_WRAP_RADIUS_PX) return { seats: arc(count, single, 0), outerRadiusPx: single };

  const seats: RadialSeat[] = [];
  let placed = 0;
  let ring = 0;
  let outer = RADIAL_MIN_RADIUS_PX;
  while (placed < count) {
    const radius = RADIAL_MIN_RADIUS_PX + ring * RADIAL_SPACING_PX;
    const take = Math.min(count - placed, arcCapacity(radius));
    seats.push(...arc(take, radius, placed));
    placed += take;
    outer = radius;
    ring++;
  }
  return { seats, outerRadiusPx: outer };
}

/**
 * How much the radial has to be scaled down to fit a viewer of this size.
 *
 * The geometry above is authored in the spec's pixels; a landscape phone's
 * viewer is smaller than the 545×440 reference, and a desktop's is larger. The
 * layer is scaled rather than re-laid-out so the fan keeps its proportions —
 * and never past 1, because the spec's sizes are the intended ones.
 */
export function radialScale(outerRadiusPx: number, viewerWidthPx: number, viewerHeightPx: number): number {
  const room = Math.min(viewerWidthPx, viewerHeightPx) / 2 - 8;
  const needed = outerRadiusPx + RADIAL_ITEM_PX / 2;
  if (!Number.isFinite(room) || room <= 0 || needed <= 0) return 1;
  return Math.min(1, room / needed);
}
