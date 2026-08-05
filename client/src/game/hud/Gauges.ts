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
  row: HTMLDivElement;
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
 * Hull fraction at or below which the bar flips to the critical tint. The
 * mirror image of {@link HEAT_WARN_FRACTION}: heat is dangerous when it climbs,
 * hull when it falls, and both end up wearing the same red.
 */
const HULL_WARN_FRACTION = 0.3;

/**
 * The ship heat pool is defined by the sim as the sum of fitted-module heat.
 * Rebuild it from the replicated rack values at the HUD seam instead of trusting
 * a second, denormalized wire field: rack heat is also what drives module
 * lockouts and overheat notifications, so those cues can never disagree with a
 * zero gauge if an aggregate snapshot is stale or absent.
 */
export function heatGaugeModel(ship: ShipSnapshot): {
  value: number;
  capacity: number;
  fraction: number;
  overheated: boolean;
} {
  let value = 0;
  let overheated = false;
  for (const module of ship.modules) {
    value += module.heat;
    if (module.state === "overheated") overheated = true;
  }
  const capacity = ship.heat.capacity;
  return {
    value,
    capacity,
    fraction: capacity > 0 ? value / capacity : 0,
    overheated,
  };
}

/**
 * Hull, shield-pool, energy and heat gauge bars (bottom-left, theme-positioned).
 * Shield-pool is the sum of active shield modules' `shieldPool` reservoirs
 * (there is no innate ship shield stat in MVP — shielding comes entirely from
 * fitted shield modules). Hull and heat both get a critical color as they
 * approach their bad end.
 *
 * The bar is drawn as segmented cells (`theme.hud.gauges.segments`) by a CSS
 * overlay rather than by N nodes: the fill itself stays a single continuously
 * scaled element, so a value change is still one `transform` write per frame.
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
    // `hud-frame` is the shared chamfered rim + translucent fill treatment
    // (see hudStyle.ts) — the gauges read as one instrument cluster rather than
    // four loose bars floating over the arena.
    this.container.className = "hud-gauges hud-frame";
    root.appendChild(this.container);

    this.hull = this.buildRow("HULL", "hull");
    this.shield = this.buildRow("SHIELD", "shield");
    this.energy = this.buildRow("ENERGY", "energy");
    this.heat = this.buildRow("HEAT", "heat");

    // Angular corner brackets on the cluster (opposite corners only, matching
    // the chamfer's own diagonal).
    for (const corner of ["tl", "br"]) {
      const bracket = document.createElement("span");
      bracket.className = "hud-bracket";
      bracket.dataset["corner"] = corner;
      bracket.setAttribute("aria-hidden", "true");
      this.container.appendChild(bracket);
    }
  }

  applyLayout(layout: HudLayout): void {
    this.container.dataset["anchor"] = layout.gauges.anchor;
    this.hull.row.hidden = !layout.gauges.showHull;
    this.shield.row.hidden = !layout.gauges.showShield;
  }

  private buildRow(labelText: string, cls: string): GaugeEntry {
    const row = document.createElement("div");
    row.className = "hud-gauge";
    row.dataset["gauge"] = cls;

    // Label and value share one baseline row above the bar, so the reading sits
    // where the eye already is instead of below the track.
    const head = document.createElement("div");
    head.className = "hud-gauge-head";
    const label = document.createElement("span");
    label.className = "hud-gauge-label";
    label.textContent = labelText;
    const valueEl = document.createElement("span");
    valueEl.className = "hud-gauge-value";
    head.append(label, valueEl);

    const track = document.createElement("div");
    track.className = "hud-gauge-track";
    const fill = document.createElement("div");
    fill.className = `hud-gauge-fill ${cls}`;
    fill.style.transform = "scaleX(1)";

    track.appendChild(fill);
    row.append(head, track);
    this.container.appendChild(row);

    return { row, fill, valueEl, lastPct: -1, lastValue: Number.NaN, lastMax: Number.NaN, lastWarn: false };
  }

  update(cur: Snapshot): void {
    // Indexed scan, not `Array.find` — this runs every render frame and the
    // predicate closure would be a fresh allocation each time.
    const ship = findShip(cur, this.playerId);
    if (!ship) return;

    const hullFrac = ship.hullMax > 0 ? ship.hull / ship.hullMax : 0;
    this.set(this.hull, hullFrac, Math.ceil(ship.hull), ship.hullMax, hullFrac <= HULL_WARN_FRACTION);

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

    const heat = heatGaugeModel(ship);
    this.set(
      this.heat,
      heat.fraction,
      Math.ceil(heat.value),
      heat.capacity,
      heat.overheated || heat.fraction >= HEAT_WARN_FRACTION,
    );
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
      // The row carries the state too: colour alone is the cue a player misses
      // mid-turn, so the readout also pulses (hudStyle.ts `.hud-gauge.critical`).
      entry.row.classList.toggle("critical", warn);
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
