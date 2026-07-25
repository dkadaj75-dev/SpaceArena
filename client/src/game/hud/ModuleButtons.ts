import type { ConfigService, EntityId, EventBus, ConfigEvents, ModuleConfig, ModuleSnapshot, ShipSnapshot, Snapshot, ModuleState } from "@space-arena/shared";
import { createLogger } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { clusterOffsets, resolveHudLayout, type HudLayout } from "./hudLayout.js";

const log = createLogger("HudModuleButtons");

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
}

/**
 * One circular button per fitted module, auto-generated from the player's
 * fitting (bottom-right radial cluster, §2.3). Tap toggles activate/deactivate
 * via `moduleToggle` orders; visuals reflect the module's runtime state each
 * frame but only write to the DOM when something actually changed.
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

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    _bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-modules";
    root.appendChild(this.container);
    // Standalone default until the Hud pushes the resolved layout in.
    this.layout = resolveHudLayout(undefined, { width: 0, height: 0 });
    this.applyLayout(this.layout);
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

  update(cur: Snapshot): void {
    // Indexed scan, not `Array.find` — per-frame hot path, no closure.
    const ship = findShipSnapshot(cur, this.playerId);
    if (!ship) return;

    // Module count only changes on a fresh spawn (fitting is fixed for the
    // match), so this cheap length check is enough to detect a rebuild is
    // needed — the per-module work below stays keyed by hardpointIndex.
    if (ship.modules.length !== this.builtForModuleCount) {
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
        } else if (m.state === "active") {
          ringPct = 100;
        }
      }
      ringPct = Math.max(0, Math.min(100, Math.round(ringPct)));

      const drawIdle = entry.cfg?.energy.drawIdle ?? 0;
      const noEnergy = m.state === "retracted" && ship.energy.cur < drawIdle;

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
    }
  }

  private rebuild(modules: readonly ModuleSnapshot[]): void {
    this.container.innerHTML = "";
    this.entries = new Map(
      modules.map((m) => {
        const hardpointIndex = m.hardpointIndex;
        const moduleId = m.moduleId;
        const cfg = this.configs.get<ModuleConfig>("module", moduleId);
        if (!cfg) log.warn(`unknown module config ${moduleId}`);

        const btn = document.createElement("div");
        btn.className = "hud-module-btn";
        btn.setAttribute(HUD_CONTROL_ATTR, "module");
        btn.style.setProperty("--ring", "0");

        const icon = document.createElement("span");
        icon.className = "icon";
        icon.textContent = cfg?.ui.icon ?? "?";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = cfg?.ui.label ?? moduleId;

        btn.appendChild(icon);
        btn.appendChild(label);
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
          } satisfies ButtonEntry,
        ] as const;
      }),
    );
    this.builtForModuleCount = modules.length;
    this.position();
  }

  dispose(): void {
    this.container.remove();
  }
}

function findShipSnapshot(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}
