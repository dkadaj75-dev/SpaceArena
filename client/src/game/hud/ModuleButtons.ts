import type { ConfigService, EntityId, EventBus, ConfigEvents, ModuleConfig, ModuleFamily, ModuleSnapshot, ShipSnapshot, Snapshot, ModuleState, ThemeConfig } from "@space-arena/shared";
import { createLogger, isInternalFamily } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { clusterOffsets, resolveHudLayout, type HudLayout } from "./hudLayout.js";
import { moduleIconId, moduleIconSvg } from "./moduleIcons.js";

const log = createLogger("HudModuleButtons");
const THEME_ID = "theme.default";

export const MODULE_FAMILY_COLOR_FALLBACKS: Readonly<Record<ModuleFamily, string>> = {
  shield: "#3b5bdb",
  missile: "#7b2fbf",
  laser: "#12b5cb",
  kinetic: "#f59f35",
  utility: "#67c587",
  boost: "#e8b44f",
  // Internals (2026-07-31). They get no HUD button, but the hangar colour-codes
  // slots from the same map, so every family needs an entry.
  engine: "#e8b44f",
  generator: "#63d2a4",
  transformer: "#b07de0",
  heatsink: "#5ec9e8",
  sensors: "#9aa8bd",
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
  root: HTMLDivElement;
  icon: HTMLSpanElement;
  label: HTMLSpanElement;
  moduleId: string;
  cfg: ModuleConfig | undefined;
  // Last-rendered values so we only touch the DOM on change.
  lastState: ModuleState | null;
  lastRing: number;
  lastNoEnergy: boolean;
  lastArmed: boolean;
  lastCooling: boolean;
  lastUnarmable: boolean;
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
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: HudLayout): void {
    this.layout = layout;
    this.container.dataset["anchor"] = layout.cluster.anchor;
    this.container.dataset["layout"] = layout.cluster.layout;
    this.position();
  }

  /** Writes each button's pivot-relative centre into its inline left/top. */
  private position(): void {
    const buttons = [...this.entries.values()];
    const offsets = clusterOffsets(buttons.length, this.layout);
    const r = this.layout.cluster.buttonRadiusPx;
    for (let i = 0; i < buttons.length; i++) {
      const offset = offsets[i];
      if (!offset) continue;
      buttons[i]!.root.style.left = `${offset.dx - r}px`;
      buttons[i]!.root.style.top = `${offset.dy - r}px`;
    }
  }

  /**
   * Whether a fitted module deserves a button in THIS cluster. Two exclusions:
   *
   *  - Internals (engine, generator, transformer, heatsink, sensors —
   *    2026-07-31) are always-on systems with nothing to toggle, so they are
   *    shown in the Hangar and nowhere else. The one internal ACTION,
   *    jettisoning a heatsink, has its own control.
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

      let ringPct = 0;
      if (entry.cfg) {
        if (m.state === "deploying" && entry.cfg.activation.deployTime > 0) {
          ringPct = 100 * (1 - m.stateTimer / entry.cfg.activation.deployTime);
        } else if (m.state === "retracting" && entry.cfg.activation.retractTime > 0) {
          ringPct = 100 * (1 - m.stateTimer / entry.cfg.activation.retractTime);
        } else if (m.state === "overheated" && entry.cfg.heat.overheatCooldown > 0) {
          ringPct = 100 * (1 - m.stateTimer / entry.cfg.heat.overheatCooldown);
        } else if (
          m.state === "active" &&
          entry.cfg.fire &&
          // A `continuous` weapon has no shot cadence — its `cycleTime` is an
          // ignored placeholder and `cycleTimer` stays 0 — so it never shows a
          // cooldown ring; the `channeling` class below is its live indicator.
          entry.cfg.fire.mode !== "continuous" &&
          m.cycleTimer > 0 &&
          entry.cfg.fire.cycleTime > 0
        ) {
          ringPct = 100 * (m.cycleTimer / entry.cfg.fire.cycleTime);
        } else if (m.state === "active") {
          ringPct = 100;
        }
      }
      ringPct = Math.max(0, Math.min(100, Math.round(ringPct)));

      const drawIdle = entry.cfg?.energy.drawIdle ?? 0;
      const noEnergy = m.state === "retracted" && ship.energy.cur < drawIdle;
      const armed = m.state === "active" && entry.cfg?.fire !== undefined;
      const cooling = m.state === "active" && entry.cfg?.fire !== undefined && m.cycleTimer > 0;
      // Only homing weapons still hard-require a lock; straight-fire weapons
      // (laser/kinetic/beam) shoot down the nose without one and never grey out.
      const unarmable =
        m.state === "active" && entry.cfg?.fire?.projectile?.turnRate !== undefined && !ship.locked;

      if (m.state !== entry.lastState) {
        if (entry.lastState) entry.root.classList.remove(`state-${entry.lastState}`);
        entry.root.classList.add(`state-${m.state}`);
        entry.lastState = m.state;
      }
      if (ringPct !== entry.lastRing) {
        entry.root.style.setProperty("--ring", String(ringPct));
        entry.lastRing = ringPct;
      }
      if (noEnergy !== entry.lastNoEnergy) {
        entry.root.classList.toggle("no-energy", noEnergy);
        entry.lastNoEnergy = noEnergy;
      }
      if (armed !== entry.lastArmed) {
        entry.root.classList.toggle("armed", armed);
        entry.lastArmed = armed;
      }
      if (cooling !== entry.lastCooling) {
        entry.root.classList.toggle("cooling", cooling);
        entry.lastCooling = cooling;
      }
      if (unarmable !== entry.lastUnarmable) {
        entry.root.classList.toggle("unarmable", unarmable);
        entry.lastUnarmable = unarmable;
      }
      // Continuous weapons get `channeling` instead of a `cooling` ring: the
      // ring encodes a cadence a channel does not have. Exposed unstyled — the
      // shipped theme currently renders it the same as any armed button.
      if (m.channeling !== entry.lastChanneling) {
        entry.root.classList.toggle("channeling", m.channeling);
        entry.lastChanneling = m.channeling;
      }
    }
  }

  private rebuild(modules: readonly ModuleSnapshot[]): void {
    this.container.innerHTML = "";
    this.entries = new Map(
      modules.filter((m) => this.isButtonable(m.moduleId)).map((m) => {
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
        ring.setAttribute("aria-hidden", "true");

        const icon = document.createElement("span");
        icon.className = "icon";
        // Real glyph, not the authored `[ICON: …]` placeholder text: the id is
        // resolved from ui.iconId → ui.icon's tag → family (see moduleIcons.ts).
        icon.innerHTML = moduleIconSvg(moduleIconId(cfg));
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = moduleHudName(cfg, moduleId);

        btn.append(ring, icon, label);
        btn.addEventListener("click", () => {
          this.session.order({ kind: "moduleToggle", hardpointIndex });
          log.debug(`moduleToggle → hardpoint ${hardpointIndex} (${moduleId})`);
        });

        this.container.appendChild(btn);
        return [
          hardpointIndex,
          {
            hardpointIndex,
            root: btn,
            icon,
            label,
            moduleId,
            cfg,
            lastState: null,
            lastRing: -1,
            lastNoEnergy: false,
            lastArmed: false,
            lastCooling: false,
            lastUnarmable: false,
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
    this.container.remove();
  }
}

function findShipSnapshot(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}
