import type {
  ConfigService,
  EntityId,
  EventBus,
  ConfigEvents,
  ModuleConfig,
  ShipSnapshot,
  Snapshot,
} from "@space-arena/shared";
import type { HudLayout } from "./hudLayout.js";

interface GaugeEntry {
  fill: HTMLDivElement;
  valueEl: HTMLSpanElement;
  lastPct: number;
  /** Last numerator/denominator written, so an unchanged frame builds no string. */
  lastValue: number;
  lastMax: number;
  lastWarn: boolean;
}

const HEAT_WARN_FRACTION = 0.75;

/**
 * Hull, shield-pool, energy and heat gauge bars (bottom-left, theme-positioned).
 * Shield-pool is the sum of active shield modules' `shieldPool` reservoirs
 * (there is no innate ship shield stat in MVP — shielding comes entirely from
 * fitted shield modules). Heat gets a warning color near the overheat range.
 */
export class Gauges {
  private readonly container: HTMLDivElement;
  private readonly hull: GaugeEntry;
  private readonly shield: GaugeEntry;
  private readonly energy: GaugeEntry;
  private readonly heat: GaugeEntry;

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    _bus: EventBus<ConfigEvents>,
    private readonly playerId: EntityId,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-gauges";
    root.appendChild(this.container);

    this.hull = this.buildRow("HULL", "hull");
    this.shield = this.buildRow("SHIELD", "shield");
    this.energy = this.buildRow("ENERGY", "energy");
    this.heat = this.buildRow("HEAT", "heat");
  }

  applyLayout(layout: HudLayout): void {
    this.container.dataset["anchor"] = layout.gauges.anchor;
  }

  private buildRow(labelText: string, cls: string): GaugeEntry {
    const row = document.createElement("div");
    row.className = "hud-gauge";
    const label = document.createElement("div");
    label.className = "hud-gauge-label";
    label.textContent = labelText;
    const track = document.createElement("div");
    track.className = "hud-gauge-track";
    const fill = document.createElement("div");
    fill.className = `hud-gauge-fill ${cls}`;
    fill.style.transform = "scaleX(1)";
    const valueEl = document.createElement("span");
    valueEl.className = "hud-gauge-label";
    valueEl.style.alignSelf = "flex-end";

    track.appendChild(fill);
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(valueEl);
    this.container.appendChild(row);

    return { fill, valueEl, lastPct: -1, lastValue: Number.NaN, lastMax: Number.NaN, lastWarn: false };
  }

  update(cur: Snapshot): void {
    // Indexed scan, not `Array.find` — this runs every render frame and the
    // predicate closure would be a fresh allocation each time.
    const ship = findShip(cur, this.playerId);
    if (!ship) return;

    this.set(this.hull, ship.hullMax > 0 ? ship.hull / ship.hullMax : 0, Math.ceil(ship.hull), ship.hullMax);

    let shieldPool = 0;
    let shieldCap = 0;
    for (const m of ship.modules) {
      const cfg = this.configs.get<ModuleConfig>("module", m.moduleId);
      const cap = cfg?.mitigation?.absorbPerSecond;
      if (cap !== undefined) {
        shieldPool += m.shieldPool;
        shieldCap += cap;
      }
    }
    this.set(this.shield, shieldCap > 0 ? shieldPool / shieldCap : 0, Math.round(shieldPool), Number.NaN);

    this.set(
      this.energy,
      ship.energy.max > 0 ? ship.energy.cur / ship.energy.max : 0,
      Math.ceil(ship.energy.cur),
      ship.energy.max,
    );

    const heatFrac = ship.heat.capacity > 0 ? ship.heat.cur / ship.heat.capacity : 0;
    this.set(this.heat, heatFrac, Math.ceil(ship.heat.cur), ship.heat.capacity, heatFrac >= HEAT_WARN_FRACTION);
  }

  /**
   * Write a gauge. Every branch compares numbers first: the label string is
   * only built (and only touched in the DOM) on the frame its value actually
   * changes. `max` of NaN means "no denominator" — show the bare value.
   */
  private set(entry: GaugeEntry, frac: number, value: number, max: number, warn = false): void {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    if (pct !== entry.lastPct) {
      entry.fill.style.transform = `scaleX(${pct / 100})`;
      entry.lastPct = pct;
    }
    if (!Object.is(value, entry.lastValue) || !Object.is(max, entry.lastMax)) {
      entry.lastValue = value;
      entry.lastMax = max;
      entry.valueEl.textContent = Number.isNaN(max) ? `${value}` : `${value}/${max}`;
    }
    if (warn !== entry.lastWarn) {
      entry.fill.classList.toggle("warn", warn);
      entry.lastWarn = warn;
    }
  }

  dispose(): void {
    this.container.remove();
  }
}

function findShip(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}
