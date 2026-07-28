import { TransformNode, Vector3, type InstancedMesh, type Observer, type Scene } from "@babylonjs/core";
import {
  createLogger,
  type ConfigService,
  type ModuleConfig,
  type ModuleSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type UpgradeConfig,
  type UpgradeLevels,
  type UpgradeTrackName,
} from "@space-arena/shared";
import { AssetRegistry } from "../../core/AssetRegistry.js";
import type { AuthService } from "../../core/AuthService.js";
import { HangarApi, HangarApiError, type ApiFitting, type ApiModule, type ApiShip } from "../HangarApi.js";
import {
  buildHardpointMap,
  fittedModuleIdsOf,
  slotAccepts,
  slotsFromDefaultFitting,
  slotsFromHardpointMap,
  type HangarSlot,
} from "../hangarFitting.js";
import { computeStatPanel, type HangarStatPanel } from "../hangarStats.js";
import { ShipSocketRig, type ParticleQuality } from "../ShipSocketRig.js";
import type { TacticalCamera } from "../TacticalCamera.js";

const log = createLogger("Hangar");

const LS_SHIP = "hangar.shipId";
const LS_FITTING = "hangar.fittingId";
/**
 * The selected ship's upgrade levels as `/api/ships` last reported them. Cached
 * here because a MATCH needs them (client prediction resolves the same engine
 * stats the sim does — FLIGHT.md §5) and the match path has no authenticated
 * REST call of its own. Purely a local hint: it is never sent to the server,
 * which loads the authoritative levels from the DB at spawn.
 */
const LS_UPGRADES = "hangar.upgrades";
const STAGE_POS = new Vector3(0, 5, 300); // far from the arena (radius 90) — nothing else renders out here
const UPGRADE_TRACKS: readonly UpgradeTrackName[] = ["hull", "engine", "energy", "heat"];
const UPGRADE_LABELS: Record<UpgradeTrackName, string> = { hull: "Hull", engine: "Engine", energy: "Capacitor", heat: "Heat Sink" };

export interface HangarSelection {
  shipId: string | null;
  fittingId: string | null;
  /** Upgrade levels cached for {@link HangarSelection.shipId}; null when unknown (never logged in / never opened Hangar). */
  upgradeLevels: UpgradeLevels | null;
}

/** Reads the player's last Hangar ship/fitting choice — Lobby passes this as NetGameSession join options. */
export function loadHangarSelection(): HangarSelection {
  const shipId = localStorage.getItem(LS_SHIP);
  return { shipId, fittingId: localStorage.getItem(LS_FITTING), upgradeLevels: loadCachedUpgrades(shipId) };
}

const ZERO_LEVELS: UpgradeLevels = { hull: 0, engine: 0, energy: 0, heat: 0 };

/**
 * The cached upgrade levels, but only if they were stored for `shipId` — levels
 * from a different hull would resolve the wrong engine stats, which is worse
 * than not knowing them at all (the resolver then falls back to base).
 */
function loadCachedUpgrades(shipId: string | null): UpgradeLevels | null {
  if (!shipId) return null;
  const raw = localStorage.getItem(LS_UPGRADES);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { shipId?: string; levels?: Partial<UpgradeLevels> };
    if (parsed.shipId !== shipId || !parsed.levels) return null;
    const levels = parsed.levels;
    const track = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    return { hull: track(levels.hull), engine: track(levels.engine), energy: track(levels.energy), heat: track(levels.heat) };
  } catch {
    // Corrupt/hand-edited storage is not worth a crash on the way into a match.
    return null;
  }
}

/**
 * Hangar / Fitting screen (ROADMAP §9 4.5). Reuses the MAIN Babylon scene and
 * `TacticalCamera` rather than standing up a second scene/canvas: a staged
 * ship instance sits far from the arena (out of view at the arena's own
 * camera distances) and {@link TacticalCamera.setHangarMode} tightens the
 * orbit to frame it. The right/bottom panel is plain themed HTML, matching
 * {@link import("./Lobby.js").Lobby}/{@link import("./AuthScreen.js").AuthScreen}'s
 * hardcoded-palette convention (those screens render before the HUD's
 * `--hud-*` custom properties — scoped to `#hud` — exist, so this follows the
 * same convention rather than depending on that scope).
 *
 * Ship/module/upgrade browsing works fully offline (local `ConfigService`);
 * ownership, credits, upgrades and fittings need `/api/*` (auth required —
 * see `server/src/api/README.md`), so a truly anonymous visitor (never
 * logged in, never played as guest) gets a read-only preview with buy/save
 * disabled and a hint to log in or play as guest.
 */
