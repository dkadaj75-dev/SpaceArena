import type { ConfigService, EntityId, EventBus, ConfigEvents, ModuleConfig, ModuleFamily, ModuleSnapshot, ShipSnapshot, Snapshot, ModuleState, ThemeConfig } from "@space-arena/shared";
import { abilityOf, createLogger, isInternalFamily } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { resolveHudLayout, type HudLayout } from "./hudLayout.js";
import { anchoredOffset, type FlightHudLayout } from "./flightHudLayout.js";
import { moduleIconId, moduleIconSvg } from "./moduleIcons.js";
import { resolveSlotCluster, slotNumberLabel, type SlotSide } from "./slotCluster.js";
import { DEFAULT_DESIGN_TOKENS } from "../themeTokens.js";

const log = createLogger("HudModuleButtons");
const THEME_ID = "theme.default";

export const MODULE_FAMILY_COLOR_FALLBACKS: Readonly<Record<ModuleFamily, string>> = {
  shield: DEFAULT_DESIGN_TOKENS.blue500,
  missile: DEFAULT_DESIGN_TOKENS.red500,
  laser: DEFAULT_DESIGN_TOKENS.red500,
  kinetic: DEFAULT_DESIGN_TOKENS.red500,
  utility: DEFAULT_DESIGN_TOKENS.white,
  // The two support families (2026-08-22) read as NOT-a-gun at a glance: the
  // slowing ray borrows the blue of the other things that act on a hull without
  // damaging it, the repair field takes green, the one hue nothing else on the
  // rail uses — a heal is the only button whose effect is good for you.
  disruptor: DEFAULT_DESIGN_TOKENS.blue500,
  repair: DEFAULT_DESIGN_TOKENS.green500,
  boost: DEFAULT_DESIGN_TOKENS.blue500,
  // Internals (2026-07-31). They get no HUD button, but the hangar colour-codes
  // slots from the same map, so every family needs an entry.
  engine: DEFAULT_DESIGN_TOKENS.blue500,
  generator: DEFAULT_DESIGN_TOKENS.blue500,
  // The alloy bay (2026-08-22) takes the white the transformer had: like the
  // sensor suite it is structure rather than a system that runs, and white is
  // what the hangar already reads as "part of the airframe".
  hull: DEFAULT_DESIGN_TOKENS.white,
  countermeasure: DEFAULT_DESIGN_TOKENS.blue500,
  sensors: DEFAULT_DESIGN_TOKENS.white,
};

export function resolveModuleFamilyColor(
  theme: ThemeConfig | undefined,
  family: ModuleFamily,
): string {
  return theme?.hud?.modules?.familyColors?.[family] ?? MODULE_FAMILY_COLOR_FALLBACKS[family];
}

/** Caption under a module hex: authored HUD name, or the display name capped at 12 characters. */
export function moduleHudName(cfg: Pick<ModuleConfig, "name" | "ui"> | undefined, fallback: string): string {
  return cfg?.ui.shortName ?? (cfg?.name ?? fallback).slice(0, 12);
}

/** Longest TYPE caption a slot button will print under its number. */
const SLOT_TYPE_MAX_CHARS = 7;

/**
 * The short TYPE word printed under a slot's number — PULSE, RAIL, SHIELD.
 *
 * Deliberately NOT {@link moduleHudName}: that is the full fitted name ("Laser
 * Mk1", "Deflector Sh"), which at slot-button size reads as a smear. What a
 * pilot needs from the caption is the KIND of thing on this hardpoint, so this
 * takes the first word of the authored short name and falls back to the family
 * whenever that word is too long to print honestly — a truncated "DEFLECT" says
 * less than "SHIELD" does.
 */
export function moduleSlotTypeLabel(
  cfg: Pick<ModuleConfig, "name" | "family" | "ui"> | undefined,
  fallback: string,
): string {
  const source = cfg?.ui?.shortName ?? cfg?.name ?? fallback;
  const first = source.trim().split(/\s+/)[0] ?? "";
  if (first !== "" && first.length <= SLOT_TYPE_MAX_CHARS) return first.toUpperCase();
  const family = cfg?.family;
  if (family) return family.toUpperCase().slice(0, SLOT_TYPE_MAX_CHARS);
  return first.toUpperCase().slice(0, SLOT_TYPE_MAX_CHARS);
}

