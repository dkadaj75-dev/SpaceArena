import type { ModuleConfig, StatOp } from "@space-arena/shared";

/**
 * The at-a-glance numbers a module row shows in the Hangar's picker (owner
 * 2026-07-31). Each entry is a short label plus an already-formatted value, so
 * the list stays a dumb renderer and every "what matters for this family"
 * decision lives here, tested.
 *
 * What matters differs by family, which is the point:
 *  - a weapon is judged on damage per second, its cycle time and power draw;
 *  - a shield on what it stops and what it costs to hold up;
 *  - an engine/generator/transformer/countermeasure/sensor on the stat it moves.
 */
export interface ModuleStat {
  label: string;
  value: string;
}

/** Sustained damage per second, or 0 for anything that does not shoot. */
export function moduleDps(cfg: ModuleConfig): number {
  const fire = cfg.fire;
  if (!fire) return 0;
  // A `continuous` weapon authors DPS directly; everything else is per-shot
  // damage over its cycle.
  if (fire.mode === "continuous") return fire.damage;
  return fire.cycleTime > 0 ? fire.damage / fire.cycleTime : 0;
}

const num = (v: number, digits = 0): string => v.toFixed(digits).replace(/\.0+$/, "");
const signed = (v: number, digits = 0): string => `${v >= 0 ? "+" : ""}${num(v, digits)}`;
/** A multiplier as a percentage delta: 1.15 → "+15%", 0.88 → "−12%". */
const pct = (mult: number): string => {
  const delta = Math.round((mult - 1) * 100);
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}%`;
};

/** Human label for a stat path a passive touches. */
const STAT_LABELS: Record<string, string> = {
  "engine.nominalSpeed": "Speed",
  "engine.accel": "Accel",
  "engine.turnRate": "Turn",
  "energyStore.multiplier": "Tanks",
  "recharge.multiplier": "Recharge",
  "sensors.lockRange": "Range",
  "sensors.lockTimeSec": "Lock time",
  "sensors.coneDeg": "Cone",
  "efficiency.energyDraw": "Draw",
  "power.capacity": "Power",
};

function passiveStats(passives: readonly StatOp[] | undefined): ModuleStat[] {
  if (!passives?.length) return [];
  return passives.map((op) => {
    const path = op.target.startsWith("core.") ? op.target.slice("core.".length) : op.target;
    const label = STAT_LABELS[path] ?? path;
    return { label, value: op.op === "mul" ? pct(op.value) : signed(op.value, 1) };
  });
}

/**
 * The stat chips for one module, in display order. Keep it short — the picker
 * shows three or four rows at a time and each row has one line for these.
 */
export function moduleStats(cfg: ModuleConfig): ModuleStat[] {
  const stats: ModuleStat[] = [];

  if (cfg.fire) {
    stats.push({ label: "DPS", value: num(moduleDps(cfg), 1) });
    stats.push({ label: "Range", value: num(cfg.fire.range) });
    // Cycle time is a weapon's ONLY limiter since the heat system was deleted
    // (2026-08-20), so it is now a headline number rather than a footnote. A
    // channelled beam has no cadence to report — it simply runs.
    if (cfg.fire.mode !== "continuous") {
      stats.push({ label: "Cycle", value: `${num(cfg.fire.cycleTime, 2)}s` });
    }
  }
  if (cfg.mitigation) {
    stats.push({ label: "Absorb", value: `${Math.round(cfg.mitigation.damageReduction * 100)}%` });
  }
  if (cfg.boost) stats.push({ label: "Boost", value: pct(cfg.boost.speedMult) });
  if (cfg.jettison) stats.push({ label: "Jettison", value: `${num(cfg.jettison.cooldownSec)}s` });

  // The two support pulses (2026-08-22). What a pilot fits them against is HOW
  // MUCH and FOR HOW LONG, then the wait — so all three travel, in that order,
  // and the cooldown is last because it is the cost rather than the effect.
  if (cfg.slow) {
    stats.push({ label: "Slow", value: `−${Math.round(cfg.slow.factor * 100)}%` });
    stats.push({ label: "For", value: `${num(cfg.slow.durationSec, 1)}s` });
    stats.push({ label: "Range", value: num(cfg.slow.range) });
    stats.push({ label: "Cooldown", value: `${num(cfg.slow.cooldownSec, 1)}s` });
  }
  if (cfg.repairField) {
    stats.push({ label: "Repair", value: `+${num(cfg.repairField.healAmount)}` });
    stats.push({ label: "Radius", value: num(cfg.repairField.radiusUnits) });
    stats.push({ label: "Cooldown", value: `${num(cfg.repairField.cooldownSec, 1)}s` });
  }

  // The two axes a pilot fits against (2026-07-31 / 2026-08-07): "Power" is the
  // rail current this module holds while online — a flat number budgeted
  // against the hull's capacity — while "Tank" is the module's OWN energy store
  // and how long it lasts flat out. A pilot fits against the first and flies
  // against the second.
  if (cfg.power?.draw) stats.push({ label: "Power", value: num(cfg.power.draw, 1) });

  if (cfg.energy) {
    stats.push({ label: "Tank", value: num(cfg.energy.capacity) });
    if (cfg.energy.drawPerSec > 0) {
      stats.push({ label: "Lasts", value: `${num(cfg.energy.capacity / cfg.energy.drawPerSec, 1)}s` });
    }
    if (cfg.energy.rechargePerSec > 0) {
      stats.push({ label: "Refill", value: `${num(cfg.energy.capacity / cfg.energy.rechargePerSec, 1)}s` });
    }
  }

  if (cfg.recharge) stats.push({ label: "Recharge", value: pct(cfg.recharge.multiplier) });

  stats.push(...passiveStats(cfg.passives));
  return stats;
}

/** One-line summary for a module row, e.g. "DPS 17.5 · Range 95 · Power 11/s". */
export function moduleSummaryLine(cfg: ModuleConfig): string {
  const stats = moduleStats(cfg);
  if (stats.length === 0) return "No active effect";
  return stats.map((s) => `${s.label} ${s.value}`).join(" · ");
}