export class Hangar {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly api: HangarApi;
  private readonly assets: AssetRegistry;
  private readonly stageRoot: TransformNode;
  private readonly unsubscribeAuth: () => void;

  private ships: ShipConfig[] = [];
  private shipIndex = 0;
  private apiShips: ApiShip[] = [];
  private apiModules: ApiModule[] = [];
  private fittings: ApiFitting[] = [];
  private selectedFittingId: string | null = null;
  private slots: HangarSlot[] = [];
  private pickerHardpoint: number | null = null;
  private busy = false;
  private error = "";

  private previewInstance: InstancedMesh | null = null;
  private previewRig: ShipSocketRig | null = null;
  private idleModules: ModuleSnapshot[] = [];
  private readonly idlePrev: ShipSnapshot;
  private readonly idleCur: ShipSnapshot;
  private previewClock = 0;
  private renderObserver: Observer<Scene> | null = null;

  /**
   * When the panel is a full-width bottom sheet (phones), the ship must center
   * in the strip ABOVE it, not in the full viewport (where the sheet hides it).
   * `panelShiftFrac` = the fraction of the full viewport height the visible
   * center is displaced upward: panelHeight / (2 * viewportHeight). 0 when the
   * panel docks right (desktop). Applied per-frame so it tracks pinch zoom.
   */
  private panelShiftFrac = 0;
  private readonly onViewportResize = (): void => this.measurePanelShift();

  constructor(
    parent: HTMLElement,
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly auth: AuthService,
    private readonly camera: TacticalCamera,
    private readonly onClose: () => void,
    /**
     * Emitter budget for the preview ship (§10 5.6). The hangar stages a full
     * socket rig on the same canvas as a match, so it honours the same tier —
     * a budget phone should not run full-rate trails on a menu screen.
     */
    private readonly particleQuality?: ParticleQuality,
  ) {
    this.api = new HangarApi(auth);
    this.assets = new AssetRegistry(scene);
    this.stageRoot = new TransformNode("hangarStage", scene);
    this.stageRoot.position.copyFrom(STAGE_POS);

    this.idleCur = idleSnapshot();
    this.idlePrev = idleSnapshot();

    injectHangarStyle();
    this.root = document.createElement("div");
    this.root.className = "hangar-overlay game-screen";
    this.panel = document.createElement("div");
    this.panel.className = "hangar-panel";
    this.root.append(this.panel);
    parent.append(this.root);

    this.ships = [...this.configs.getAll<ShipConfig>("ship")].sort((a, b) => a.id.localeCompare(b.id));

    this.unsubscribeAuth = this.auth.onChange(() => {
      if (this.root.style.display !== "none") void this.refreshFromServer();
    });

    this.root.style.display = "none";
  }

  private isAuthed(): boolean {
    return this.auth.getState().status === "authed";
  }

  private currentShip(): ShipConfig | undefined {
    return this.ships[this.shipIndex];
  }

  private currentUpgradeLevels(): UpgradeLevels {
    const ship = this.currentShip();
    const apiShip = ship ? this.apiShips.find((s) => s.id === ship.id) : undefined;
    return apiShip?.upgrades ?? ZERO_LEVELS;
  }

  show(): void {
    const stored = loadHangarSelection();
    const idx = stored.shipId ? this.ships.findIndex((s) => s.id === stored.shipId) : -1;
    this.shipIndex = idx >= 0 ? idx : 0;
    this.selectedFittingId = null;
    this.pickerHardpoint = null;
    this.error = "";

    const ship = this.currentShip();
    this.slots = ship ? slotsFromDefaultFitting(ship) : [];

    this.root.style.display = "flex";
    this.camera.setHangarMode(true);
    this.camera.stageAt(this.stageRoot.position, 9, -Math.PI / 2, 1.15);
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => this.tickPreview());
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("orientationchange", this.onViewportResize);

    this.rebuildPreview();
    this.render();
    this.measurePanelShift();

