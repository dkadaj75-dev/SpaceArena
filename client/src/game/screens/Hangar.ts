import { TransformNode, Vector3, type InstancedMesh, type Observer, type Scene } from "@babylonjs/core";
import {
  createLogger,
  hardpointsOf,
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
import {
  deleteLocalFitting,
  isLocalFittingId,
  listLocalFittings,
  saveLocalFitting,
} from "../offlineFittings.js";
import { moduleStats } from "../moduleSummary.js";
import { HangarCallouts, type CalloutSpec } from "./HangarCallouts.js";
import { framingRadius, stageAspect, stageViewport } from "../hangarLayout.js";
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
/**
 * The WORKING fitting — the module ids currently in the slots, saved or not.
 * Stored so that whatever is on screen when the player leaves the Hangar is
 * what they fly (owner 2026-07-31). Kept beside the ship id for the same reason
 * {@link LS_UPGRADES} is: a module list belonging to another hull would not fit
 * this one's sockets.
 */
const LS_MODULES = "hangar.moduleIds";
const STAGE_POS = new Vector3(0, 5, 300); // far from the arena (radius 90) — nothing else renders out here
const UPGRADE_TRACKS: readonly UpgradeTrackName[] = ["hull", "engine", "energy", "heat"];
const UPGRADE_LABELS: Record<UpgradeTrackName, string> = { hull: "Hull", engine: "Engine", energy: "Capacitor", heat: "Heat Sink" };

export interface HangarSelection {
  shipId: string | null;
  fittingId: string | null;
  /** Upgrade levels cached for {@link HangarSelection.shipId}; null when unknown (never logged in / never opened Hangar). */
  upgradeLevels: UpgradeLevels | null;
  /**
   * The working fitting for {@link HangarSelection.shipId} as a POSITIONAL
   * module-id array (index = hardpoint index, `null` = empty), or null when
   * unknown. This is what the player last had in the slots — a saved fitting
   * they selected, or unsaved edits. Offline matches spawn from it directly;
   * online matches still send `fittingId`, because the server validates module
   * ownership against the DB and cannot take an arbitrary list on trust.
   */
  moduleIds: (string | null)[] | null;
}

/** Reads the player's last Hangar ship/fitting choice — Lobby passes this as NetGameSession join options. */
export function loadHangarSelection(): HangarSelection {
  const shipId = localStorage.getItem(LS_SHIP);
  return {
    shipId,
    fittingId: localStorage.getItem(LS_FITTING),
    upgradeLevels: loadCachedUpgrades(shipId),
    moduleIds: loadCachedModules(shipId),
  };
}

/**
 * The working fitting, but only if it was stored for `shipId` — a list from
 * another hull would address sockets this one does not have (spawn throws on a
 * fitting whose family a hardpoint refuses), so an unknown fit is safer than a
 * wrong one: callers fall back to the ship's `defaultFitting`.
 */
function loadCachedModules(shipId: string | null): (string | null)[] | null {
  if (!shipId) return null;
  const raw = localStorage.getItem(LS_MODULES);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { shipId?: string; moduleIds?: unknown };
    if (parsed.shipId !== shipId || !Array.isArray(parsed.moduleIds)) return null;
    return parsed.moduleIds.map((id) => (typeof id === "string" && id.length > 0 ? id : null));
  } catch {
    // Corrupt/hand-edited storage is not worth a crash on the way into a match.
    return null;
  }
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
 * Ship/module/upgrade browsing works fully offline (local `ConfigService`).
 *
 * ## Offline fitting (TESTING AFFORDANCE — owner 2026-07-31, to be removed)
 *
 * Fitting and saving are available WITHOUT an account: every module counts as
 * owned, level gates are ignored, and named fittings live in `localStorage`
 * (see `offlineFittings.ts`). Only the parts that move real credits —
 * purchases and upgrade tracks — still require `/api/*` and a real account.
 * Removing this later means deleting `offlineFittings.ts` and the
 * `offlineFitting` branch here; nothing else grew a second code path.
 */
export class Hangar {
  private readonly root: HTMLDivElement;
  /** Transparent half the 3D stage renders into (see `.hangar-stage` CSS). */
  private readonly stage: HTMLDivElement;
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
  /** Labelled tags pinned to each slot on the 3D hull (2026-07-31). */
  private readonly callouts: HangarCallouts;
  /** Module id currently being dragged out of the picker, if any. */
  private draggingModuleId: string | null = null;

  /**
   * World-space centre the camera orbits: the GEOMETRIC centre of the staged
   * hull (its bounding-box centre), not the stage root — a ship whose mesh sits
   * off its own origin would otherwise swing around a point outside itself.
   */
  private readonly focus = new Vector3(0, 0, 0);
  private readonly onViewportResize = (): void => this.applyStageViewport();

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
    // Half the screen is a hole onto the 3D stage: it must NOT take pointer
    // events, or it would eat the orbit/zoom drags meant for the canvas below.
    this.stage = document.createElement("div");
    this.stage.className = "hangar-stage";
    this.stage.setAttribute("aria-hidden", "true");
    this.panel = document.createElement("div");
    this.panel.className = "hangar-panel";
    this.root.append(this.stage, this.panel);
    parent.append(this.root);

    this.callouts = new HangarCallouts(this.stage, scene, this.stageRoot, {
      onSelect: (index) => this.selectSlot(index),
      onDrop: (index, moduleId) => this.dropModule(index, moduleId),
    });

    this.ships = [...this.configs.getAll<ShipConfig>("ship")].sort((a, b) => a.id.localeCompare(b.id));

    this.unsubscribeAuth = this.auth.onChange(() => {
      if (this.root.style.display !== "none") void this.refreshFromServer();
    });

    this.root.style.display = "none";
  }

  private isAuthed(): boolean {
    return this.auth.getState().status === "authed";
  }

  /**
   * Offline fitting mode — a TESTING AFFORDANCE (owner 2026-07-31), to be
   * removed later. With no account there is no ownership to check and no
   * server to save to, so the Hangar stays fully usable: every module counts as
   * owned and named fittings live in localStorage (see `offlineFittings.ts`).
   * Purchases and upgrades still need a real account — those move real credits.
   */
  private get offlineFitting(): boolean {
    return !this.isAuthed();
  }

  /** Whether this module can be fitted right now (owned, or offline test mode). */
  private canEquip(moduleId: string): boolean {
    if (this.offlineFitting) return true;
    return this.apiModules.find((m) => m.id === moduleId)?.owned ?? false;
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
    this.rebuildCallouts();
    this.render();
    this.applyStageViewport();

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
    // Hand the whole canvas back — a match must never render into half of it.
    this.camera.setStageViewport(null);
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
      // Offline test mode: named fittings come from localStorage instead.
      this.fittings = listLocalFittings();
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

  /**
   * Point the camera at the stage half of the split screen and frame the hull
   * inside it. Re-run on resize and orientation change, so rotating the phone
   * flips the split (stacked ⇄ side by side) and re-fits the ship in one step.
   */
  private applyStageViewport(): void {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    this.camera.setStageViewport(stageViewport(w, h));
    this.frameShip(stageAspect(w, h));
  }

  /**
   * Centre the orbit on the hull's geometric centre and pull back far enough to
   * see all of it, then let the player zoom within a range scaled to the hull —
   * so "zoom out" always means the same thing regardless of which ship is on
   * the stage.
   */
  private frameShip(aspect: number): void {
    const instance = this.previewInstance;
    if (!instance) {
      this.focus.copyFrom(this.stageRoot.position);
      return;
    }
    instance.computeWorldMatrix(true);
    const bounds = instance.getBoundingInfo().boundingSphere;
    this.focus.copyFrom(bounds.centerWorld);
    const radius = framingRadius(bounds.radiusWorld, this.camera.camera.fov, aspect);
    this.camera.setStageRadiusRange(radius * 0.35, radius * 2.5);
    this.camera.stageAt(this.focus, radius, this.camera.camera.alpha, this.camera.camera.beta);
  }

  private tickPreview(): void {
    // The orbit centre IS the hull's geometric centre (owner 2026-07-31): hold
    // it every frame so a stray pan gesture cannot drift the ship off its own
    // pivot. Orbit angle and zoom stay entirely the player's.
    this.camera.camera.target.copyFrom(this.focus);
    this.callouts.update();

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
    this.rebuildCallouts();
    // A different hull is a different size: re-frame it. (Swapping a MODULE
    // deliberately does not, so an edit never yanks the player's zoom back.)
    this.frameShip(stageAspect(window.innerWidth || 1, window.innerHeight || 1));
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
    this.rebuildCallouts();
    this.render();
  }

  private selectSlot(hardpointIndex: number): void {
    this.pickerHardpoint = this.pickerHardpoint === hardpointIndex ? null : hardpointIndex;
    this.callouts.setSelected(this.pickerHardpoint);
    this.render();
  }

  /**
   * A module was dragged from the picker onto a slot's callout. Accepts only
   * what that socket takes and what the player owns — the same two rules the
   * Equip button applies, since a drop IS an equip.
   */
  private dropModule(hardpointIndex: number, moduleId: string): void {
    this.endDrag();
    const slot = this.slots[hardpointIndex];
    const cfg = this.configs.get<ModuleConfig>("module", moduleId);
    if (!slot || !cfg || !slotAccepts(slot, cfg.family)) return;
    if (!this.canEquip(moduleId)) return;
    this.equip(hardpointIndex, moduleId);
  }

  /** Slot indices a module could legally be dropped into. */
  private dropCandidatesFor(moduleId: string): Set<number> {
    const cfg = this.configs.get<ModuleConfig>("module", moduleId);
    const out = new Set<number>();
    if (!cfg) return out;
    for (const slot of this.slots) {
      if (slotAccepts(slot, cfg.family)) out.add(slot.hardpointIndex);
    }
    return out;
  }

  private beginDrag(moduleId: string): void {
    this.draggingModuleId = moduleId;
    this.root.classList.add("dragging");
    this.callouts.setDropCandidates(this.dropCandidatesFor(moduleId));
  }

  private endDrag(): void {
    this.draggingModuleId = null;
    this.root.classList.remove("dragging");
    this.callouts.setDropCandidates(null);
  }

  /** Rebuild the 3D callout tags from the current hull + fitting. */
  private rebuildCallouts(): void {
    const ship = this.currentShip();
    if (!ship) {
      this.callouts.rebuild([], () => "");
      return;
    }
    const sockets = hardpointsOf(ship);
    const specs: CalloutSpec[] = this.slots.map((slot) => ({
      slot,
      offset: sockets[slot.hardpointIndex]?.transform.pos ?? [0, 0, 0],
    }));
    this.callouts.rebuild(specs, (slot) => {
      const cfg = slot.moduleId ? this.configs.get<ModuleConfig>("module", slot.moduleId) : undefined;
      return cfg?.ui.shortName ?? cfg?.ui.label ?? "Empty";
    });
    this.callouts.setSelected(this.pickerHardpoint);
  }

  private equip(hardpointIndex: number, moduleId: string | null): void {
    const slot = this.slots[hardpointIndex];
    if (!slot) return;
    slot.moduleId = moduleId;
    this.pickerHardpoint = null;
    // Persist immediately: an unsaved edit still flies (owner 2026-07-31), so
    // the working fit must survive walking straight out of the Hangar.
    this.persistSelection();
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

    // Offline test mode: save to localStorage, no server round trip. Also the
    // path taken for a LOCAL fitting the player is updating while signed out.
    if (this.offlineFitting) {
      const saved = saveLocalFitting({
        id: this.selectedFittingId,
        shipId: ship.id,
        name: name.trim(),
        hardpointMap,
      });
      this.selectedFittingId = saved.id;
      this.fittings = listLocalFittings();
      this.error = "";
      this.persistSelection();
      this.render();
      return;
    }

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
    if (isLocalFittingId(this.selectedFittingId)) {
      deleteLocalFitting(this.selectedFittingId);
      this.fittings = listLocalFittings();
      this.loadFitting(null);
      return;
    }
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
    // The WORKING fitting, saved or not: what is in the slots right now is what
    // the player flies next (owner 2026-07-31). Written on every fit change, so
    // simply walking out of the Hangar keeps the loadout on screen.
    if (shipId) {
      localStorage.setItem(LS_MODULES, JSON.stringify({ shipId, moduleIds: fittedModuleIdsOf(this.slots) }));
    } else {
      localStorage.removeItem(LS_MODULES);
    }
  }

  // --- rendering ---------------------------------------------------------

  private render(): void {
    const ship = this.currentShip();
    this.panel.innerHTML = "";
    if (!ship) return;

    // Fitting is always available (offline test mode); only the parts that
    // spend real credits stay gated on a real account.
    const storeLocked = !this.isAuthed();
    const profile = this.auth.getState();
    const credits = profile.status === "authed" ? profile.profile.credits : 0;
    const level = profile.status === "authed" ? profile.profile.level : 1;

    this.panel.append(this.buildHeader());
    if (storeLocked) {
      const hint = el(
        "div",
        "hangar-hint",
        "Offline: fitting and saving work locally. Log in or play as a guest to buy modules and upgrade.",
      );
      this.panel.append(hint);
    }
    if (this.error) this.panel.append(el("div", "hangar-error", this.error));

    this.panel.append(this.buildShipCarousel());
    this.panel.append(this.buildStatPanel(ship));
    this.panel.append(this.buildSlotGrid());
    if (this.pickerHardpoint !== null) {
      this.panel.append(this.buildModulePicker(ship, this.pickerHardpoint, credits, level));
    }
    this.panel.append(this.buildUpgrades(ship, storeLocked, credits));
    this.panel.append(this.buildFittingControls(ship));
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
    wrap.append(statRow("Power rail", `${panel.powerDrawTotal.toFixed(0)} / ${panel.powerCapacity.toFixed(0)}`));
    wrap.append(this.buildBudgetBar("Idle energy budget", panel.energyBudget, panel.idleDrawTotal, panel.capacitorRegen));
    wrap.append(this.buildPowerWarn(panel));
    wrap.append(this.buildHeatWarn(panel));
    return wrap;
  }

  /**
   * The over-subscription notice (owner 2026-07-31). Deliberately a WARNING and
   * not a block: fitting more than the rail can feed is a legitimate choice —
   * carry the heavy shield, run it only when you need it — so this states the
   * consequence rather than refusing the save.
   */
  private buildPowerWarn(panel: HangarStatPanel): HTMLDivElement {
    const row = el("div", "hangar-bar-row");
    if (!panel.powerOverSubscribed) return row;
    const over = panel.powerDrawTotal - panel.powerCapacity;
    row.append(
      el(
        "span",
        "hangar-bar-label warn-text",
        `Power rail over-subscribed by ${over.toFixed(0)} — these modules cannot all be online at once; activating one shuts another down.`,
      ),
    );
    return row;
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

  private buildSlotGrid(): HTMLDivElement {
    const wrap = el("div", "hangar-slots");
    wrap.append(el("div", "hangar-section-title", "Hardpoints & systems"));
    const grid = el("div", "hangar-slot-grid");
    for (const slot of this.slots) {
      const mod = slot.moduleId ? this.configs.get<ModuleConfig>("module", slot.moduleId) : undefined;
      const btn = document.createElement("button");
      btn.className = "hangar-slot" + (slot.moduleId ? " filled" : "") + (this.pickerHardpoint === slot.hardpointIndex ? " open" : "");
      btn.dataset["kind"] = slot.kind;
      btn.disabled = this.busy;
      btn.append(el("span", "hangar-slot-icon", mod?.ui.icon ?? "+"));
      btn.append(el("span", "hangar-slot-label", mod?.ui.label ?? "Empty"));
      btn.append(el("span", "hangar-slot-socket", `${slot.socketId} · ${slot.accepts.join("/")}`));
      btn.addEventListener("click", () => this.selectSlot(slot.hardpointIndex));
      grid.append(btn);
    }
    wrap.append(grid);
    return wrap;
  }

  /**
   * The CONTEXTUAL module list for one slot (owner 2026-07-31): only what this
   * socket accepts, as a rolling list that shows a few entries at a time and
   * scrolls for the rest. Each row carries the numbers that decide the choice
   * (see {@link moduleStats}) and is DRAGGABLE — dropping it on the ship's
   * callout is the primary way to fit it, with the Equip button as the
   * keyboard/tap-friendly equivalent.
   */
  private buildModulePicker(ship: ShipConfig, hardpointIndex: number, credits: number, level: number): HTMLDivElement {
    const slot = this.slots[hardpointIndex];
    const wrap = el("div", "hangar-picker");
    const heading = el("div", "hangar-section-title", `Fit ${slot?.socketId ?? ""}`);
    if (slot) heading.append(el("span", "hangar-picker-kind", slot.kind === "internal" ? "systems bay" : "hardpoint"));
    wrap.append(heading);
    wrap.append(el("div", "hangar-hint hangar-drag-hint", "Drag a module onto the ship, or use Equip."));

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

    // The rolling list itself: a fixed-height scroller so a long candidate list
    // never pushes the rest of the panel off screen.
    const list = el("div", "hangar-picker-list");
    for (const mod of candidates) {
      const owned = this.canEquip(mod.id);
      // Level gates are a progression rule, not an ownership one — offline test
      // mode ignores them too, or half the catalogue would stay unreachable.
      const locked = !this.offlineFitting && mod.requiresLevel > level;
      const fitted = slot?.moduleId === mod.id;

      const row = el("div", `hangar-picker-item${fitted ? " fitted" : ""}`);
      row.dataset["module"] = mod.id;
      // Only something the player can actually equip is worth dragging.
      if (owned && !this.busy) {
        row.draggable = true;
        row.addEventListener("dragstart", (ev) => {
          ev.dataTransfer?.setData("text/plain", mod.id);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
          this.beginDrag(mod.id);
        });
        row.addEventListener("dragend", () => this.endDrag());
      }

      const head = el("div", "hangar-picker-head");
      head.append(el("span", "hangar-picker-name", mod.name ?? mod.id));
      head.append(
        el(
          "span",
          "hangar-picker-meta",
          locked ? `Lv ${mod.requiresLevel}` : this.offlineFitting ? "Offline" : owned ? "Owned" : `${mod.price} cr`,
        ),
      );
      row.append(head);

      const stats = el("div", "hangar-picker-stats");
      for (const stat of moduleStats(mod)) {
        const chip = el("span", "hangar-stat-chip");
        chip.append(el("span", "k", stat.label), el("span", "v", stat.value));
        stats.append(chip);
      }
      row.append(stats);

      const actions = el("div", "hangar-picker-actions");
      if (fitted) {
        actions.append(el("span", "hangar-picker-meta", "Fitted"));
      } else if (owned) {
        const equipBtn = document.createElement("button");
        equipBtn.className = "hangar-btn hangar-btn-primary";
        equipBtn.textContent = "Equip";
        equipBtn.disabled = this.busy;
        equipBtn.addEventListener("click", () => this.equip(hardpointIndex, mod.id));
        actions.append(equipBtn);
      } else if (!locked) {
        const buyBtn = document.createElement("button");
        buyBtn.className = "hangar-btn";
        buyBtn.textContent = mod.price > 0 ? `Buy (${mod.price} cr)` : "Unlock (free)";
        buyBtn.disabled = this.busy || credits < mod.price;
        buyBtn.addEventListener("click", () => void this.buyModule(mod.id));
        actions.append(buyBtn);
      }
      row.append(actions);
      list.append(row);
    }
    wrap.append(list);
    if (candidates.length === 0) {
      wrap.append(el("div", "hangar-hint", `No modules fit this ${slot?.kind === "internal" ? "bay" : "hardpoint"}.`));
    }
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

  private buildFittingControls(ship: ShipConfig): HTMLDivElement {
    const wrap = el("div", "hangar-fit-controls");
    wrap.append(el("div", "hangar-section-title", "Fitting"));

    const select = document.createElement("select");
    select.className = "hangar-select";
    select.disabled = this.busy;
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
    nameInput.disabled = this.busy;
    const current = this.selectedFittingId ? this.fittings.find((f) => f.id === this.selectedFittingId) : undefined;
    nameInput.value = current?.name ?? "";
    wrap.append(nameInput);

    const row = el("div", "hangar-fit-btn-row");
    const saveBtn = document.createElement("button");
    saveBtn.className = "hangar-btn hangar-btn-primary";
    saveBtn.textContent = this.selectedFittingId ? "Update fitting" : "Save new fitting";
    saveBtn.disabled = this.busy;
    saveBtn.addEventListener("click", () => void this.saveFitting(nameInput.value));
    row.append(saveBtn);

    if (this.selectedFittingId) {
      const delBtn = document.createElement("button");
      delBtn.className = "hangar-btn hangar-btn-danger";
      delBtn.textContent = "Delete";
      delBtn.disabled = this.busy;
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
    pitch: 0,
    up: { x: 0, y: 1, z: 0 }, // parked and level; the bubble's vertical axis is unused here
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
/*
 * Split screen (owner 2026-07-31): the ship's 3D stage gets one half, its info
 * and modules the other — STACKED in portrait (stage on top) and SIDE BY SIDE
 * in landscape. The stage half is a transparent hole onto the shared Babylon
 * canvas; \`hangarLayout.stageViewport()\` confines the camera to exactly the
 * same rectangle, so the two must be changed together.
 */
.hangar-overlay {
  position: fixed;
  inset: 0;
  z-index: 15;
  pointer-events: none;
  font-family: system-ui;
  color: #e8f1ff;
  display: flex;
  flex-direction: column; /* portrait: stage above, panel below */
}
/* The stage takes its half of the flex box but never any pointer events —
   orbit and zoom drags belong to the canvas underneath it. */
.hangar-stage {
  flex: 1 1 50%;
  min-height: 0;
  min-width: 0;
  pointer-events: none;
}
.hangar-panel {
  pointer-events: auto;
  flex: 1 1 50%;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  background: rgba(6, 10, 20, 0.94);
  border-top: 1px solid #2f6fb8;
  padding:
    14px
    calc(env(safe-area-inset-right, 0px) + 14px)
    calc(env(safe-area-inset-bottom, 0px) + 14px)
    calc(env(safe-area-inset-left, 0px) + 14px);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* ---- 3D callout tags pinned to each slot on the hull (2026-07-31) ---- */
/* The layer fills the stage half and is click-through; only the tags catch
   pointer events, so orbit drags still reach the canvas between them. */
.hangar-callouts { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.hangar-callout {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 4px;
  max-width: 46%;
  background: rgba(6, 12, 24, .82);
  color: #dce9ff;
  border: 1px solid #2f6fb8;
  border-radius: 999px;
  font: 500 11px/1.1 system-ui, sans-serif;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  transition: border-color .12s linear, background-color .12s linear, opacity .12s linear;
}
.hangar-callout .dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #57d8ff;
  box-shadow: 0 0 6px rgba(87, 216, 255, .8);
}
.hangar-callout.kind-internal .dot { background: #63d2a4; box-shadow: 0 0 6px rgba(99, 210, 164, .8); }
.hangar-callout.empty { opacity: .72; border-style: dashed; }
.hangar-callout.empty .dot { background: #6f84a0; box-shadow: none; }
.hangar-callout.selected { border-color: #57d8ff; background: rgba(28, 58, 94, .95); }
.hangar-callout:hover { border-color: #57d8ff; }
/* While a module is being dragged, light up the slots that would take it. */
.hangar-callout.droppable { border-color: #5fe08c; box-shadow: 0 0 0 2px rgba(95, 224, 140, .25); }
.hangar-callout.dimmed { opacity: .3; }
.hangar-callout.drop-hover { background: rgba(95, 224, 140, .28); border-color: #5fe08c; }

/* Landscape: the same halves, laid out left (stage) / right (panel). */
@media (orientation: landscape) {
  .hangar-overlay { flex-direction: row; }
  .hangar-panel {
    border-top: none;
    border-left: 1px solid #2f6fb8;
    padding-top: calc(env(safe-area-inset-top, 0px) + 14px);
  }
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
/* Systems-bay slots read green, matching their callouts on the hull. */
.hangar-slot[data-kind="internal"] { border-color: #2f7d5e; }
.hangar-slot[data-kind="internal"].filled { border-color: #63d2a4; }
.hangar-picker { display: flex; flex-direction: column; gap: 6px; background: #0c1526; border: 1px solid #2f6fb8; border-radius: 6px; padding: 8px; }
.hangar-picker-kind { margin-left: 8px; color: #6f84a0; text-transform: none; letter-spacing: 0; }
.hangar-drag-hint { font-size: 10.5px; }
/*
 * Rolling list: a fixed-height scroller showing ~3-4 rows at a time, so a long
 * candidate list scrolls INSIDE the picker instead of pushing the stat panel
 * and fitting controls off the screen.
 */
.hangar-picker-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 232px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-right: 2px;
}
.hangar-picker-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 8px;
  font-size: 12px;
  background: #12203a;
  border: 1px solid #23456f;
  border-radius: 6px;
}
.hangar-picker-item[draggable="true"] { cursor: grab; }
.hangar-picker-item[draggable="true"]:active { cursor: grabbing; }
.hangar-picker-item.fitted { border-color: #57d8ff; }
.hangar-picker-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.hangar-picker-name { font-weight: 600; }
.hangar-picker-meta { color: #9fb4d0; font-size: 11px; white-space: nowrap; }
.hangar-picker-stats { display: flex; flex-wrap: wrap; gap: 4px; }
.hangar-stat-chip {
  display: inline-flex;
  gap: 4px;
  padding: 1px 6px;
  font-size: 10.5px;
  background: rgba(87, 216, 255, .09);
  border-radius: 999px;
}
.hangar-stat-chip .k { color: #8ba3c4; }
.hangar-stat-chip .v { color: #e8f1ff; font-variant-numeric: tabular-nums; }
.hangar-picker-actions { display: flex; justify-content: flex-end; }
.hangar-picker-actions:empty { display: none; }
/* Landscape phones have little height: show fewer rows before scrolling. */
@media (orientation: landscape) and (max-height: 520px) {
  .hangar-picker-list { max-height: 168px; }
}
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
