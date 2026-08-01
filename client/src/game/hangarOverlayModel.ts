import type { HangarStatPanel } from "./hangarStats.js";

/**
 * View model for the Hangar's STAGE overlay — the semi-opaque instrument block
 * that sits on the 3D half of the split screen (owner 2026-08-01).
 *
 * Two {@link HangarStatPanel}s go in: the fit as it stands, and — while the
 * player is CONSIDERING a module (hovering/selecting one in the picker, or
 * hovering "remove") — the fit as it would be if they went through with it. Out
 * comes one row per characteristic with a base fill, a GHOST segment covering
 * the ground between the two, and the signed delta.
 *
 * All of it is pure arithmetic on purpose: the Hangar's DOM wiring stays a thin
 * loop over {@link HangarOverlayModel.gauges}, and the interesting part (what a
 * gauge is worth, when it turns dangerous, which way a change is an
 * improvement) is testable without a DOM or an engine.
 */

export type HangarGaugeKey = "power" | "hull" | "speed" | "capacitor" | "heat" | "dps";

/** Which way a change moves for the PILOT, not for the number. */
export type HangarGaugeTrend = "none" | "better" | "worse";

export interface HangarGauge {
  key: HangarGaugeKey;
  /** Short uppercase caption, e.g. "POWER". */
  label: string;
  /** The value the CURRENT fit has. */
  value: number;
  /** Right-hand readout for the current fit, e.g. `"12 / 10"`. */
  valueText: string;
  /** Base fill, 0..1 of the gauge track. */
  fraction: number;
  /**
   * Projected fill, 0..1, or null when nothing is being considered (or the
   * candidate changes nothing on this row). The ghost SEGMENT the UI draws is
   * the span between this and {@link HangarGauge.fraction}.
   */
  ghostFraction: number | null;
  /** Projected value, or null when there is no preview. */
  ghostValue: number | null;
  /** `ghostValue - value`, or null when there is no preview / no change. */
  delta: number | null;
  /** The delta with a sign and this gauge's precision, e.g. `"+1.4"`. */
  deltaText: string | null;
  /** Whether the projected value is an improvement, a regression, or a wash. */
  trend: HangarGaugeTrend;
  /** The CURRENT fit is in this gauge's danger band (power over rail, etc.). */
  warn: boolean;
  /** The PROJECTED fit is in the danger band — what turns the ghost red. */
  ghostWarn: boolean;
  /**
   * Where the gauge's reference line sits, 0..1, or null when it has none. Only
   * POWER has one: the rail capacity, which is exactly the line a fit must not
   * cross.
   */
  limitFraction: number | null;
}

export interface HangarOverlayModel {
  gauges: HangarGauge[];
  /** True when a candidate module is being considered (ghosts are live). */
  previewing: boolean;
  /** Rail draw vs capacity for the fit as it stands. */
  powerDraw: number;
  powerCapacity: number;
  /** How far over the rail the fit is (0 when it fits). */
  powerOverBy: number;
  /** Same, for the projected fit; equals {@link powerOverBy} with no preview. */
  projectedPowerOverBy: number;
  /** True when the current OR the projected fit over-subscribes the rail. */
  powerWarn: boolean;
}

/**
 * Nominal full-scale value per gauge — what a bar reads as "full" when nothing
 * exceeds it. Presentation only: they are chosen a comfortable step above the
 * shipped hulls' fully-upgraded numbers so the same fill means the same thing
 * across ships, and any value that DOES exceed one simply re-scales that gauge
 * (see {@link scaleFor}) rather than clipping. Power is the exception — its
 * reference is the hull's own rail capacity, because that is the number the fit
 * is judged against.
 */
export const HANGAR_GAUGE_REFERENCE: Record<Exclude<HangarGaugeKey, "power">, number> = {
  hull: 250,
  speed: 40,
  capacitor: 250,
  heat: 250,
  dps: 40,
};

/** Below this a "change" is float noise, not a change the pilot made. */
const EPSILON = 1e-6;

interface GaugeSpec {
  key: HangarGaugeKey;
  label: string;
  decimals: number;
  /** True when a bigger number is better for the pilot (power/heat-load are not). */
  higherIsBetter: boolean;
  value: (p: HangarStatPanel) => number;
  reference: (p: HangarStatPanel) => number;
  valueText: (p: HangarStatPanel) => string;
  warn: (p: HangarStatPanel) => boolean;
  limit?: (p: HangarStatPanel) => number;
}