    void this.refreshFromServer().then(() => {
      if (stored.fittingId && this.fittings.some((f) => f.id === stored.fittingId && f.ship_id === ship?.id)) {
        this.loadFitting(stored.fittingId);
      }
    });
  }

  hide(): void {
    this.root.style.display = "none";
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("orientationchange", this.onViewportResize);
    this.panelShiftFrac = 0;
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.camera.setHangarMode(false);
    // Dispose the staged preview rather than leaving it running off-screen: a
    // ParticleSystem keeps animating every scene frame once started regardless
    // of whether anything still calls updateEmitters() on it, so leaving it
    // alive would quietly burn CPU/particles for the rest of the session
    // (found via live smoke test — a match started right after visiting
    // Hangar still had the Hangar preview's particle systems in `scene.particleSystems`).
    // `show()` unconditionally calls `rebuildPreview()`, so nothing is lost.
    this.previewRig?.dispose();
    this.previewRig = null;
    this.previewInstance?.dispose();
    this.previewInstance = null;
  }

  private async refreshFromServer(): Promise<void> {
    if (!this.isAuthed()) {
      this.apiShips = [];
      this.apiModules = [];
      this.fittings = [];
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    try {
      const [shipsRes, modulesRes, fittingsRes] = await Promise.all([this.api.ships(), this.api.modules(), this.api.fittings()]);
      this.apiShips = shipsRes.ships;
      this.apiModules = modulesRes.modules;
      this.fittings = fittingsRes.fittings;
      this.error = "";
      // Freshly-read upgrade levels: re-cache them for the match predictor, or
      // a purchase made this visit would stay invisible to it until the player
      // happened to re-pick a ship.
      this.persistSelection();
    } catch (err) {
      this.error = errorMessage(err, "Failed to load hangar data");
      log.warn("refreshFromServer failed", err);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // --- 3D preview -----------------------------------------------------------

  private rebuildPreview(): void {
    this.previewRig?.dispose();
    this.previewRig = null;
    this.previewInstance?.dispose();
    this.previewInstance = null;

    const ship = this.currentShip();
    if (!ship) return;

    const master = this.assets.getShipMaster(ship.render);
    const instance = master.createInstance(`hangarPreview.${ship.id}`);
    instance.isPickable = false;
    instance.parent = this.stageRoot;
    instance.position.setAll(0);
    this.previewInstance = instance;

    const fittedModuleIds = fittedModuleIdsOf(this.slots);
    this.previewRig = new ShipSocketRig(
      this.scene,
      this.configs,
      this.assets,
      ship,
      instance,
      fittedModuleIds,
      this.particleQuality,
    );
    this.idleModules = this.slots
      .filter((s): s is HangarSlot & { moduleId: string } => s.moduleId !== null)
      .map((s) => ({ moduleId: s.moduleId, hardpointIndex: s.hardpointIndex, state: "active", heat: 0, stateTimer: 0, cycleTimer: 0, channeling: false, shieldPool: 0 }) satisfies ModuleSnapshot);
  }

  /** Idle preview animation: a gentle synthetic throttle wave so engine trails visibly breathe at rest. */
  /** Re-measure how much of the viewport the panel sheet covers (phones only). */
  private measurePanelShift(): void {
    const rect = this.panel.getBoundingClientRect();
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    // Bottom-sheet mode = panel spans (nearly) the full width. Right-dock mode
    // leaves the ship visible already and gets no shift.
    this.panelShiftFrac = rect.width >= vw * 0.95 && rect.height > 0 ? rect.height / (2 * vh) : 0;
  }

  private tickPreview(): void {
    // Keep the staged ship centered in the UNOBSCURED part of the screen: shift
    // the orbit target down by the sheet's half-height expressed in world units
    // at the current radius, so the ship rides up above the panel. Tracks pinch
    // zoom because it re-derives from the live radius every frame.
    const cam = this.camera.camera;
    const worldViewHeight = 2 * cam.radius * Math.tan(cam.fov / 2);
    cam.target.y = this.stageRoot.position.y - this.panelShiftFrac * worldViewHeight;

    if (!this.previewRig) return;
    const dtMs = this.scene.getEngine().getDeltaTime();
    this.previewClock += dtMs / 1000;
    const wave = 0.35 + 0.25 * Math.sin(this.previewClock * 0.6);

    this.idlePrev.pos.x = this.idleCur.pos.x;
    this.idlePrev.pos.z = this.idleCur.pos.z;
    this.idleCur.pos.x += wave * 0.02;
    this.idleCur.modules = this.idleModules;
    this.idlePrev.modules = this.idleModules;

    this.previewRig.updateModules(this.idleCur.modules);
    this.previewRig.updateEmitters(this.idleCur, this.idlePrev, performance.now());
  }

  // --- state transitions -----------------------------------------------------

  private selectShip(index: number): void {
    this.shipIndex = index;
    this.selectedFittingId = null;
    this.pickerHardpoint = null;
    const ship = this.currentShip();
    this.slots = ship ? slotsFromDefaultFitting(ship) : [];
    this.persistSelection();
    this.rebuildPreview();
    this.render();
  }

  private loadFitting(fittingId: string | null): void {
    const ship = this.currentShip();
    if (!ship) return;
    this.selectedFittingId = fittingId;
    const fitting = fittingId ? this.fittings.find((f) => f.id === fittingId) : undefined;
    this.slots = fitting ? slotsFromHardpointMap(ship, fitting.hardpointMap) : slotsFromDefaultFitting(ship);
    this.pickerHardpoint = null;
    this.persistSelection();
    this.rebuildPreview();
    this.render();
  }

  private selectSlot(hardpointIndex: number): void {
    if (!this.isAuthed()) return;
    this.pickerHardpoint = this.pickerHardpoint === hardpointIndex ? null : hardpointIndex;
    this.render();
  }

  private equip(hardpointIndex: number, moduleId: string | null): void {
    const slot = this.slots[hardpointIndex];
    if (!slot) return;
    slot.moduleId = moduleId;
    this.pickerHardpoint = null;
    this.rebuildPreview();
    this.render();
  }

  private async buyModule(moduleId: string): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await this.api.buyModule(moduleId);
      await this.auth.refreshProfile();
      await this.refreshFromServer();
    } catch (err) {
      this.error = errorMessage(err, "Purchase failed");
      this.busy = false;
      this.render();
    }
  }

  private async upgradeTrack(track: UpgradeTrackName): Promise<void> {
    const ship = this.currentShip();
    if (!ship) return;
    this.busy = true;
    this.render();
    try {
      await this.api.upgradeShip(ship.id, track);
      await this.auth.refreshProfile();
      await this.refreshFromServer();
    } catch (err) {
      this.error = errorMessage(err, "Upgrade failed");
      this.busy = false;
      this.render();
    }
  }

  private async saveFitting(name: string): Promise<void> {
    const ship = this.currentShip();
    if (!ship || !name.trim()) return;
    const hardpointMap = buildHardpointMap(this.slots);
    this.busy = true;
    this.render();
    try {
      if (this.selectedFittingId) {
        const { fitting } = await this.api.updateFitting(this.selectedFittingId, { name: name.trim(), hardpointMap });
        this.selectedFittingId = fitting.id;
      } else {
        const { fitting } = await this.api.createFitting(ship.id, name.trim(), hardpointMap);
        this.selectedFittingId = fitting.id;
      }
      this.persistSelection();
      await this.refreshFromServer();
    } catch (err) {
      this.error = errorMessage(err, "Save failed");
      this.busy = false;
      this.render();
    }
  }

  private async deleteFitting(): Promise<void> {
    if (!this.selectedFittingId) return;
    this.busy = true;
    this.render();
    try {
      await this.api.deleteFitting(this.selectedFittingId);
      this.loadFitting(null);
      await this.refreshFromServer();
    } catch (err) {
      this.error = errorMessage(err, "Delete failed");
      this.busy = false;
      this.render();
    }
  }

  private persistSelection(): void {
    const shipId = this.currentShip()?.id ?? null;
    if (shipId) localStorage.setItem(LS_SHIP, shipId);
    else localStorage.removeItem(LS_SHIP);
    if (this.selectedFittingId) localStorage.setItem(LS_FITTING, this.selectedFittingId);
    else localStorage.removeItem(LS_FITTING);
    // Stored WITH the ship id: `loadCachedUpgrades` refuses levels belonging to
    // another hull. Dropped entirely for an unauthenticated visitor, whose
    // `apiShips` list is empty and whose levels are therefore unknown, not zero.
    if (shipId && this.apiShips.some((s) => s.id === shipId)) {
      localStorage.setItem(LS_UPGRADES, JSON.stringify({ shipId, levels: this.currentUpgradeLevels() }));
    } else {
      localStorage.removeItem(LS_UPGRADES);
    }
  }

  // --- rendering ---------------------------------------------------------

  private render(): void {
    const ship = this.currentShip();
    this.panel.innerHTML = "";
    if (!ship) return;

    const readOnly = !this.isAuthed();
    const profile = this.auth.getState();
    const credits = profile.status === "authed" ? profile.profile.credits : 0;
    const level = profile.status === "authed" ? profile.profile.level : 1;

    this.panel.append(this.buildHeader());
    if (readOnly) {
      const hint = el("div", "hangar-hint", "Log in or play as a guest to buy modules, upgrade, and save fittings.");
      this.panel.append(hint);
    }
    if (this.error) this.panel.append(el("div", "hangar-error", this.error));

    this.panel.append(this.buildShipCarousel());
    this.panel.append(this.buildStatPanel(ship));
    this.panel.append(this.buildSlotGrid(ship, readOnly));
    if (this.pickerHardpoint !== null) {
      this.panel.append(this.buildModulePicker(ship, this.pickerHardpoint, credits, level));
    }
    this.panel.append(this.buildUpgrades(ship, readOnly, credits));
    this.panel.append(this.buildFittingControls(ship, readOnly));
  }

  private buildHeader(): HTMLDivElement {
    const header = el("div", "hangar-header");
    header.append(el("span", "hangar-title", "HANGAR"));
    const close = document.createElement("button");
    close.className = "hangar-close";
    close.textContent = "✕ Back";
    close.disabled = this.busy;
    close.addEventListener("click", () => this.onClose());
    header.append(close);
    return header;
  }

  private buildShipCarousel(): HTMLDivElement {
    const wrap = el("div", "hangar-ships");
    this.ships.forEach((ship, i) => {
      const btn = document.createElement("button");
      btn.className = "hangar-ship-btn" + (i === this.shipIndex ? " active" : "");
      btn.innerHTML = "";
      btn.append(el("span", "hangar-ship-name", ship.name), el("span", "hangar-ship-class", ship.class));
      btn.disabled = this.busy;
      btn.addEventListener("click", () => this.selectShip(i));
      wrap.append(btn);
    });
    return wrap;
  }

  private buildStatPanel(ship: ShipConfig): HTMLDivElement {
    const panel = computeStatPanel(ship, this.configs, {
      upgradeLevels: this.currentUpgradeLevels(),
      fittedModuleIds: fittedModuleIdsOf(this.slots),
    });
    const wrap = el("div", "hangar-stats");
    wrap.append(el("div", "hangar-section-title", "Stats"));
    wrap.append(statRow("Hull", panel.hullMax.toFixed(0)));
    wrap.append(statRow("Speed", panel.nominalSpeed.toFixed(1)));
    wrap.append(statRow("Capacitor", `${panel.capacitorMax.toFixed(0)} (+${panel.capacitorRegen.toFixed(1)}/s)`));
    wrap.append(statRow("Heat cap.", `${panel.heatCapacity.toFixed(0)} (-${panel.heatDissipation.toFixed(1)}/s)`));
    wrap.append(statRow("DPS (est.)", panel.dps.toFixed(1)));
    wrap.append(statRow("EHP (est.)", panel.ehpApprox.toFixed(0)));
    wrap.append(this.buildBudgetBar("Idle energy budget", panel.energyBudget, panel.idleDrawTotal, panel.capacitorRegen));
    wrap.append(this.buildHeatWarn(panel));
    return wrap;
  }

  private buildBudgetBar(label: string, budget: number, draw: number, regen: number): HTMLDivElement {
    const row = el("div", "hangar-bar-row");
    row.append(el("span", "hangar-bar-label", `${label}: ${budget >= 0 ? "+" : ""}${budget.toFixed(1)}/s`));
    const track = el("div", "hangar-bar-track");
    const denom = Math.max(1, draw, regen);
    const fill = el("div", "hangar-bar-fill" + (budget < 0 ? " warn" : ""));
    fill.style.width = `${Math.min(100, (Math.min(draw, regen) / denom) * 100)}%`;
    track.append(fill);
    row.append(track);
    return row;
  }

  private buildHeatWarn(panel: HangarStatPanel): HTMLDivElement {
    const row = el("div", "hangar-bar-row");
    const warn = panel.heatNetPerSec > 0;
    row.append(
      el(
        "span",
        "hangar-bar-label" + (warn ? " warn-text" : ""),
        `Sustained-fire heat: ${warn ? "+" : ""}${panel.heatNetPerSec.toFixed(1)}/s${warn ? " (will overheat)" : ""}`,
      ),
    );
    return row;
  }

  private buildSlotGrid(ship: ShipConfig, readOnly: boolean): HTMLDivElement {
    const wrap = el("div", "hangar-slots");
    wrap.append(el("div", "hangar-section-title", "Hardpoints"));
    const grid = el("div", "hangar-slot-grid");
    for (const slot of this.slots) {
      const mod = slot.moduleId ? this.configs.get<ModuleConfig>("module", slot.moduleId) : undefined;
      const btn = document.createElement("button");
      btn.className = "hangar-slot" + (slot.moduleId ? " filled" : "") + (this.pickerHardpoint === slot.hardpointIndex ? " open" : "");
      btn.disabled = readOnly || this.busy;
      btn.append(el("span", "hangar-slot-icon", mod?.ui.icon ?? "+"));
      btn.append(el("span", "hangar-slot-label", mod?.ui.label ?? "Empty"));
      btn.append(el("span", "hangar-slot-socket", `${slot.socketId} · ${slot.accepts.join("/")}`));
      btn.addEventListener("click", () => this.selectSlot(slot.hardpointIndex));
      grid.append(btn);
    }
    wrap.append(grid);
    return wrap;
  }

  private buildModulePicker(ship: ShipConfig, hardpointIndex: number, credits: number, level: number): HTMLDivElement {
    const slot = this.slots[hardpointIndex];
    const wrap = el("div", "hangar-picker");
    wrap.append(el("div", "hangar-section-title", `Fit ${slot?.socketId ?? ""}`));

    if (slot?.moduleId) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "hangar-btn";
      removeBtn.textContent = "Remove module";
      removeBtn.disabled = this.busy;
      removeBtn.addEventListener("click", () => this.equip(hardpointIndex, null));
      wrap.append(removeBtn);
    }

    const candidates = this.configs
      .getAll<ModuleConfig>("module")
      .filter((m) => slot && slotAccepts(slot, m.family))
      .sort((a, b) => a.level - b.level || (a.name ?? a.id).localeCompare(b.name ?? b.id));

    for (const mod of candidates) {
      const api = this.apiModules.find((m) => m.id === mod.id);
      const owned = api?.owned ?? false;
      const locked = mod.requiresLevel > level;
      const row = el("div", "hangar-picker-item");
      row.append(el("span", "hangar-picker-name", `${mod.ui.icon} ${mod.name}`));
      row.append(el("span", "hangar-picker-meta", locked ? `Lv ${mod.requiresLevel} required` : owned ? "Owned" : `${mod.price} cr`));

      if (owned) {
        const equipBtn = document.createElement("button");
        equipBtn.className = "hangar-btn hangar-btn-primary";
        equipBtn.textContent = "Equip";
        equipBtn.disabled = this.busy;
        equipBtn.addEventListener("click", () => this.equip(hardpointIndex, mod.id));
        row.append(equipBtn);
      } else if (!locked) {
        const buyBtn = document.createElement("button");
        buyBtn.className = "hangar-btn";
        buyBtn.textContent = mod.price > 0 ? `Buy (${mod.price} cr)` : "Unlock (free)";
        buyBtn.disabled = this.busy || credits < mod.price;
        buyBtn.addEventListener("click", () => void this.buyModule(mod.id));
        row.append(buyBtn);
      }
      wrap.append(row);
    }
    if (candidates.length === 0) wrap.append(el("div", "hangar-hint", "No modules fit this hardpoint's families."));
    return wrap;
  }

  private buildUpgrades(ship: ShipConfig, readOnly: boolean, credits: number): HTMLDivElement {
    const wrap = el("div", "hangar-upgrades");
    wrap.append(el("div", "hangar-section-title", "Upgrades"));
    const levels = this.currentUpgradeLevels();
    for (const track of UPGRADE_TRACKS) {
      const upgradeId = ship.upgradeTracks[track];
      const cfg = this.configs.get<UpgradeConfig>("upgrade", upgradeId);
      const current = levels[track];
      const maxLevel = cfg?.levels.length ?? 1;
      const nextConfig = cfg?.levels[current];

      const row = el("div", "hangar-upgrade-row");
      row.append(el("span", "hangar-upgrade-label", UPGRADE_LABELS[track]));
      const pips = el("span", "hangar-pips");
      for (let i = 0; i < maxLevel; i++) pips.append(el("span", "pip" + (i < current ? " filled" : "")));
      row.append(pips);

      const btn = document.createElement("button");
      btn.className = "hangar-btn";
      if (!nextConfig) {
        btn.textContent = "Max";
        btn.disabled = true;
      } else {
        btn.textContent = `Upgrade (${nextConfig.price} cr)`;
        btn.disabled = readOnly || this.busy || credits < nextConfig.price;
        btn.addEventListener("click", () => void this.upgradeTrack(track));
      }
      row.append(btn);
      wrap.append(row);
    }
    return wrap;
  }

  private buildFittingControls(ship: ShipConfig, readOnly: boolean): HTMLDivElement {
    const wrap = el("div", "hangar-fit-controls");
    wrap.append(el("div", "hangar-section-title", "Fitting"));

    const select = document.createElement("select");
    select.className = "hangar-select";
    select.disabled = readOnly || this.busy;
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Default fit";
    select.append(defaultOpt);
    for (const f of this.fittings.filter((f) => f.ship_id === ship.id)) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      select.append(opt);
    }
    select.value = this.selectedFittingId ?? "";
    select.addEventListener("change", () => this.loadFitting(select.value || null));
    wrap.append(select);

    const nameInput = document.createElement("input");
    nameInput.className = "hangar-input";
    nameInput.type = "text";
    nameInput.placeholder = "Fitting name";
    nameInput.maxLength = 60;
    nameInput.disabled = readOnly || this.busy;
    const current = this.selectedFittingId ? this.fittings.find((f) => f.id === this.selectedFittingId) : undefined;
    nameInput.value = current?.name ?? "";
    wrap.append(nameInput);

    const row = el("div", "hangar-fit-btn-row");
    const saveBtn = document.createElement("button");
    saveBtn.className = "hangar-btn hangar-btn-primary";
    saveBtn.textContent = this.selectedFittingId ? "Update fitting" : "Save new fitting";
    saveBtn.disabled = readOnly || this.busy;
    saveBtn.addEventListener("click", () => void this.saveFitting(nameInput.value));
    row.append(saveBtn);

    if (this.selectedFittingId) {
      const delBtn = document.createElement("button");
      delBtn.className = "hangar-btn hangar-btn-danger";
      delBtn.textContent = "Delete";
      delBtn.disabled = readOnly || this.busy;
      delBtn.addEventListener("click", () => void this.deleteFitting());
      row.append(delBtn);
    }
    wrap.append(row);
    return wrap;
  }

  dispose(): void {
    this.hide();
    this.unsubscribeAuth();
    this.previewRig?.dispose();
    this.previewInstance?.dispose();
    this.assets.dispose();
    this.stageRoot.dispose();
    this.root.remove();
  }
}