/**
 * How many slots each side's cluster holds for a fitting, and where the two
 * dedicated left-hand actions sit inside the utility cluster.
 *
 * Exported because THREE widgets have to agree on it without talking to each
 * other: {@link ModuleButtons} builds the module buttons, while
 * {@link import("./BoostButton.js").BoostButton} and
 * {@link import("./JettisonButton.js").JettisonButton} are still their own
 * components (each carries state the rail cannot derive — the flag-carrier boost
 * block, the pod's own cooldown). They all resolve the same counts from the same
 * snapshot, so the left cluster is one cluster even though three objects draw it.
 */
export interface HudSlotCounts {
  /** Right cluster: every fitted weapon. */
  weapons: number;
  /** Left cluster: deployables that get their own module button. */
  utilityModules: number;
  /** BOOST's index inside the utility cluster, or null when none is fitted. */
  boostSlot: number | null;
  /** JETTISON's index inside the utility cluster, or null when nothing is jettisonable. */
  jettisonSlot: number | null;
  /** Total left-cluster slots — what the diameter ramp is fed. */
  utilities: number;
}

/**
 * Whether a fitted module deserves its own button in a cluster. Two exclusions,
 * both unchanged from the radial-cluster era:
 *
 *  - Internals (engine, generator, hull, countermeasure, sensors) are
 *    always-on systems with nothing to toggle, so they are shown in the Hangar
 *    and nowhere else. The one internal ACTION, launching a countermeasure pod,
 *    is the JETTISON slot.
 *  - `boost` has its own control, which can show what a generic button cannot:
 *    that a flag carrier has no afterburner. It occupies a utility slot, but
 *    {@link BoostButton} draws it.
 */
function isButtonableFamily(family: ModuleFamily | undefined): boolean {
  if (family === undefined) return true;
  return family !== "boost" && !isInternalFamily(family);
}

/** Resolve {@link HudSlotCounts} for one ship's fitting. Pure over the configs. */
export function resolveHudSlotCounts(
  configs: ConfigService,
  modules: readonly ModuleSnapshot[],
): HudSlotCounts {
  let weapons = 0;
  let utilityModules = 0;
  let hasBoost = false;
  let hasJettison = false;
  for (const m of modules) {
    const cfg = configs.get<ModuleConfig>("module", m.moduleId);
    if (cfg?.family === "boost") hasBoost = true;
    if (cfg?.jettison) hasJettison = true;
    if (!isButtonableFamily(cfg?.family)) continue;
    if (cfg?.fire !== undefined) weapons++;
    else utilityModules++;
  }
  // Order inside the left cluster: deployables first, then BOOST, then JETTISON
  // — the same running order the retired action arc used, so a pilot's muscle
  // memory for "boost is after my kit" survives the move to the left thumb.
  const boostSlot = hasBoost ? utilityModules : null;
  const jettisonSlot = hasJettison ? utilityModules + (hasBoost ? 1 : 0) : null;
  return {
    weapons,
    utilityModules,
    boostSlot,
    jettisonSlot,
    utilities: utilityModules + (hasBoost ? 1 : 0) + (hasJettison ? 1 : 0),
  };
}

interface ButtonEntry {
  hardpointIndex: number;
  /**
   * True for a module whose button is a TRIGGER rather than a toggle
   * (2026-08-21). Weapons: press fires, hold keeps firing as fast as the rack
   * allows. Everything else keeps the switch it always had.
   */
  isWeapon: boolean;
  side: SlotSide;
  /** Position inside its own cluster; the button prints `slotIndex + 1`. */
  slotIndex: number;
  root: HTMLDivElement;
  ring: HTMLSpanElement;
  icon: HTMLSpanElement;
  label: HTMLSpanElement;
  rounds: HTMLSpanElement;
  countdown: HTMLSpanElement;
  moduleId: string;
  cfg: ModuleConfig | undefined;
  /** Authored clip size, or 0 for a weapon with no magazine at all. */
  clipSize: number;
  // Last-rendered values so we only touch the DOM on change.
  lastState: ModuleState | null;
  lastRing: number;
  lastRingKind: "energy" | "reload" | "cooldown" | null;
  lastRounds: number;
  lastAmmoText: string;
  lastDry: boolean;
  lastLowAmmo: boolean;
  lastCountdownText: string;
  lastDanger: boolean;
  lastNoEnergy: boolean;
  lastArmed: boolean;
  lastCounting: boolean;
  lastUnarmable: boolean;
  lastUnpowered: boolean;
  /** Last replicated continuous-channel flag (see the class toggle in update()). */
  lastChanneling: boolean;
}