const SPECS: readonly GaugeSpec[] = [
  {
    // The headline: what the fit asks of the rail, against what the rail gives.
    key: "power",
    label: "Power",
    decimals: 0,
    higherIsBetter: false,
    value: (p) => p.powerDrawTotal,
    reference: (p) => p.powerCapacity,
    valueText: (p) => `${round(p.powerDrawTotal, 0)} / ${round(p.powerCapacity, 0)}`,
    warn: (p) => p.powerOverSubscribed,
    limit: (p) => p.powerCapacity,
  },
  {
    key: "hull",
    label: "Hull",
    decimals: 0,
    higherIsBetter: true,
    value: (p) => p.hullMax,
    reference: () => HANGAR_GAUGE_REFERENCE.hull,
    valueText: (p) => round(p.hullMax, 0),
    warn: () => false,
  },
  {
    key: "speed",
    label: "Speed",
    decimals: 1,
    higherIsBetter: true,
    value: (p) => p.nominalSpeed,
    reference: () => HANGAR_GAUGE_REFERENCE.speed,
    valueText: (p) => round(p.nominalSpeed, 1),
    warn: () => false,
  },
  {
    // The bar is the capacitor; the reading beside it is the IDLE budget, which
    // is the half of "energy" a fit can actually get wrong.
    key: "capacitor",
    label: "Capacitor",
    decimals: 0,
    higherIsBetter: true,
    value: (p) => p.capacitorMax,
    reference: () => HANGAR_GAUGE_REFERENCE.capacitor,
    valueText: (p) => `${round(p.capacitorMax, 0)} · ${signed(p.energyBudget, 1)}/s`,
    warn: (p) => p.energyBudget < 0,
  },
  {
    // Likewise heat: capacity on the bar, the sustained-fire trend beside it —
    // a positive trend is a fit that cooks itself.
    key: "heat",
    label: "Heat",
    decimals: 0,
    higherIsBetter: true,
    value: (p) => p.heatCapacity,
    reference: () => HANGAR_GAUGE_REFERENCE.heat,
    valueText: (p) => `${round(p.heatCapacity, 0)} · ${signed(p.heatNetPerSec, 1)}/s`,
    warn: (p) => p.heatNetPerSec > 0,
  },
  {
    key: "dps",
    label: "DPS",
    decimals: 1,
    higherIsBetter: true,
    value: (p) => p.dps,
    reference: () => HANGAR_GAUGE_REFERENCE.dps,
    valueText: (p) => round(p.dps, 1),
    warn: () => false,
  },
];

/**
 * Build the overlay's gauges from the current fit and, optionally, the fit that
 * would result from the module the player is considering.
 *
 * `ghost` must be a panel computed over the SAME hull with the candidate module
 * substituted into its slot (so a swap already accounts for dropping whatever
 * was in there) — this module does no fitting arithmetic of its own.
 */
export function buildOverlayModel(base: HangarStatPanel, ghost: HangarStatPanel | null): HangarOverlayModel {
  const gauges = SPECS.map((spec) => gaugeOf(spec, base, ghost));
  const projected = ghost ?? base;
  return {
    gauges,
    previewing: ghost !== null,
    powerDraw: base.powerDrawTotal,
    powerCapacity: base.powerCapacity,
    powerOverBy: Math.max(0, base.powerDrawTotal - base.powerCapacity),
    projectedPowerOverBy: Math.max(0, projected.powerDrawTotal - projected.powerCapacity),
    powerWarn: base.powerOverSubscribed || projected.powerOverSubscribed,
  };
}

function gaugeOf(spec: GaugeSpec, base: HangarStatPanel, ghost: HangarStatPanel | null): HangarGauge {
  const value = spec.value(base);
  const ghostValue = ghost ? spec.value(ghost) : null;
  // ONE scale for both bars, or the ghost would not be comparable with the fill
  // it extends. The reference keeps a light hull's bar short instead of
  // normalising every ship to "full"; a value past it re-scales the gauge so
  // nothing is ever silently clipped.
  const scale = scaleFor(spec.reference(base), value, ghostValue);
  const changed = ghostValue !== null && Math.abs(ghostValue - value) > EPSILON;
  const delta = changed ? ghostValue! - value : null;

  return {
    key: spec.key,
    label: spec.label,
    value,
    valueText: spec.valueText(base),
    fraction: clamp01(value / scale),
    ghostFraction: changed ? clamp01(ghostValue! / scale) : null,
    ghostValue,
    delta,
    deltaText: delta === null ? null : signed(delta, spec.decimals),
    trend: delta === null ? "none" : delta > 0 === spec.higherIsBetter ? "better" : "worse",
    warn: spec.warn(base),
    ghostWarn: ghost ? spec.warn(ghost) : false,
    limitFraction: spec.limit ? clamp01(spec.limit(base) / scale) : null,
  };
}

/** The gauge's full-scale value: its reference, stretched by anything past it. */
function scaleFor(reference: number, value: number, ghostValue: number | null): number {
  return Math.max(1e-6, reference, value, ghostValue ?? 0);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function round(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

/** A delta/trend reading always carries its sign — "+0" is not a thing. */
function signed(v: number, decimals: number): string {
  const text = v.toFixed(decimals);
  return v > 0 ? `+${text}` : text;
}