function idleSnapshot(): ShipSnapshot {
  return {
    id: -1,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0, // parked and level; the bubble's vertical axis is unused here
    hull: 1,
    hullMax: 1,
    energy: { cur: 1, max: 1 },
    heat: { cur: 0, capacity: 1 },
    targetId: null,
    throttle: 0, // parked on the hangar stage — no flight input
    lockProgress: 0, // …and nothing to lock onto
    locked: false,
    modules: [],
  };
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof HangarApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function el(tag: string, className?: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statRow(label: string, value: string): HTMLDivElement {
  const row = el("div", "hangar-stat-row");
  row.append(el("span", "hangar-stat-label", label), el("span", "hangar-stat-value", value));
  return row;
}

const STYLE_ID = "hangar-style";
function injectHangarStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HANGAR_CSS;
  document.head.appendChild(style);
}

const HANGAR_CSS = `
.hangar-overlay {
  position: fixed;
  inset: 0;
  z-index: 15;
  pointer-events: none;
  font-family: system-ui;
  color: #e8f1ff;
}
.hangar-panel {
  pointer-events: auto;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(380px, 100vw);
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  background: rgba(6, 10, 20, 0.94);
  border-left: 1px solid #2f6fb8;
  padding:
    calc(env(safe-area-inset-top, 0px) + 14px)
    calc(env(safe-area-inset-right, 0px) + 14px)
    calc(env(safe-area-inset-bottom, 0px) + 14px)
    14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* Phones: the panel becomes a bottom sheet so the staged ship stays visible
   and every control sits in the thumb half of the screen. */
@media (max-width: 700px) {
  .hangar-panel {
    top: auto;
    left: 0;
    right: 0;
    width: 100%;
    max-height: 60vh;
    border-left: none;
    border-top: 1px solid #2f6fb8;
    border-radius: 12px 12px 0 0;
    padding-left: calc(env(safe-area-inset-left, 0px) + 14px);
  }
}
/* Landscape phones have very little height — give the sheet more of it. */
@media (max-width: 900px) and (max-height: 480px) {
  .hangar-panel { max-height: 78vh; }
}
.hangar-header { display: flex; align-items: center; justify-content: space-between; }
.hangar-title { letter-spacing: .25em; font-weight: 300; color: #57d8ff; font-size: 16px; }
.hangar-close { background: transparent; color: #e8f1ff; border: 1px solid #2f6fb8; border-radius: 6px; padding: 8px 12px; min-height: 36px; cursor: pointer; touch-action: manipulation; }
.hangar-hint { font-size: 12px; color: #9fb4d0; background: rgba(87,216,255,.08); border: 1px solid #2f6fb8; border-radius: 6px; padding: 6px 8px; }
.hangar-error { font-size: 12px; color: #ff8080; background: rgba(255,77,94,.1); border: 1px solid #ff4d5e; border-radius: 6px; padding: 6px 8px; }
.hangar-section-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #9fb4d0; margin-bottom: 4px; }
.hangar-ships { display: flex; flex-wrap: wrap; gap: 6px; }
.hangar-ship-btn { flex: 1 1 96px; min-height: 44px; touch-action: manipulation; display: flex; flex-direction: column; gap: 2px; padding: 8px 6px; background: #0c1526; color: #e8f1ff; border: 1px solid #2f6fb8; border-radius: 6px; cursor: pointer; }
.hangar-ship-btn.active { background: #1c3a5e; border-color: #57d8ff; }
.hangar-ship-name { font-size: 12px; font-weight: 600; }
.hangar-ship-class { font-size: 10px; color: #9fb4d0; text-transform: uppercase; }
.hangar-stats { display: flex; flex-direction: column; gap: 3px; }
.hangar-stat-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
.hangar-stat-label { color: #9fb4d0; }
.hangar-bar-row { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
.hangar-bar-label { font-size: 11px; color: #9fb4d0; }
.hangar-bar-label.warn-text { color: #ff8080; }
.hangar-bar-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; }
.hangar-bar-fill { height: 100%; background: #5fe08c; }
.hangar-bar-fill.warn { background: #ff4d5e; }
.hangar-slot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; }
.hangar-slot { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; min-height: 60px; touch-action: manipulation; background: #0c1526; color: #e8f1ff; border: 1px solid #2f6fb8; border-radius: 6px; cursor: pointer; }
.hangar-slot.filled { border-color: #57d8ff; }
.hangar-slot.open { background: #1c3a5e; }
.hangar-slot:disabled { opacity: .5; cursor: default; }
.hangar-slot-icon { font-size: 16px; }
.hangar-slot-label { font-size: 11px; font-weight: 600; }
.hangar-slot-socket { font-size: 9px; color: #9fb4d0; text-align: center; }
.hangar-picker { display: flex; flex-direction: column; gap: 6px; background: #0c1526; border: 1px solid #2f6fb8; border-radius: 6px; padding: 8px; }
.hangar-picker-item { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; font-size: 12px; }
.hangar-picker-name { flex: 1; }
.hangar-picker-meta { color: #9fb4d0; font-size: 11px; white-space: nowrap; }
.hangar-upgrades { display: flex; flex-direction: column; gap: 6px; }
.hangar-upgrade-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; }
.hangar-upgrade-label { width: 72px; }
.hangar-pips { display: flex; flex-wrap: wrap; gap: 3px; flex: 1 1 60px; }
.pip { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,.15); border: 1px solid #2f6fb8; }
.pip.filled { background: #57d8ff; }
.hangar-fit-controls { display: flex; flex-direction: column; gap: 6px; }
.hangar-fit-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }
.hangar-select, .hangar-input { width: 100%; box-sizing: border-box; padding: 8px; min-height: 40px; font-size: 16px; background: #0c1526; color: #e8f1ff; border: 1px solid #2f6fb8; border-radius: 6px; }
.hangar-btn { padding: 8px 12px; min-height: 36px; touch-action: manipulation; font-size: 12px; background: #12203a; color: #e8f1ff; border: 1px solid #2f6fb8; border-radius: 6px; cursor: pointer; }
.hangar-btn:disabled { opacity: .5; cursor: default; }
.hangar-btn-primary { background: #57d8ff; color: #04101f; font-weight: 600; border: none; }
.hangar-btn-danger { background: transparent; color: #ff8080; border-color: #ff4d5e; }
`;