/**
 * The two HARDPOINT SLOT CLUSTERS (owner HUD pass, 2026-08-21).
 *
 * ## Before
 *
 * One radial rail in the bottom-right corner carried every fitted module,
 * weapons and deployables interleaved by hardpoint order, with the pilot's first
 * weapon inflated onto the retired FIRE button's pedestal and BOOST/JETTISON
 * queued behind everything on the same arc. The rail grew, shrank and split as
 * the fitting changed, so the HUD changed shape between hulls and no button had
 * a fixed home.
 *
 * ## After
 *
 * Two clusters, one per thumb, both packed into their bottom corner:
 *
 *  - **right — every weapon hardpoint**, in hardpoint order;
 *  - **left — every utilitarian skill**: deployables, then BOOST, then JETTISON.
 *
 * Inside a cluster every button is the SAME circle, sized by that side's mount
 * count ({@link import("./slotCluster.js").slotSizePx}) and placed in staggered
 * rows with slot 01 nearest the corner. Each button prints its slot number, its
 * glyph and a short TYPE caption — the glyph is the thing a pilot reads mid-turn
 * and the number is what a callout names.
 *
 * BOOST and JETTISON keep their own components (each carries state this rail
 * cannot derive) but take their slot from the same
 * {@link resolveHudSlotCounts} and wear the same `hud-slot-btn` skin, so the
 * left cluster is visually one cluster.
 *
 * Keyed by `hardpointIndex` throughout, never array position: the snapshot's
 * `modules` array is sparse-safe (see `shared/src/sim/spawn.ts`) — a fitting
 * like `{0: laser, 2: shield}` replicates two entries whose own
 * `hardpointIndex` fields are 0 and 2, not array positions 0 and 1.
 */
