import type { ConfigService, EntityId, EventBus, ConfigEvents, ModuleConfig, ModuleFamily, ModuleSnapshot, ShipSnapshot, Snapshot, ModuleState, ThemeConfig } from "@space-arena/shared";
import { createLogger, isInternalFamily } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { clusterOffsets, resolveHudLayout, type HudLayout } from "./hudLayout.js";
import { anchoredOffset, resolveFlightSecondaryControls, type FlightHudLayout } from "./flightHudLayout.js";
import { moduleIconId, moduleIconSvg } from "./moduleIcons.js";
import { DEFAULT_DESIGN_TOKENS } from "../themeTokens.js";

const log = createLogger("HudModuleButtons");
const THEME_ID = "theme.default";

export const MODULE_FAMILY_COLOR_FALLBACKS: Readonly<Record<ModuleFamily, string>> = {
  shield: DEFAULT_DESIGN_TOKENS.blue500,
  missile: DEFAULT_DESIGN_TOKENS.red500,
  laser: DEFAULT_DESIGN_TOKENS.red500,
  kinetic: DEFAULT_DESIGN_TOKENS.red500,
  utility: DEFAULT_DESIGN_TOKENS.white,
  boost: DEFAULT_DESIGN_TOKENS.blue500,
  // Internals (2026-07-31). They get no HUD button, but the hangar colour-codes
  // slots from the same map, so every family needs an entry.
  engine: DEFAULT_DESIGN_TOKENS.blue500,
  generator: DEFAULT_DESIGN_TOKENS.blue500,
  transformer: DEFAULT_DESIGN_TOKENS.white,
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

interface ButtonEntry {
  hardpointIndex: number;
  /**
   * True for a module whose button is a TRIGGER rather than a toggle
   * (2026-08-21). Weapons: press fires, hold keeps firing as fast as the rack
   * allows. Everything else keeps the switch it always had.
   */
  isWeapon: boolean;
  root: HTMLDivElement;
  ring: HTMLSpanElement;
  icon: HTMLSpanElement;
  label: HTMLSpanElement;
  rounds: HTMLSpanElement;
  moduleId: string;
  cfg: ModuleConfig | undefined;
  // Last-rendered values so we only touch the DOM on change.
  lastState: ModuleState | null;
  lastRing: number;
  lastRingKind: "energy" | "reload" | "cooldown" | null;
  lastRounds: number;
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
 * One chamfered hex button per fitted module, auto-generated from the player's
 * fitting (bottom-right radial cluster, §2.3). Tap toggles activate/deactivate
 * via `moduleToggle` orders; visuals reflect the module's runtime state each
 * frame but only write to the DOM when something actually changed.
 *
 * The glyph is an inline SVG from {@link import("./moduleIcons.js")}, resolved
 * from the module's own config — buttons used to render `ui.icon` as literal
 * text, which put "[ICON: laser]" on screen in every live match.
 *
 * Keyed by `hardpointIndex` throughout, never array position: the snapshot's
 * `modules` array is sparse-safe (see `shared/src/sim/spawn.ts`) — a fitting
 * like `{0: laser, 2: shield}` replicates two entries whose own
 * `hardpointIndex` fields are 0 and 2, not array positions 0 and 1.
 *
 * Geometry (5.4) is 100 % theme-driven: the container is a zero-size pivot
 * pinned to the corner named by `theme.hud.moduleCluster.anchor` (inside the
 * safe-area inset) and each button is placed at an offset computed by
 * {@link clusterOffsets} — arc or wrap, portrait or landscape block, with the
 * one-thumb clamp applied. Nothing about the cluster is hardcoded in CSS.
 */
export class ModuleButtons {
  private readonly container: HTMLDivElement;
  private entries = new Map<number, ButtonEntry>();
  private builtForModuleCount = -1;
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
  private flightLayout: FlightHudLayout | null = null;
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

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: HudLayout): void {
    this.layout = layout;
    this.container.dataset["anchor"] = layout.cluster.anchor;
    this.container.dataset["layout"] = layout.cluster.layout;
    this.position();
  }

  /** Adopt the shared FIRE-centred rail when the theme authors one. */
  applyFlightLayout(layout: FlightHudLayout): void {
    this.flightLayout = layout;
    this.container.dataset["anchor"] = layout.actionArc ? layout.fire.anchor : this.layout.cluster.anchor;
    this.position();
  }

  /** Writes each button's pivot-relative centre into its inline left/top. */
  private position(): void {
    const buttons = [...this.entries.values()];
    const secondary = this.flightLayout
      ? resolveFlightSecondaryControls(this.flightLayout, buttons.length, {
          // The rail is sorted weapon-first, so button 0 is the pilot's primary
          // gun — and since 2026-08-21 it takes the FIRE button's footprint.
          primaryOnFireSlot: buttons[0]?.isWeapon === true,
        })
      : null;
    if (secondary?.usesActionArc) {
      for (let i = 0; i < buttons.length; i++) {
        const slot = secondary.modules[i];
        if (!slot) continue;
        const button = buttons[i]!.root;
        button.classList.toggle("primary", i === 0 && buttons[i]!.isWeapon);
        button.style.left = `${anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.radiusPx).dx - slot.radiusPx}px`;
        button.style.top = `${anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.radiusPx).dy - slot.radiusPx}px`;
        button.style.width = `${slot.radiusPx * 2}px`;
        button.style.height = `${slot.radiusPx * 2}px`;
        this.positionCaption(button, slot.captionX, slot.captionY, slot.radiusPx, slot.captionGapPx);
      }
      return;
    }
    const offsets = clusterOffsets(buttons.length, this.layout);
    const r = this.layout.cluster.buttonRadiusPx;
    for (let i = 0; i < buttons.length; i++) {
      const offset = offsets[i];
      if (!offset) continue;
      // No arc, so no pedestal: a theme swapped from an arc layout to a cluster
      // one must not leave a button dressed as one.
      buttons[i]!.root.classList.remove("primary");
      buttons[i]!.root.style.left = `${offset.dx - r}px`;
      buttons[i]!.root.style.top = `${offset.dy - r}px`;
      buttons[i]!.root.style.removeProperty("width");
      buttons[i]!.root.style.removeProperty("height");
      this.resetCaption(buttons[i]!.root);
    }
  }

  private positionCaption(button: HTMLDivElement, x: number, y: number, radius: number, gap: number): void {
    const label = button.querySelector<HTMLElement>(".label");
    if (!label) return;
    label.style.left = `${50 + ((radius + gap) * x * 100) / (radius * 2)}%`;
    label.style.top = `${50 + ((radius + gap) * y * 100) / (radius * 2)}%`;
    label.style.transform = "translate(-50%, -50%)";
  }

  private resetCaption(button: HTMLDivElement): void {
    const label = button.querySelector<HTMLElement>(".label");
    if (!label) return;
    label.style.removeProperty("left");
    label.style.removeProperty("top");
    label.style.removeProperty("transform");
  }

  /**
   * Whether a fitted module deserves a button in THIS cluster. Two exclusions:
   *
   *  - Internals (engine, generator, transformer, countermeasure, sensors —
   *    2026-07-31) are always-on systems with nothing to toggle, so they are
   *    shown in the Hangar and nowhere else. The one internal ACTION,
   *    launching a countermeasure pod, has its own control.
   *  - `boost` has its own control too: {@link import("./BoostButton.js").BoostButton},
   *    in the flight HUD. As a generic hex it was one more anonymous glyph in
   *    this arc, with no way to show that a flag carrier cannot boost — which is
   *    exactly why a tester reported the boost system as absent from the UI. It
   *    still toggles through the same `moduleToggle` order; only the button moved.
   */
  private isButtonable(moduleId: string): boolean {
    const family = this.configs.get<ModuleConfig>("module", moduleId)?.family;
    if (family === undefined) return true;
    return family !== "boost" && !isInternalFamily(family);
  }

  update(cur: Snapshot): void {
    // Indexed scan, not `Array.find` — per-frame hot path, no closure.
    const ship = findShipSnapshot(cur, this.playerId);
    if (!ship) return;

    // Module count only changes on a fresh spawn (fitting is fixed for the
    // match), so this cheap length check is enough to detect a rebuild is
    // needed — the per-module work below stays keyed by hardpointIndex.
    const buttonable = ship.modules.reduce((n, m) => (this.isButtonable(m.moduleId) ? n + 1 : n), 0);
    if (buttonable !== this.builtForModuleCount) {
      this.rebuild(ship.modules);
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
      // A weapon between shots. With heat deleted (2026-08-20) the cycle timer
      // is a weapon's ONLY limiter, so its ring is the whole of what the pilot
      // has to read — it outranks the energy ring on the rare weapon with a tank.
      const onCycle = entry.cfg?.fire !== undefined && m.cycleTimer > 0;
      // Seconds the current countdown started from, so the sweep is a true
      // fraction rather than a bar that jumps when the module changes job.
      const cooldownTotal = collapsed
        ? entry.cfg!.mitigation!.collapseCooldownSec
        : (entry.cfg?.fire?.cycleTime ?? 0);
      const ringKind = reloading
        ? "reload"
        : collapsed || onCycle
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
      // The one red-ring case left: a tank nearly out. Heat used to own this.
      const danger = ringKind === "energy" && ringPct <= 15;

      const noEnergy = ringKind === "energy" && m.energy <= 0;
      const armed = m.state === "active" && entry.cfg?.fire !== undefined;
      // `counting` is the rail's generic "this module is counting down" state. It
      // covers a weapon between shots and, since the collapse rule, a shield
      // locked out after its bubble went down.
      const counting = (m.state === "active" && entry.cfg?.fire !== undefined && m.cycleTimer > 0) || collapsed;
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
      const rounds = m.rounds ?? 0;
      if (rounds !== entry.lastRounds) {
        entry.rounds.textContent = String(rounds);
        entry.lastRounds = rounds;
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

  private rebuild(modules: readonly ModuleSnapshot[]): void {
    // Old buttons are about to be discarded; drop anything they were holding, or
    // a respawn with a different fitting could leave a phantom bit set.
    this.releaseAllTriggers();
    this.releasers = [];
    this.container.innerHTML = "";
    this.entries = new Map(
      [...modules]
        .filter((m) => this.isButtonable(m.moduleId))
        // The rail's stable thumb order is weapon first, then utility. Keep
        // equal kinds in hardpoint order so a fitting never shuffles mid-match.
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

        const btn = document.createElement("div");
        btn.className = "hud-module-btn hex-action";
        btn.setAttribute(HUD_CONTROL_ATTR, "module");
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", cfg?.name ?? moduleId);
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

        const icon = document.createElement("span");
        icon.className = "icon";
        // Real glyph, not the authored `[ICON: …]` placeholder text: the id is
        // resolved from ui.iconId → ui.icon's tag → family (see moduleIcons.ts).
        icon.innerHTML = moduleIconSvg(moduleIconId(cfg));
        // The caption is SCREEN-READER ONLY since 2026-08-21. A thumb-sized
        // button showing both a glyph and a truncated name showed neither well,
        // and the glyph is the thing a pilot reads mid-turn. The text stays in
        // the DOM (and in `aria-label`) so the control is still named.
        const label = document.createElement("span");
        label.className = "label sr-only";
        label.textContent = moduleHudName(cfg, moduleId);
        const rounds = document.createElement("span");
        rounds.className = "rounds";
        rounds.hidden = cfg?.fire?.clip === undefined;
        rounds.setAttribute("aria-label", "Rounds remaining");

        btn.append(ring, icon, rounds, label);

        const isWeapon = cfg?.fire !== undefined;
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
            this.session.order({ kind: "moduleToggle", hardpointIndex });
            log.debug(`moduleToggle → hardpoint ${hardpointIndex} (${moduleId})`);
          });
        }

        this.container.appendChild(btn);
        return [
          hardpointIndex,
          {
            hardpointIndex,
            isWeapon: cfg?.fire !== undefined,
            root: btn,
            ring,
            icon,
            label,
            rounds,
            moduleId,
            cfg,
            lastState: null,
            lastRing: -1,
            lastRingKind: null,
            lastRounds: -1,
            lastDanger: false,
            lastNoEnergy: false,
            lastArmed: false,
            lastCounting: false,
            lastUnarmable: false,
            lastUnpowered: false,
            lastChanneling: false,
          } satisfies ButtonEntry,
        ] as const;
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

function resourcePct(value: number, capacity: number): number {
  return capacity > 0 ? Math.max(0, Math.min(100, Math.round((100 * value) / capacity))) : 0;
}

function findShipSnapshot(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}