export class ModuleButtons {
  private readonly container: HTMLDivElement;
  /** Zero-size pivots, one pinned in each bottom corner. */
  private readonly clusters: Readonly<Record<SlotSide, HTMLDivElement>>;
  private entries = new Map<number, ButtonEntry>();
  /** Build order: the weapon cluster's slots, then the utility cluster's. */
  private ordered: ButtonEntry[] = [];
  private builtForModuleCount = -1;
  /** Left-cluster slots taken by BOOST/JETTISON, which this component does not draw. */
  private utilityExtras = 0;
  private layout: HudLayout;
  /**
   * Held weapon triggers: hardpoint index → the POINTER holding it.
   *
   * Keyed by pointer, not merely flagged, because the document-level backstop
   * below sees every pointer on the screen. A pilot steers with one thumb and
   * fires with the other, so a release that did not check WHICH pointer came up
   * dropped the trigger every time the steering finger lifted — which is most
   * of a dogfight (fixed 2026-08-21).
   *
   * Read by {@link ModuleButtons.triggerMask}, which is what the flight order
   * carries; this component never sends an order of its own for a weapon,
   * because a held trigger must not cost one order per frame.
   */
  private readonly heldTriggers = new Map<number, number>();
  /** Per-button release callbacks, keyed by pointer id; `null` releases any pointer. */
  private releasers: Array<(pointerId: number | null) => void> = [];
  private disabled = false;
  /** Backstop for a pointer released outside its button: only THAT pointer's trigger. */
  private readonly releasePointer = (ev: PointerEvent): void => {
    for (const release of this.releasers) release(ev.pointerId);
  };
  /** Blur, disable, rebuild: nothing is holding anything any more. */
  private readonly releaseAllTriggers = (): void => {
    for (const release of this.releasers) release(null);
  };
  private readonly unsubscribeTheme: () => void;

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-modules";
    this.clusters = {
      weapons: this.buildCluster("weapons"),
      utilities: this.buildCluster("utilities"),
    };
    root.appendChild(this.container);
    // Standalone default until the Hud pushes the resolved layout in.
    this.layout = resolveHudLayout(undefined, { width: 0, height: 0 });
    this.applyLayout(this.layout);
    const maybeBus = bus as EventBus<ConfigEvents> & {
      on?: EventBus<ConfigEvents>["on"];
    };
    this.unsubscribeTheme =
      typeof maybeBus.on === "function"
        ? maybeBus.on("config:changed", (evt) => {
            if (evt.type === "theme") this.applyFamilyColors();
          })
        : () => {};
    // The backstop for a level-triggered control: a pointer released outside the
    // button, a cancelled gesture or a lost window must never leave a weapon
    // firing. Cheap, and the alternative is a gun that will not stop.
    document.addEventListener("pointerup", this.releasePointer);
    document.addEventListener("pointercancel", this.releasePointer);
    window.addEventListener("blur", this.releaseAllTriggers);
  }

  private buildCluster(side: SlotSide): HTMLDivElement {
    const pivot = document.createElement("div");
    pivot.className = "hud-slot-cluster";
    pivot.dataset["side"] = side;
    this.container.appendChild(pivot);
    return pivot;
  }

  /**
   * Bitmask of the weapon hardpoints whose button is held, for the flight
   * order's `triggers` field. Read every frame by {@link FlightControls}: the
   * mask rides the order the HUD already sends, so holding a trigger costs no
   * extra orders and cannot be rate-limited away.
   */
  triggerMask(): number {
    let mask = 0;
    for (const index of this.heldTriggers.keys()) mask |= 1 << index;
    return mask;
  }

  /** True while any weapon trigger is held — the "am I shooting" question. */
  get anyTriggerHeld(): boolean {
    return this.heldTriggers.size > 0;
  }

  /**
   * Gate every control (respawn hold, results screen). Disabling RELEASES held
   * triggers rather than freezing them: a pilot who dies mid-burst must not
   * respawn with a gun already firing.
   */
  setEnabled(enabled: boolean): void {
    this.disabled = !enabled;
    this.container.classList.toggle("disabled", !enabled);
    if (!enabled) this.releaseAllTriggers();
  }

  /**
   * Adopt a freshly resolved layout (theme hot-reload, rotation, resize). Only
   * `scale` and `viewport` matter to the clusters: their geometry is a function
   * of the mount count, not of an authored arc.
   */
  applyLayout(layout: HudLayout): void {
    this.layout = layout;
    for (const side of ["weapons", "utilities"] as const) {
      this.clusters[side].dataset["anchor"] = resolveSlotCluster(0, side).anchor;
    }
    this.position();
  }

  /**
   * Kept for the Hud's call order. The clusters are viewport-and-count driven,
   * so the flight layout contributes nothing they do not already have — but a
   * theme's `hud.scale` reaches them through {@link applyLayout}.
   */
  applyFlightLayout(_layout: FlightHudLayout): void {
    this.position();
  }

  /** Writes each button's pivot-relative box into its inline left/top/size. */
  private position(): void {
    const opts = { viewport: this.layout.viewport, scale: this.layout.scale };
    const weapons = resolveSlotCluster(
      this.ordered.reduce((n, e) => (e.side === "weapons" ? n + 1 : n), 0),
      "weapons",
      opts,
    );
    const utilities = resolveSlotCluster(
      this.ordered.reduce((n, e) => (e.side === "utilities" ? n + 1 : n), 0) + this.utilityExtras,
      "utilities",
      opts,
    );
    for (const entry of this.ordered) {
      const cluster = entry.side === "weapons" ? weapons : utilities;
      const slot = cluster.slots[entry.slotIndex];
      if (!slot) continue;
      const half = slot.sizePx / 2;
      const { dx, dy } = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, half);
      const btn = entry.root;
      btn.style.left = `${dx - half}px`;
      btn.style.top = `${dy - half}px`;
      btn.style.width = `${slot.sizePx}px`;
      btn.style.height = `${slot.sizePx}px`;
      // Every glyph, number and caption inside the circle is sized off this, so
      // a 44 px slot is a smaller version of an 82 px one rather than the same
      // typography crammed into a smaller ring.
      btn.style.setProperty("--hud-slot-size", `${slot.sizePx}px`);
    }
  }

  update(cur: Snapshot): void {
    // Indexed scan, not `Array.find` — per-frame hot path, no closure.
    const ship = findShipSnapshot(cur, this.playerId);
    if (!ship) return;

    // Module count only changes on a fresh spawn (fitting is fixed for the
    // match), so this cheap length check is enough to detect a rebuild is
    // needed — the per-module work below stays keyed by hardpointIndex.
    const counts = resolveHudSlotCounts(this.configs, ship.modules);
    const buttonable = counts.weapons + counts.utilityModules;
    if (buttonable !== this.builtForModuleCount || counts.utilities - counts.utilityModules !== this.utilityExtras) {
      this.rebuild(ship.modules, counts);
    }

    for (const m of ship.modules) {
      const entry = this.entries.get(m.hardpointIndex);
      if (!entry) continue;

      const reloading = m.state === "reloading" && entry.cfg?.fire?.clip !== undefined;
      // A COLLAPSED shield is serving `mitigation.collapseCooldownSec` on its own
      // cycleTimer (ModuleSystem). While that runs it outranks the energy ring:
      // the tank refilling tells the pilot nothing about the only thing keeping
      // the bubble down, and the button would otherwise look ready and do nothing.
      const collapsed = entry.cfg?.mitigation !== undefined && m.cycleTimer > 0;
      // A SUPPORT PULSE between shots (2026-08-22). Same reading as the two
      // above — "this module is cold" — banked on the same `cycleTimer`, so it
      // joins them rather than getting a fourth kind of ring.
      const pulse = abilityOf(entry.cfg);
      const pulseCooling = pulse !== undefined && m.cycleTimer > 0;
      // A weapon between shots. With heat deleted (2026-08-20) the cycle timer
      // is a weapon's ONLY limiter, so its ring is the whole of what the pilot
      // has to read — it outranks the energy ring on the rare weapon with a tank.
      const onCycle = entry.cfg?.fire !== undefined && m.cycleTimer > 0;
      // Seconds the current countdown started from, so the sweep is a true
      // fraction rather than a bar that jumps when the module changes job.
      const cooldownTotal = collapsed
        ? entry.cfg!.mitigation!.collapseCooldownSec
        : pulseCooling
        ? pulse!.cooldownSec
        : (entry.cfg?.fire?.cycleTime ?? 0);
      const ringKind = reloading
        ? "reload"
        : collapsed || onCycle || pulseCooling
        ? "cooldown"
        : m.energyCapacity > 0
          ? "energy"
          : null;
      const ringPct = ringKind === "reload"
        ? resourcePct(entry.cfg!.fire!.clip!.reloadSec - m.stateTimer, entry.cfg!.fire!.clip!.reloadSec)
        : ringKind === "cooldown"
        // Fills as the countdown burns off, matching the reload sweep beside it:
        // on this rail a filling arc always means "ready when full".
        ? resourcePct(cooldownTotal - m.cycleTimer, cooldownTotal)
        : ringKind === "energy"
          ? resourcePct(m.energy, m.energyCapacity)
          : 0;
      // Seconds still to run on whichever countdown owns the ring. The mockup's
      // "cooling" state is a pie plus a number, and the number is the half a
      // pilot can act on: an arc says "not yet", a 2 says "in two".
      const remainingSec = reloading
        ? Math.max(0, entry.cfg!.fire!.clip!.reloadSec - m.stateTimer)
        : ringKind === "cooldown"
          ? Math.max(0, m.cycleTimer)
          : 0;
      // The one red-ring case left: a tank nearly out. Heat used to own this.
      const danger = ringKind === "energy" && ringPct <= 15;

      const noEnergy = ringKind === "energy" && m.energy <= 0;
      const armed = m.state === "active" && entry.cfg?.fire !== undefined;
      // `counting` is the rail's generic "this module is counting down" state. It
      // covers a weapon between shots and, since the collapse rule, a shield
      // locked out after its bubble went down.
      const counting =
        (m.state === "active" && entry.cfg?.fire !== undefined && m.cycleTimer > 0) || collapsed || pulseCooling;
      // Only homing weapons still hard-require a lock; straight-fire weapons
      // (laser/kinetic/beam) shoot down the nose without one and never grey out.
      const unarmable =
        m.state === "active" && entry.cfg?.fire?.projectile?.turnRate !== undefined && !ship.locked;
      // A weapon the POWER RAIL could not seat at spawn. Weapons have no toggle
      // since 2026-08-21, so this one is cold for the whole match — the button
      // has to say so rather than sit there looking merely idle.
      const unpowered = entry.isWeapon && m.state === "retracted";

      if (m.state !== entry.lastState) {
        if (entry.lastState) entry.root.classList.remove(`state-${entry.lastState}`);
        entry.root.classList.add(`state-${m.state}`);
        entry.lastState = m.state;
      }
      if (ringPct !== entry.lastRing) {
        entry.root.style.setProperty("--ring", String(ringPct));
        entry.lastRing = ringPct;
      }
      if (ringKind !== entry.lastRingKind) {
        entry.ring.hidden = ringKind === null;
        entry.root.classList.toggle("ring-energy", ringKind === "energy");
        entry.root.classList.toggle("ring-reload", ringKind === "reload");
        entry.root.classList.toggle("ring-cooldown", ringKind === "cooldown");
        entry.lastRingKind = ringKind;
      }
      const countdownText = remainingSec > 0 ? formatRemainingSec(remainingSec) : "";
      if (countdownText !== entry.lastCountdownText) {
        entry.countdown.textContent = countdownText;
        entry.countdown.hidden = countdownText === "";
        entry.lastCountdownText = countdownText;
      }
      const rounds = m.rounds ?? 0;
      // AMMO (mockup's low-ammo / DRY states). Only a magazine-fed weapon has
      // any of this: a laser has no rounds to be low on, so it gets no counter
      // rather than an invented one.
      const dry = entry.clipSize > 0 && rounds <= 0;
      const lowAmmo = entry.clipSize > 0 && rounds > 0 && rounds <= lowAmmoThreshold(entry.clipSize);
      const ammoText = entry.clipSize > 0 ? (dry ? "DRY" : String(rounds)) : "";
      if (rounds !== entry.lastRounds || ammoText !== entry.lastAmmoText) {
        entry.rounds.textContent = ammoText;
        entry.lastRounds = rounds;
        entry.lastAmmoText = ammoText;
      }
      if (dry !== entry.lastDry) {
        entry.root.classList.toggle("dry", dry);
        entry.lastDry = dry;
      }
      if (lowAmmo !== entry.lastLowAmmo) {
        entry.root.classList.toggle("low-ammo", lowAmmo);
        entry.lastLowAmmo = lowAmmo;
      }
      if (danger !== entry.lastDanger) {
        entry.root.classList.toggle("ring-danger", danger);
        entry.lastDanger = danger;
      }
      if (noEnergy !== entry.lastNoEnergy) {
        entry.root.classList.toggle("no-energy", noEnergy);
        entry.lastNoEnergy = noEnergy;
      }
      if (armed !== entry.lastArmed) {
        entry.root.classList.toggle("armed", armed);
        entry.lastArmed = armed;
      }
      if (counting !== entry.lastCounting) {
        entry.root.classList.toggle("on-cooldown", counting);
        entry.lastCounting = counting;
      }
      if (unarmable !== entry.lastUnarmable) {
        entry.root.classList.toggle("unarmable", unarmable);
        entry.lastUnarmable = unarmable;
      }
      if (unpowered !== entry.lastUnpowered) {
        entry.root.classList.toggle("unpowered", unpowered);
        entry.root.title = unpowered ? "No rail power for this weapon" : "";
        entry.lastUnpowered = unpowered;
      }
      // Continuous weapons get `channeling` instead of a countdown ring: the
      // ring encodes a cadence a channel does not have. Exposed unstyled — the
      // shipped theme currently renders it the same as any armed button.
      if (m.channeling !== entry.lastChanneling) {
        entry.root.classList.toggle("channeling", m.channeling);
        entry.lastChanneling = m.channeling;
      }
    }
  }

  private rebuild(modules: readonly ModuleSnapshot[], counts: HudSlotCounts): void {
    // Old buttons are about to be discarded; drop anything they were holding, or
    // a respawn with a different fitting could leave a phantom bit set.
    this.releaseAllTriggers();
    this.releasers = [];
    this.clusters.weapons.innerHTML = "";
    this.clusters.utilities.innerHTML = "";
    this.ordered = [];
    this.utilityExtras = counts.utilities - counts.utilityModules;
    const perSide: Record<SlotSide, number> = { weapons: 0, utilities: 0 };

    this.entries = new Map(
      [...modules]
        .filter((m) => isButtonableFamily(this.configs.get<ModuleConfig>("module", m.moduleId)?.family))
        // Weapons first so the DOM order matches the way the clusters read
        // (right cluster, then left); equal kinds stay in hardpoint order so a
        // fitting never shuffles mid-match.
        .sort((a, b) => {
          const aWeapon = this.configs.get<ModuleConfig>("module", a.moduleId)?.fire ? 0 : 1;
          const bWeapon = this.configs.get<ModuleConfig>("module", b.moduleId)?.fire ? 0 : 1;
          return aWeapon - bWeapon || a.hardpointIndex - b.hardpointIndex;
        })
        .map((m) => {
        const hardpointIndex = m.hardpointIndex;
        const moduleId = m.moduleId;
        const cfg = this.configs.get<ModuleConfig>("module", moduleId);
        if (!cfg) log.warn(`unknown module config ${moduleId}`);
        const isWeapon = cfg?.fire !== undefined;
        const side: SlotSide = isWeapon ? "weapons" : "utilities";
        const slotIndex = perSide[side]++;

        const btn = document.createElement("div");
        btn.className = "hud-module-btn hud-slot-btn hex-action";
        btn.setAttribute(HUD_CONTROL_ATTR, "module");
        btn.setAttribute("role", "button");
        btn.dataset["side"] = side;
        btn.dataset["slot"] = slotNumberLabel(slotIndex + 1);
        btn.setAttribute("aria-label", `${slotNumberLabel(slotIndex + 1)} ${cfg?.name ?? moduleId}`);
        btn.style.setProperty("--ring", "0");
        if (cfg) {
          btn.classList.add(`family-${cfg.family}`);
          btn.style.setProperty(
            "--hud-module-family-color",
            resolveModuleFamilyColor(this.configs.get<ThemeConfig>("theme", THEME_ID), cfg.family),
          );
        }

        // Deploy/retract/cooldown arc. Its own node because the button's two
        // pseudo-elements are spent on the chamfered rim + fill plates.
        const ring = document.createElement("span");
        ring.className = "ring";
        ring.hidden = true;
        ring.setAttribute("aria-hidden", "true");

        // The slot NUMBER, which is what a callout names ("dry on 02") and what
        // the mockup leads with. Decorative for assistive tech: it is already in
        // the button's own aria-label.
        const number = document.createElement("span");
        number.className = "slot-num";
        number.textContent = slotNumberLabel(slotIndex + 1);
        number.setAttribute("aria-hidden", "true");

        const icon = document.createElement("span");
        icon.className = "icon";
        // Real glyph, not the authored `[ICON: …]` placeholder text: the id is
        // resolved from ui.iconId → ui.icon's tag → family (see moduleIcons.ts).
        icon.innerHTML = moduleIconSvg(moduleIconId(cfg));
        // Short TYPE word under the number — PULSE, RAIL, SHIELD. The glyph
        // carries the meaning; this disambiguates two of the same family.
        const type = document.createElement("span");
        type.className = "slot-type";
        type.textContent = moduleSlotTypeLabel(cfg, moduleId);
        type.setAttribute("aria-hidden", "true");
        // The full fitted name stays SCREEN-READER ONLY (2026-08-21): a
        // thumb-sized button showing a glyph and a truncated name showed
        // neither well. The text stays in the DOM so the control is named.
        const label = document.createElement("span");
        label.className = "label sr-only";
        label.textContent = moduleHudName(cfg, moduleId);
        const clipSize = cfg?.fire?.clip?.size ?? 0;
        const rounds = document.createElement("span");
        rounds.className = "rounds";
        rounds.hidden = clipSize === 0;
        rounds.setAttribute("aria-label", "Rounds remaining");
        // Seconds left on whichever countdown the ring is drawing.
        const countdown = document.createElement("span");
        countdown.className = "cooldown-secs";
        countdown.hidden = true;
        countdown.setAttribute("aria-hidden", "true");

        btn.append(ring, number, icon, type, rounds, countdown, label);

        if (isWeapon) {
          // TRIGGER, not a toggle (2026-08-21). Press fires; hold keeps the bit
          // set so the rack fires again the instant its cooldown clears. The bit
          // rides the flight order the HUD already sends every frame, so holding
          // costs nothing — see `triggerMask`.
          btn.classList.add("trigger");
          const press = (ev: PointerEvent): void => {
            if (this.disabled) return;
            this.heldTriggers.set(hardpointIndex, ev.pointerId);
            btn.classList.add("firing");
            // Capture is an optimisation; the document-level release listeners
            // installed in the constructor are what guarantee a held trigger
            // cannot stick down if the UA drops the capture.
            try { btn.setPointerCapture?.(ev.pointerId); } catch { /* release fallback armed */ }
            ev.preventDefault();
          };
          /**
           * `pointerId === null` means "release regardless" (blur, disable,
           * rebuild). Anything else releases ONLY the pointer that is holding
           * this button — the other thumb steering the ship must not silence it.
           */
          const release = (pointerId: number | null): void => {
            const held = this.heldTriggers.get(hardpointIndex);
            if (held === undefined) return;
            if (pointerId !== null && pointerId !== held) return;
            this.heldTriggers.delete(hardpointIndex);
            btn.classList.remove("firing");
          };
          btn.addEventListener("pointerdown", press);
          btn.addEventListener("pointerup", (ev) => release(ev.pointerId));
          btn.addEventListener("pointercancel", (ev) => release(ev.pointerId));
          btn.addEventListener("lostpointercapture", (ev) => release(ev.pointerId));
          this.releasers.push(release);
        } else {
          btn.addEventListener("click", () => {
            // The same gate the weapon triggers honour. A utility button used to
            // send its order regardless, so a dead pilot on the respawn hold
            // could still toggle a shield on a ship that no longer existed.
            if (this.disabled) return;
            this.session.order({ kind: "moduleToggle", hardpointIndex });
            log.debug(`moduleToggle → hardpoint ${hardpointIndex} (${moduleId})`);
          });
        }

        this.clusters[side].appendChild(btn);
        const entry: ButtonEntry = {
          hardpointIndex,
          isWeapon,
          side,
          slotIndex,
          root: btn,
          ring,
          icon,
          label,
          rounds,
          countdown,
          moduleId,
          cfg,
          clipSize,
          lastState: null,
          lastRing: -1,
          lastRingKind: null,
          lastRounds: -1,
          lastAmmoText: "",
          lastDry: false,
          lastLowAmmo: false,
          lastCountdownText: "",
          lastDanger: false,
          lastNoEnergy: false,
          lastArmed: false,
          lastCounting: false,
          lastUnarmable: false,
          lastUnpowered: false,
          lastChanneling: false,
        };
        this.ordered.push(entry);
        return [hardpointIndex, entry] as const;
      }),
    );
    this.builtForModuleCount = this.entries.size;
    this.position();
  }

  private applyFamilyColors(): void {
    const theme = this.configs.get<ThemeConfig>("theme", THEME_ID);
    for (const entry of this.entries.values()) {
      if (!entry.cfg) continue;
      entry.root.style.setProperty(
        "--hud-module-family-color",
        resolveModuleFamilyColor(theme, entry.cfg.family),
      );
    }
  }

  dispose(): void {
    this.unsubscribeTheme();
    document.removeEventListener("pointerup", this.releasePointer);
    document.removeEventListener("pointercancel", this.releasePointer);
    window.removeEventListener("blur", this.releaseAllTriggers);
    this.container.remove();
  }
}

/**
 * "Low" is a quarter of the magazine, floor 1 round: on a 24-round autocannon
 * that is the last 6, and on a 4-round rack it is the last one. A fixed count
 * would either scream on the cannon or never fire on the rack.
 */
export function lowAmmoThreshold(clipSize: number): number {
  return Math.max(1, Math.ceil(clipSize * 0.25));
}

/**
 * Seconds left, printed the way a pilot reads them: whole seconds while there is
 * more than one, tenths in the last second, where the difference between "0.9"
 * and "0.1" is the difference between waiting and pulling.
 */
export function formatRemainingSec(seconds: number): string {
  return seconds >= 1 ? String(Math.ceil(seconds)) : seconds.toFixed(1);
}

function resourcePct(value: number, capacity: number): number {
  return capacity > 0 ? Math.max(0, Math.min(100, Math.round((100 * value) / capacity))) : 0;
}

function findShipSnapshot(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}
