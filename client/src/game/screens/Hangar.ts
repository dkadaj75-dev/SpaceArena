import {
  Color3,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type InstancedMesh,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  type ConfigService,
  type ModuleConfig,
  type ModuleSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type ThemeConfig,
  type UpgradeConfig,
  type UpgradeLevels,
  type UpgradeTrackName,
} from "@space-arena/shared";
import { AssetRegistry } from "../../core/AssetRegistry.js";
import type { AuthService } from "../../core/AuthService.js";
import { HangarApi, HangarApiError, HangarRefreshScope, type ApiFitting, type ApiModule, type ApiShip } from "../HangarApi.js";
import {
  buildHardpointMap,
  fittedModuleIdsOf,
  slotAccepts,
  slotsFromDefaultFitting,
  slotsFromHardpointMap,
  slotsFromModuleIds,
  type HangarSlot,
} from "../hangarFitting.js";
import { computeStatPanel, type HangarStatPanel } from "../hangarStats.js";
import { buildOverlayModel, type HangarGauge } from "../hangarOverlayModel.js";
import {
  deleteLocalFitting,
  isLocalFittingId,
  listLocalFittings,
  saveLocalFitting,
} from "../offlineFittings.js";
import { moduleStats } from "../moduleSummary.js";
import { buyModuleLocal, buyShipLocal, ownsModule, ownsShip, STARTER_SHIP_ID } from "../offlineOwnership.js";
import { SwipeWatcher, wrapIndex } from "../hangarSwipe.js";
import { HangarBay } from "./HangarBay.js";
import { swapFrame, SWAP_DISTANCE_RADII, SWAP_DURATION_SEC } from "../shipSwap.js";
import { juiceSettingsOf } from "../juice/juiceSettings.js";
import { moduleIconId, moduleIconSvg } from "../hud/moduleIcons.js";
import { framingRadius, stageAspect, stageViewport } from "../hangarLayout.js";
import { ShipSocketRig, type ParticleQuality } from "../ShipSocketRig.js";
import type { TacticalCamera } from "../TacticalCamera.js";

const log = createLogger("Hangar");

/**
 * The MAIN loadout (owner 2026-07-31): the ship, the fitting and the working
 * module list the player actually takes into a match. Browsing the hangar does
 * NOT touch it — you can swipe through every hull in the bay without losing
 * what you fly. It changes only when the player sets a new main, or when they
 * edit the fit of the hull that already is one.
 */
const LS_SHIP = "hangar.shipId";
const LS_FITTING = "hangar.fittingId";
/** Where the carousel was left last time. Presentation only — never flown. */
const LS_BROWSE = "hangar.browseShipId";
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
const THEME_ID = "theme.default";
const STAGE_POS = new Vector3(0, 5, 300); // far from the arena (radius 90) — nothing else renders out here
const UPGRADE_TRACKS: readonly UpgradeTrackName[] = ["hull", "engine", "energy", "heat"];
const UPGRADE_LABELS: Record<UpgradeTrackName, string> = { hull: "Hull", engine: "Engine", energy: "Capacitor", heat: "Heat Sink" };

/** Which outfitting bay the panel is showing (owner 2026-07-31). */
type HangarCategory = "hardpoints" | "internals" | "ship" | "fitting";

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

/**
 * The player's MAIN loadout — Lobby passes this as NetGameSession join options
 * and the offline match spawns from it. Falls back to the starter hull so a
 * pilot who has never opened the Hangar still launches with a real ship.
 */
export function loadHangarSelection(): HangarSelection {
  const shipId = localStorage.getItem(LS_SHIP) ?? STARTER_SHIP_ID;
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
  private readonly refreshScope = new HangarRefreshScope();
  private visitToken = 0;
  /** Bumped whenever the player changes the hull or working fitting. */
  private fittingContextToken = 0;
  private disposed = false;

  private ships: ShipConfig[] = [];
  private shipIndex = 0;
  private apiShips: ApiShip[] = [];
  private apiModules: ApiModule[] = [];
  private fittings: ApiFitting[] = [];
  private selectedFittingId: string | null = null;
  private slots: HangarSlot[] = [];
  private pickerHardpoint: number | null = null;
  private category: HangarCategory = "hardpoints";
  private busy = false;
  private error = "";

  private previewInstance: InstancedMesh | null = null;
  /** Hull ids whose GLB has already been requested (see `rebuildPreview`). */
  private readonly modelsRequested = new Set<string>();
  /** The bay the ship is parked in — built with the screen, sized to the hull. */
  private bay: HangarBay | null = null;
  private bayRadius = 0;
  /**
   * The node the preview hull hangs off, so a swap can slide the SHIP without
   * moving the bay it is parked in.
   */
  private readonly shipPivot: TransformNode;
  /** In-flight ship-swap transition, or null when the bay is at rest. */
  private swap: { direction: -1 | 1; elapsed: number; distance: number; applied: boolean } | null = null;
  /** Stage-overlay arrows, kept so they can be disabled mid-transition. */
  private stageArrows: HTMLButtonElement[] = [];
  /**
   * The characteristics block over the 3D stage. Built once and refreshed in
   * place: `render()` wipes the info panel wholesale, and this lives in the
   * other half of the split.
   */
  private readonly gauges: HTMLDivElement;
  /**
   * The module the player is CONSIDERING but has not equipped — the hover /
   * keyboard focus / tapped row in the picker, or the "remove" affordance
   * (`moduleId: null`). Drives the ghost levels on {@link gauges}; cleared by
   * every `render()`, since that rebuilds the picker the hover belongs to.
   */
  private preview: { hardpointIndex: number; moduleId: string | null } | null = null;
  /**
   * True when {@link preview} was PINNED by a tap/click rather than merely
   * hovered. A touch pointer has no hover to hold, so the tap is what keeps the
   * ghost on screen long enough to read it.
   */
  private previewPinned = false;
  /** Blacked-out stand-in shown in place of a hull the player does not own. */
  private lockedPreview: AbstractMesh | null = null;
  private lockedMaterial: StandardMaterial | null = null;
  private swipe: SwipeWatcher | null = null;
  private previewRig: ShipSocketRig | null = null;
  private idleModules: ModuleSnapshot[] = [];
  private readonly idlePrev: ShipSnapshot;
  private readonly idleCur: ShipSnapshot;
  private previewClock = 0;
  private renderObserver: Observer<Scene> | null = null;

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
    this.shipPivot = new TransformNode("hangarShipPivot", scene);
    this.shipPivot.parent = this.stageRoot;

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
    // Stylised arrows OVER the 3D stage: the primary way to walk the bay on a
    // pointer, and the visible twin of the swipe gesture. They live in the stage
    // half (which is otherwise click-through) and re-enable themselves when a
    // transition finishes.
    this.stageArrows = [this.buildStageArrow(-1), this.buildStageArrow(1)];
    // The characteristics block sits in the same click-through half, anchored to
    // a corner so it never covers the hull. `pointer-events: none` (CSS) is what
    // keeps orbit/zoom drags reaching the canvas through it — unlike the arrows,
    // it has nothing to click.
    this.gauges = el("div", "hangar-gauges");
    this.stage.append(this.gauges, ...this.stageArrows);
    parent.append(this.root);

    this.ships = [...this.configs.getAll<ShipConfig>("ship")].sort((a, b) => a.id.localeCompare(b.id));

    this.unsubscribeAuth = this.auth.onChange(() => {
      if (this.root.style.display !== "none") void this.refreshFromServer();
    });

    this.root.style.display = "none";
  }

  /** One stage-overlay arrow. `delta` is the direction it walks the bay. */
  private buildStageArrow(delta: -1 | 1): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = `hangar-stage-arrow ${delta < 0 ? "prev" : "next"}`;
    btn.type = "button";
    btn.setAttribute("aria-label", delta < 0 ? "Previous ship" : "Next ship");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      (delta < 0 ? '<path d="M15 4 L7 12 L15 20" />' : '<path d="M9 4 L17 12 L9 20" />') +
      "</svg>";
    btn.addEventListener("click", () => this.stepShip(delta));
    return btn;
  }

  private isAuthed(): boolean {
    return this.auth.getState().status === "authed";
  }

  private get isVisible(): boolean {
    return !this.disposed && this.root.style.display !== "none";
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

  /**
   * Whether this module can be fitted right now. Ownership is REAL in offline
   * mode too (owner 2026-07-31) — the prices are zero for testing, but a module
   * still has to be bought before it can be fitted, so the unlock flow is the
   * one we will ship rather than one we bolt on later.
   */
  private canEquip(moduleId: string): boolean {
    if (this.offlineFitting) return ownsModule(this.configs, moduleId);
    return this.apiModules.find((m) => m.id === moduleId)?.owned ?? false;
  }

  /**
   * Whether this hull can be flown. Hull ownership currently exists only in the
   * local ledger — `/api/ships` returns the whole catalogue with no `owned`
   * flag — so an authenticated session sees every hull unlocked until the
   * server grows the same notion.
   */
  private canFly(shipId: string): boolean {
    return this.offlineFitting ? ownsShip(shipId) : true;
  }

  /** The hull the player takes into a match, as last set. */
  private mainShipId(): string | null {
    return localStorage.getItem(LS_SHIP);
  }

  private isMainShip(shipId: string): boolean {
    return this.mainShipId() === shipId;
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
    // Re-entry safe: the per-visit subscriptions below are all torn down in
    // `hide()`, but the Hangar is reachable from the results screen as well as
    // the Lobby, so a second `show()` without an intervening `hide()` must not
    // stack a second render observer / swipe watcher on the same screen.
    this.releaseVisitBindings();
    this.refreshScope.invalidate();
    const visitToken = ++this.visitToken;
    this.resetIdlePreview();
    // A pilot who has never set a main gets one now, so "what do I fly" is
    // never an unanswered question after the first visit to the bay.
    if (!this.mainShipId()) {
      const starter = this.ships.find((s) => s.id === STARTER_SHIP_ID) ?? this.ships[0];
      if (starter) localStorage.setItem(LS_SHIP, starter.id);
    }
    const stored = loadHangarSelection();
    // Open where the player left the carousel; the main hull is the fallback.
    const browseId = localStorage.getItem(LS_BROWSE) ?? stored.shipId;
    const idx = browseId ? this.ships.findIndex((s) => s.id === browseId) : -1;
    this.shipIndex = idx >= 0 ? idx : 0;
    this.selectedFittingId = null;
    const fittingContextToken = ++this.fittingContextToken;
    this.pickerHardpoint = null;
    this.category = "hardpoints";
    this.error = "";

    const ship = this.currentShip();
    // On your MAIN hull, open on the loadout you actually fly — not its stock fit.
    this.slots = ship ? this.slotsForShip(ship) : [];

    this.root.style.display = "flex";
    this.camera.setHangarMode(true);
    // ENTRY resets the view (owner report 2026-08-01: a hull framed from an odd
    // angle after a match). The rig is shared with the in-match chase camera,
    // which leaves both its orbit angles AND a rolled `upVector` behind, so the
    // reset has to level the rig — not merely re-assign alpha/beta. Everything
    // after this point (`frameShip`, the ship-swap re-frame) deliberately keeps
    // whatever the player has orbited to; only entering the Hangar snaps back.
    this.camera.resetStageOrbit(this.stageRoot.position);
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => this.tickPreview());
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("orientationchange", this.onViewportResize);
    // Swipe the STAGE to change hull. Bound to the whole overlay because the
    // stage half is pointer-events:none (the orbit camera owns those events);
    // the watcher only observes, so orbiting still works.
    this.swipe = new SwipeWatcher(this.root, {
      onSwipe: (dir) => this.stepShip(dir),
      // Only gestures that begin over the STAGE count: a horizontal flick
      // inside the info panel belongs to whatever list it started on.
      shouldTrack: (ev) => !(ev.target instanceof Node) || !this.panel.contains(ev.target),
    });

    this.rebuildPreview();
    this.render();
    this.applyStageViewport();

    const storedShipId = ship?.id;
    void this.refreshFromServer().then((applied) => {
      if (applied && this.isVisible && this.visitToken === visitToken && this.fittingContextToken === fittingContextToken && this.currentShip()?.id === storedShipId && stored.fittingId && this.fittings.some((f) => f.id === stored.fittingId && f.ship_id === storedShipId)) {
        this.loadFitting(stored.fittingId);
      }
    });
  }

  /**
   * Drop everything bound for the duration of ONE visit (per-frame observer,
   * window listeners, swipe watcher). Shared by `hide()` and the re-entry guard
   * in `show()` so the two can never disagree about what a visit owns.
   */
  private releaseVisitBindings(): void {
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("orientationchange", this.onViewportResize);
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.swipe?.dispose();
    this.swipe = null;
  }

  hide(): void {
    this.refreshScope.invalidate();
    this.visitToken++;
    this.root.style.display = "none";
    this.releaseVisitBindings();
    // Hand the whole canvas back — a match must never render into half of it.
    this.camera.setStageViewport(null);
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
    this.lockedPreview?.dispose(false, false);
    this.lockedPreview = null;
    this.bay?.dispose();
    this.bay = null;
    this.bayRadius = 0;
  }

  private async refreshFromServer(): Promise<boolean> {
    const request = this.refreshScope.begin();
    if (!this.isAuthed()) {
      if (!this.refreshScope.isCurrent(request.token, request.signal) || !this.isVisible) return false;
      this.apiShips = [];
      this.apiModules = [];
      // Offline test mode: named fittings come from localStorage instead.
      this.fittings = listLocalFittings();
      this.busy = false;
      this.render();
      return true;
    }
    this.busy = true;
    if (this.isVisible) this.render();
    try {
      const [shipsRes, modulesRes, fittingsRes] = await Promise.all([this.api.ships(request.signal), this.api.modules(request.signal), this.api.fittings(request.signal)]);
      if (!this.refreshScope.isCurrent(request.token, request.signal) || !this.isVisible) return false;
      this.apiShips = shipsRes.ships;
      this.apiModules = modulesRes.modules;
      this.fittings = fittingsRes.fittings;
      this.error = "";
      // Freshly-read upgrade levels: re-cache them for the match predictor, or
      // a purchase made this visit would stay invisible to it until the player
      // happened to re-pick a ship.
      this.persistSelection();
      return true;
    } catch (err) {
      if (!this.refreshScope.isCurrent(request.token, request.signal) || isAbortError(err)) return false;
      this.error = errorMessage(err, "Failed to load hangar data");
      log.warn("refreshFromServer failed", err);
      return false;
    } finally {
      // No `return` in a finally: it would override the try/catch's result.
      if (this.refreshScope.isCurrent(request.token, request.signal) && this.isVisible) {
        this.busy = false;
        this.render();
      }
    }
  }

  // --- 3D preview -----------------------------------------------------------

  private rebuildPreview(): void {
    this.resetIdlePreview();
    this.previewRig?.dispose();
    this.previewRig = null;
    this.previewInstance?.dispose();
    this.previewInstance = null;
    this.lockedPreview?.dispose(false, false);
    this.lockedPreview = null;

    const ship = this.currentShip();
    if (!ship) return;

    // The hull's GLB has to be FETCHED before `getShipMaster` can hand it back;
    // without this the Hangar always fell through to the procedural stand-in and
    // showed a box (owner report 2026-07-31). The match path preloads models
    // before it spawns anything — this screen has to do the same for itself.
    // The stale-guard is the ship id: a player swiping through the bay can
    // easily change hull before a load lands.
    // Requested ONCE per hull: `ensureModel` resolves immediately once the model
    // is cached, so re-requesting on every rebuild would loop forever.
    const loadingFor = ship.id;
    if (!this.modelsRequested.has(loadingFor)) {
      this.modelsRequested.add(loadingFor);
      void this.assets.ensureModel(ship.render).then((loaded) => {
        if (!loaded) {
          this.modelsRequested.delete(loadingFor);
          return; // no model authored, or the fetch failed: keep the stand-in
        }
        if (this.currentShip()?.id !== loadingFor) return;
        if (this.root.style.display === "none") return;
        this.rebuildPreview();
        this.frameShip(stageAspect(window.innerWidth || 1, window.innerHeight || 1));
      });
    }

    const master = this.assets.getShipMaster(ship.render);

    // A hull the player has not bought is shown as a SILHOUETTE (2026-07-31):
    // black and half-transparent, so its shape reads while its detail stays
    // something to unlock. Cloned rather than instanced because an instance
    // shares the master's material and would black out every ship in the bay.
    if (!this.canFly(ship.id)) {
      const clone = master.clone(`hangarLocked.${ship.id}`, this.shipPivot);
      if (clone) {
        clone.isPickable = false;
        clone.position.setAll(0);
        clone.setEnabled(true);
        const mat = this.lockedShipMaterial();
        for (const mesh of [clone, ...clone.getChildMeshes(false)]) mesh.material = mat;
        this.lockedPreview = clone;
      }
      // No socket rig and no idle modules: there is no fitting to show yet.
      this.idleModules = [];
      return;
    }

    const instance = master.createInstance(`hangarPreview.${ship.id}`);
    instance.isPickable = false;
    instance.parent = this.shipPivot;
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
      // The THEME's juice, not the library defaults (owner report 2026-08-01:
      // "remove these weird cubes"). The shipped theme sets
      // `juice.deploy.showMeshes: false` because the module models are still
      // placeholders — a rig built on the defaults ignores that and parks white
      // boxes on the hull. The match path has always passed this; this screen
      // was the one place that did not.
      juiceSettingsOf(this.configs.get<ThemeConfig>("theme", THEME_ID)),
    );
    this.idleModules = this.slots
      .filter((s): s is HangarSlot & { moduleId: string } => s.moduleId !== null)
      .map((s) => ({ moduleId: s.moduleId, hardpointIndex: s.hardpointIndex, state: "active", heat: 0, stateTimer: 0, cycleTimer: 0, channeling: false, shieldPool: 0 }) satisfies ModuleSnapshot);
  }

  /**
   * (Re)build the bay around a hull of `hullRadius`. Rebuilt rather than scaled
   * because the walls, pillars and lamp ranges are all derived from the pad
   * size — a light hull and a heavy one want a differently proportioned room,
   * not the same room stretched.
   */
  private rebuildBay(hullRadius: number): void {
    const padRadius = Math.max(4, hullRadius * 2.1);
    if (this.bay && Math.abs(this.bayRadius - padRadius) < 0.01) return;
    this.bay?.dispose();
    this.bayRadius = padRadius;
    this.bay = new HangarBay(this.scene, this.stageRoot, { padRadius });
  }

  /** The shared black translucent material every locked hull is painted with. */
  private lockedShipMaterial(): StandardMaterial {
    if (this.lockedMaterial) return this.lockedMaterial;
    const mat = new StandardMaterial("hangarLockedShip", this.scene);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(0.02, 0.03, 0.05); // just enough not to be a hole
    mat.alpha = 0.45;
    mat.backFaceCulling = false; // a translucent hull reads better with its far side
    this.lockedMaterial = mat;
    return mat;
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
    const instance: AbstractMesh | null = this.previewInstance ?? this.lockedPreview;
    if (!instance) {
      this.focus.copyFrom(this.stageRoot.position);
      return;
    }
    instance.computeWorldMatrix(true);
    const bounds = instance.getBoundingInfo().boundingSphere;
    // Centre on where the hull SITS, not where a swap has slid it to — otherwise
    // re-framing mid-transition would drag the camera along with the animation.
    this.focus.copyFrom(bounds.centerWorld).subtractInPlace(this.shipPivot.position);
    this.rebuildBay(bounds.radius);
    const radius = framingRadius(bounds.radiusWorld, this.camera.camera.fov, aspect);
    this.camera.setStageRadiusRange(radius * 0.35, radius * 2.5);
    this.camera.stageAt(this.focus, radius, this.camera.camera.alpha, this.camera.camera.beta);
  }

  private tickPreview(): void {
    // The orbit centre IS the hull's geometric centre (owner 2026-07-31): hold
    // it every frame so a stray pan gesture cannot drift the ship off its own
    // pivot. Orbit angle and zoom stay entirely the player's.
    this.camera.camera.target.copyFrom(this.focus);
    this.tickSwap(this.scene.getEngine().getDeltaTime() / 1000);

    if (!this.previewRig) return;
    const dtMs = this.scene.getEngine().getDeltaTime();
    this.previewClock += dtMs / 1000;
    const wave = Math.sin(this.previewClock * 0.6);

    this.idlePrev.pos.x = this.idleCur.pos.x;
    this.idlePrev.pos.z = this.idleCur.pos.z;
    this.idleCur.pos.x = wave * 0.35;
    this.idleCur.modules = this.idleModules;
    this.idlePrev.modules = this.idleModules;

    this.previewRig.updateModules(this.idleCur.modules);
    this.previewRig.updateEmitters(this.idleCur, this.idlePrev, performance.now());
  }

  private resetIdlePreview(): void {
    this.previewClock = 0;
    Object.assign(this.idlePrev, idleSnapshot());
    Object.assign(this.idleCur, idleSnapshot());
  }

  // --- state transitions -----------------------------------------------------

  /**
   * The slot grid to open a hull on: the loadout you fly if this is your MAIN,
   * its stock fitting otherwise. Browsing another hull must never inherit the
   * main's modules — they belong to different sockets.
   */
  private slotsForShip(ship: ShipConfig): HangarSlot[] {
    if (!this.isMainShip(ship.id)) return slotsFromDefaultFitting(ship);
    const stored = loadHangarSelection();
    return stored.moduleIds ? slotsFromModuleIds(ship, stored.moduleIds) : slotsFromDefaultFitting(ship);
  }

  private selectShip(index: number): void {
    this.shipIndex = index;
    this.selectedFittingId = null;
    this.fittingContextToken++;
    this.pickerHardpoint = null;
    const ship = this.currentShip();
    this.slots = ship ? this.slotsForShip(ship) : [];
    // Browsing is NOT choosing (2026-07-31): remember where the carousel is,
    // but leave the main loadout exactly as it was.
    this.persistBrowse();
    this.rebuildPreview();
    // A different hull is a different size: re-frame it. (Swapping a MODULE
    // deliberately does not, so an edit never yanks the player's zoom back.)
    this.frameShip(stageAspect(window.innerWidth || 1, window.innerHeight || 1));
    this.render();
  }

  /**
   * Step through the bay, wrapping at both ends. The hull on screen SLIDES out
   * opposite the arrow and the next one slides in behind it (see `shipSwap.ts`);
   * the actual model swap happens at the midpoint, hidden by the motion.
   *
   * A step during a transition is ignored rather than queued: a mashed arrow
   * should not spool up four animations the player then has to sit through.
   */
  private stepShip(delta: -1 | 1): void {
    if (this.ships.length < 2 || this.busy || this.swap) return;
    const bounds = this.previewInstance?.getBoundingInfo().boundingSphere;
    const distance = Math.max(4, (bounds?.radiusWorld ?? 3) * SWAP_DISTANCE_RADII);
    this.swap = { direction: delta, elapsed: 0, distance, applied: false };
    this.setArrowsEnabled(false);
  }

  /** Advance an in-flight swap; called from the per-frame preview tick. */
  private tickSwap(dtSec: number): void {
    const swap = this.swap;
    if (!swap) return;
    swap.elapsed += dtSec;
    const frame = swapFrame(swap.elapsed, swap.direction, swap.distance, SWAP_DURATION_SEC);

    // Slide along the CAMERA's right axis, so "out to the left" means left on
    // screen whatever angle the player has orbited to.
    const right = this.camera.camera.getDirection(Vector3.Right());
    right.y = 0;
    if (right.lengthSquared() > 1e-6) right.normalize();
    else right.set(1, 0, 0);
    this.shipPivot.position.set(right.x * frame.offset, 0, right.z * frame.offset);
    this.setPreviewVisibility(frame.visibility);

    // Midpoint: the hull is off screen, so this is where the swap is invisible.
    if (frame.swapped && !swap.applied) {
      swap.applied = true;
      this.selectShip(wrapIndex(this.shipIndex, swap.direction, this.ships.length));
      // The hull that just arrived is still off screen; keep it faded until the
      // second half of the slide brings it in.
      this.setPreviewVisibility(frame.visibility);
    }
    if (frame.done) {
      this.swap = null;
      this.shipPivot.position.setAll(0);
      this.setPreviewVisibility(1);
      this.setArrowsEnabled(true);
    }
  }

  private setPreviewVisibility(v: number): void {
    if (this.previewInstance) this.previewInstance.visibility = v;
    if (this.lockedPreview) this.lockedPreview.visibility = v;
  }

  private setArrowsEnabled(enabled: boolean): void {
    for (const btn of this.stageArrows) btn.disabled = !enabled || this.busy || this.ships.length < 2;
  }

  /**
   * Make the hull and fitting on screen the one the player flies. The single
   * point at which browsing turns into a decision — everything else in the
   * Hangar leaves the main loadout alone.
   */
  private setAsMain(): void {
    const ship = this.currentShip();
    if (!ship || !this.canFly(ship.id)) return;
    localStorage.setItem(LS_SHIP, ship.id);
    this.persistMain();
    this.render();
  }

  /** Buy the hull on screen. Free for now — the unlock step is what is real. */
  private buyShip(shipId: string): void {
    if (this.offlineFitting) {
      buyShipLocal(shipId);
      this.rebuildPreview();
      this.frameShip(stageAspect(window.innerWidth || 1, window.innerHeight || 1));
      this.render();
    }
  }

  private loadFitting(fittingId: string | null): void {
    const ship = this.currentShip();
    if (!ship) return;
    this.selectedFittingId = fittingId;
    this.fittingContextToken++;
    const fitting = fittingId ? this.fittings.find((f) => f.id === fittingId) : undefined;
    this.slots = fitting ? slotsFromHardpointMap(ship, fitting.hardpointMap) : slotsFromDefaultFitting(ship);
    this.pickerHardpoint = null;
    this.persistSelection();
    this.rebuildPreview();
    this.render();
  }

  private selectSlot(hardpointIndex: number): void {
    // A callout on the hull can address a bay the rail is not currently showing;
    // follow it, or the module list would open under the wrong heading.
    const kind = this.slots[hardpointIndex]?.kind;
    if (kind) this.category = kind === "internal" ? "internals" : "hardpoints";
    this.pickerHardpoint = this.pickerHardpoint === hardpointIndex ? null : hardpointIndex;
    this.render();
  }

  private equip(hardpointIndex: number, moduleId: string | null): void {
    const slot = this.slots[hardpointIndex];
    if (!slot) return;
    slot.moduleId = moduleId;
    this.fittingContextToken++;
    this.pickerHardpoint = null;
    // Persist immediately: an unsaved edit still flies (owner 2026-07-31), so
    // the working fit must survive walking straight out of the Hangar.
    this.persistSelection();
    this.rebuildPreview();
    this.render();
  }

  private async buyModule(moduleId: string): Promise<void> {
    // Offline: the unlock is local and free, but it IS an unlock — a module has
    // to be bought before it can be fitted (owner 2026-07-31).
    if (this.offlineFitting) {
      buyModuleLocal(moduleId);
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    try {
      await this.api.buyModule(moduleId);
      await this.auth.refreshProfile();
      await this.refreshFromServer();
    } catch (err) {
      if (!this.isVisible) return;
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
      if (!this.isVisible) return;
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
      if (!this.isVisible) return;
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
      if (!this.isVisible) return;
      this.error = errorMessage(err, "Delete failed");
      this.busy = false;
      this.render();
    }
  }

  /** Remember where the carousel is. Presentation only — never flown. */
  private persistBrowse(): void {
    const shipId = this.currentShip()?.id;
    if (shipId) localStorage.setItem(LS_BROWSE, shipId);
    else localStorage.removeItem(LS_BROWSE);
  }

  /**
   * Write the MAIN loadout from what is on screen — but ONLY when the hull on
   * screen already is the main one. That is what lets a player swipe through
   * the whole bay, and edit a fit they are just looking at, without silently
   * changing what they launch with; `setAsMain` is the one place that promotes
   * a different hull.
   */
  private persistSelection(): void {
    this.persistBrowse();
    const ship = this.currentShip();
    if (!ship || !this.isMainShip(ship.id)) return;
    this.persistMain();
  }

  private persistMain(): void {
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

  // --- stage overlay (ship characteristics) --------------------------------

  /**
   * Start showing what a module WOULD do, without fitting it. Called from every
   * "the player is considering this" signal in the picker — pointer hover,
   * keyboard focus, and the tap that pins it — plus the remove affordance, which
   * considers `null` (the slot emptied).
   *
   * Cheap enough to run on hover: it re-resolves two stat panels and rewrites a
   * dozen spans, and it deliberately does NOT call `render()`, which would
   * rebuild the very row the pointer is on.
   */
  private considerModule(hardpointIndex: number, moduleId: string | null, pinned = false): void {
    const same = this.preview?.hardpointIndex === hardpointIndex && this.preview.moduleId === moduleId;
    // Moving on to a DIFFERENT candidate takes the pin with it — a pin holds one
    // module's ghost on screen, it does not freeze the gauges on the first one.
    const nextPinned = same ? this.previewPinned || pinned : pinned;
    if (same && nextPinned === this.previewPinned) return;
    this.preview = { hardpointIndex, moduleId };
    this.previewPinned = nextPinned;
    this.renderGauges();
    this.syncPreviewHighlight();
  }

  /**
   * Stop considering `moduleId` — the pointer left, or focus moved on. A PINNED
   * preview survives: on a touch screen the tap that pinned it is immediately
   * followed by the pointer leaving, and the whole point of the pin is to keep
   * the ghost readable after that.
   */
  private stopConsidering(hardpointIndex: number, moduleId: string | null): void {
    if (this.previewPinned) return;
    if (this.preview?.hardpointIndex !== hardpointIndex || this.preview.moduleId !== moduleId) return;
    this.clearPreview();
  }

  private clearPreview(): void {
    if (!this.preview && !this.previewPinned) return;
    this.preview = null;
    this.previewPinned = false;
    this.renderGauges();
    this.syncPreviewHighlight();
  }

  /**
   * Wire every "considering this module" signal an element can raise onto the
   * stage gauges. One place, so a pointer, a keyboard and a touch screen all
   * reach the same preview:
   *
   *  - `pointerenter`/`pointerleave` — the mouse hover;
   *  - `focusin`/`focusout` — keyboard tabbing (the picker's buttons are inside
   *    the row, and both events bubble, so focusing Equip previews its row);
   *  - `click` — a TAP pins the preview, because a touch pointer leaves the row
   *    the instant the finger lifts and would otherwise flash the ghost.
   *
   * A click on a button inside the row is left alone: that button already does
   * the real thing (equip/buy), and `equip()` re-renders, which clears the ghost.
   */
  private bindPreviewSignals(
    node: HTMLElement,
    hardpointIndex: number,
    moduleId: string | null,
    opts: { pinOnClick: boolean },
  ): void {
    node.addEventListener("pointerenter", () => this.considerModule(hardpointIndex, moduleId));
    node.addEventListener("pointerleave", () => this.stopConsidering(hardpointIndex, moduleId));
    node.addEventListener("focusin", () => this.considerModule(hardpointIndex, moduleId));
    node.addEventListener("focusout", () => this.stopConsidering(hardpointIndex, moduleId));
    if (!opts.pinOnClick) return;
    node.addEventListener("click", (ev) => {
      if (ev.target instanceof Element && ev.target.closest("button")) return;
      this.togglePreviewPin(hardpointIndex, moduleId);
    });
  }

  /** Tap/click on a picker row: pin the preview, or unpin the one already pinned. */
  private togglePreviewPin(hardpointIndex: number, moduleId: string | null): void {
    const same = this.preview?.hardpointIndex === hardpointIndex && this.preview.moduleId === moduleId;
    if (same && this.previewPinned) {
      this.clearPreview();
      return;
    }
    this.considerModule(hardpointIndex, moduleId, true);
  }

  /**
   * Mark the row the ghost belongs to, without re-rendering the list — a
   * rebuild here would destroy the element the pointer is hovering. Candidates
   * tag themselves with `data-preview-module` (empty string = "empty the slot").
   */
  private syncPreviewHighlight(): void {
    const wanted: string | null | undefined = this.preview ? this.preview.moduleId : undefined;
    for (const node of this.panel.querySelectorAll<HTMLElement>("[data-preview-module]")) {
      const raw = node.dataset["previewModule"] ?? "";
      const id: string | null = raw === "" ? null : raw;
      node.classList.toggle("considering", wanted !== undefined && id === wanted);
    }
  }

  /**
   * The fit the preview would produce: the working fitting with the candidate
   * dropped into its slot — which also REMOVES whatever was in there, so
   * swapping a module is costed as the swap it is. Null when nothing is being
   * considered, or when the candidate is already in that slot (no ghost to draw).
   */
  private previewModuleIds(): (string | null)[] | null {
    const preview = this.preview;
    if (!preview) return null;
    const ids = fittedModuleIdsOf(this.slots);
    if (preview.hardpointIndex < 0 || preview.hardpointIndex >= ids.length) return null;
    if (ids[preview.hardpointIndex] === preview.moduleId) return null;
    ids[preview.hardpointIndex] = preview.moduleId;
    return ids;
  }

  private statPanelFor(fittedModuleIds: readonly (string | null)[]): HangarStatPanel | null {
    const ship = this.currentShip();
    if (!ship) return null;
    return computeStatPanel(ship, this.configs, { upgradeLevels: this.currentUpgradeLevels(), fittedModuleIds });
  }

  /**
   * The characteristics block over the 3D stage (owner 2026-08-01) — the
   * PRIMARY power/fit signal, in the half of the screen the player is looking at
   * while they judge a hull. Gauges read the current fit; while a module is
   * being considered they grow a ghost segment out to the projected value, so
   * "what does this cost me" is answered before the module is equipped.
   */
  private renderGauges(): void {
    const base = this.statPanelFor(fittedModuleIdsOf(this.slots));
    this.gauges.innerHTML = "";
    if (!base) {
      this.gauges.style.display = "none";
      return;
    }
    this.gauges.style.display = "";
    const previewIds = this.previewModuleIds();
    const model = buildOverlayModel(base, previewIds ? this.statPanelFor(previewIds) : null);
    this.gauges.classList.toggle("previewing", model.previewing);

    const head = el("div", "hangar-gauges-head");
    head.append(el("span", "hangar-gauges-title", "Characteristics"));
    if (model.previewing) head.append(el("span", "hangar-gauges-preview", "Preview"));
    this.gauges.append(head);

    for (const gauge of model.gauges) this.gauges.append(gaugeRow(gauge));

    // The rail is the one gauge a fit can outright break, so it gets words as
    // well as a colour — for the fit on the ship, or for the one being weighed.
    const over = model.previewing ? model.projectedPowerOverBy : model.powerOverBy;
    if (over > 0) {
      this.gauges.append(
        el(
          "div",
          "hangar-gauges-warn",
          `${model.previewing ? "Would be over" : "Over"} power by ${over.toFixed(0)} — modules will shut each other down.`,
        ),
      );
    }
  }

  // --- rendering ---------------------------------------------------------

  private render(): void {
    const ship = this.currentShip();
    // A full render rebuilds the picker, so whatever module the pointer was over
    // no longer exists: the ghost goes with it (equipping, changing bay, ship or
    // fitting all land here, and all of them mean "that consideration is over").
    this.preview = null;
    this.previewPinned = false;
    this.panel.innerHTML = "";
    this.renderGauges();
    if (!ship) return;

    // Fitting is always available (offline test mode); only the parts that
    // spend real credits stay gated on a real account.
    const storeLocked = !this.isAuthed();
    const profile = this.auth.getState();
    const credits = profile.status === "authed" ? profile.profile.credits : 0;
    const level = profile.status === "authed" ? profile.profile.level : 1;

    this.panel.append(this.buildHeader());

    const owned = this.canFly(ship.id);
    const body = el("div", "hangar-body");
    body.append(this.buildCategoryRail(owned));

    const content = el("div", "hangar-content");
    if (storeLocked) {
      content.append(
        el(
          "div",
          "hangar-hint",
          "Offline: fitting, unlocking and saving work locally, and everything is free while we test. Log in to spend real credits and upgrade.",
        ),
      );
    }
    if (this.error) content.append(el("div", "hangar-error", this.error));

    // A hull you have not bought shows its stats and the unlock, nothing else:
    // there is no fitting to edit and no fitting to save until it is yours.
    if (!owned) {
      content.append(this.buildShipCarousel());
      content.append(this.buildStatPanel(ship));
    } else if (this.category === "ship") {
      content.append(this.buildShipCarousel());
      content.append(this.buildStatPanel(ship));
      content.append(this.buildUpgrades(ship, storeLocked, credits));
    } else if (this.category === "fitting") {
      content.append(this.buildFittingControls(ship));
      content.append(this.buildStatPanel(ship));
    } else {
      content.append(this.buildSlotGrid(this.category === "internals" ? "internal" : "hardpoint"));
      if (this.pickerHardpoint !== null) {
        content.append(this.buildModulePicker(ship, this.pickerHardpoint, credits, level));
      }
    }
    body.append(content);
    this.panel.append(body);
    this.panel.append(this.buildStatusBar(ship));
  }

  /**
   * The outfitting rail (owner 2026-07-31) — the screen's spine, in the shape
   * every space sim's outfitting screen has: a column of BAYS on the left, the
   * ship filling the view, and the numbers that decide a fit along the bottom.
   * Picking a bay changes what the panel shows; it never changes the ship.
   */
  private buildCategoryRail(owned: boolean): HTMLDivElement {
    const rail = el("div", "hangar-rail");
    const entries: { key: HangarCategory; label: string; hint: string }[] = [
      { key: "hardpoints", label: "Hardpoints", hint: "Weapons and shields" },
      { key: "internals", label: "Core internal", hint: "Engine, reactor, bus, sink, sensors" },
      { key: "ship", label: "Ship", hint: "Hull, stats and upgrades" },
      { key: "fitting", label: "Fitting", hint: "Save and load loadouts" },
    ];
    for (const entry of entries) {
      const btn = document.createElement("button");
      btn.className = "hangar-rail-btn" + (this.category === entry.key ? " active" : "");
      btn.dataset["category"] = entry.key;
      // An unowned hull has no bays to open — only the SHIP page, which carries
      // the unlock.
      btn.disabled = this.busy || (!owned && entry.key !== "ship");
      btn.append(el("span", "hangar-rail-label", entry.label), el("span", "hangar-rail-hint", entry.hint));
      btn.addEventListener("click", () => this.selectCategory(entry.key));
      rail.append(btn);
    }
    const back = document.createElement("button");
    back.className = "hangar-rail-btn back";
    back.disabled = this.busy;
    back.append(el("span", "hangar-rail-label", "Back"));
    back.addEventListener("click", () => this.onClose());
    rail.append(back);
    return rail;
  }

  private selectCategory(category: HangarCategory): void {
    this.category = category;
    // A picker belongs to the bay it was opened from; carrying it across would
    // show a hardpoint's module list under the internals heading.
    this.pickerHardpoint = null;
    this.render();
  }

  /**
   * The bottom instrument strip: the handful of numbers a pilot judges a fit on,
   * and the POWER RAIL as two bars — what the hull draws with only its guns up,
   * and what it would draw with everything up. The gap between them is exactly
   * the choice the rail forces (see `powerRail.ts`).
   */
  private buildStatusBar(ship: ShipConfig): HTMLDivElement {
    const panel = computeStatPanel(ship, this.configs, {
      upgradeLevels: this.currentUpgradeLevels(),
      fittedModuleIds: fittedModuleIdsOf(this.slots),
    });
    const bar = el("div", "hangar-statusbar");

    const specs = el("div", "hangar-specs");
    specs.append(el("div", "hangar-specs-title", "Ship specs"));
    specs.append(specRow("Integrity", panel.hullMax.toFixed(0)));
    specs.append(specRow("Top speed", `${panel.nominalSpeed.toFixed(0)} m/s`));
    specs.append(specRow("Heat capacity", panel.heatCapacity.toFixed(0)));
    specs.append(specRow("DPS (est.)", panel.dps.toFixed(1)));
    bar.append(specs);

    const power = el("div", "hangar-power");
    const head = el("div", "hangar-power-head");
    head.append(el("span", "hangar-specs-title", "Total power"));
    head.append(el("span", "hangar-power-max", `MAX ${panel.powerCapacity.toFixed(0)}`));
    power.append(head);
    power.append(powerBar("Retracted", panel.powerDrawRetracted, panel.powerCapacity));
    power.append(powerBar("Deployed", panel.powerDrawTotal, panel.powerCapacity));
    if (panel.powerOverSubscribed) {
      power.append(
        el(
          "div",
          "hangar-power-warn",
          `Over-subscribed by ${(panel.powerDrawTotal - panel.powerCapacity).toFixed(0)} — activating one module shuts another down.`,
        ),
      );
    }
    bar.append(power);
    return bar;
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

  /**
   * The ship bay: arrows either side of the hull on screen, the full list under
   * it, and — for a hull the player has not bought — the unlock. Swiping the 3D
   * stage steps the same index (see {@link stepShip}), so the arrows are the
   * pointer/keyboard equivalent of the gesture rather than a separate mode.
   */
  private buildShipCarousel(): HTMLDivElement {
    const wrap = el("div", "hangar-ships");

    const current = this.currentShip();
    if (current) {
      const owned = this.canFly(current.id);
      const nav = el("div", "hangar-ship-nav");
      nav.append(this.buildStepButton("‹", -1));
      const centre = el("div", "hangar-ship-current");
      const title = el("div", "hangar-ship-title");
      title.append(el("span", "hangar-ship-name", current.name));
      if (this.isMainShip(current.id)) title.append(el("span", "hangar-badge main", "★ MAIN"));
      else if (!owned) title.append(el("span", "hangar-badge locked", "LOCKED"));
      centre.append(title);
      centre.append(el("div", "hangar-ship-class", `${current.class} hull · swipe to change ship`));
      nav.append(centre);
      nav.append(this.buildStepButton("›", 1));
      wrap.append(nav);
      wrap.append(this.buildShipActions(current, owned));
    }

    const list = el("div", "hangar-ship-list");
    this.ships.forEach((ship, i) => {
      const btn = document.createElement("button");
      const owned = this.canFly(ship.id);
      btn.className =
        "hangar-ship-btn" + (i === this.shipIndex ? " active" : "") + (owned ? "" : " locked");
      btn.innerHTML = "";
      btn.append(el("span", "hangar-ship-name", owned ? ship.name : `🔒 ${ship.name}`), el("span", "hangar-ship-class", ship.class));
      btn.disabled = this.busy;
      btn.addEventListener("click", () => this.selectShip(i));
      list.append(btn);
    });
    wrap.append(list);
    return wrap;
  }

  private buildStepButton(glyph: string, delta: -1 | 1): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "hangar-ship-step";
    btn.textContent = glyph;
    btn.setAttribute("aria-label", delta < 0 ? "Previous ship" : "Next ship");
    btn.disabled = this.busy || this.ships.length < 2;
    btn.addEventListener("click", () => this.stepShip(delta));
    return btn;
  }

  /** Unlock / set-as-main for the hull on screen. */
  private buildShipActions(ship: ShipConfig, owned: boolean): HTMLDivElement {
    const row = el("div", "hangar-ship-actions");
    if (!owned) {
      row.append(el("div", "hangar-hint", "You do not own this hull yet."));
      const buy = document.createElement("button");
      buy.className = "hangar-btn hangar-btn-primary";
      // Free for now (testing) — the purchase still has to happen, so the flow
      // is the real one and only the price is provisional.
      buy.textContent = "Unlock (free)";
      buy.disabled = this.busy || !this.offlineFitting;
      buy.addEventListener("click", () => this.buyShip(ship.id));
      row.append(buy);
      return row;
    }
    if (this.isMainShip(ship.id)) {
      row.append(el("div", "hangar-hint", "This ship and fitting is what you fly."));
      return row;
    }
    const main = document.createElement("button");
    main.className = "hangar-btn hangar-btn-primary";
    main.textContent = "★ Set as main";
    main.disabled = this.busy;
    main.addEventListener("click", () => this.setAsMain());
    row.append(main);
    return row;
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
   *
   * Kept SHORT since 2026-08-01: the stage gauges are the primary power signal
   * now (they colour the rail and ghost a candidate's draw before it is fitted),
   * so this is the footnote rather than the announcement.
   */
  private buildPowerWarn(panel: HangarStatPanel): HTMLDivElement {
    const row = el("div", "hangar-bar-row");
    if (!panel.powerOverSubscribed) return row;
    const over = panel.powerDrawTotal - panel.powerCapacity;
    row.append(
      el(
        "span",
        "hangar-bar-label warn-text",
        `Power rail over-subscribed by ${over.toFixed(0)} — activating one module shuts another down.`,
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

  private buildSlotGrid(kind: "hardpoint" | "internal"): HTMLDivElement {
    const wrap = el("div", "hangar-slots");
    wrap.append(
      el("div", "hangar-section-title", kind === "internal" ? "Core internal bays" : "Hardpoints"),
    );
    const grid = el("div", "hangar-slot-grid");
    for (const slot of this.slots) {
      if (slot.kind !== kind) continue;
      const mod = slot.moduleId ? this.configs.get<ModuleConfig>("module", slot.moduleId) : undefined;
      const btn = document.createElement("button");
      btn.className = "hangar-slot" + (slot.moduleId ? " filled" : "") + (this.pickerHardpoint === slot.hardpointIndex ? " open" : "");
      btn.dataset["kind"] = slot.kind;
      btn.disabled = this.busy;
      // The real glyph set, not the content's `[ICON: laser]` placeholder text.
      const icon = el("span", "hangar-slot-icon");
      icon.innerHTML = mod ? moduleIconSvg(moduleIconId(mod)) : "";
      if (!mod) icon.textContent = "+";
      btn.append(icon);
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

    if (slot?.moduleId) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "hangar-btn";
      removeBtn.textContent = "Remove module";
      removeBtn.disabled = this.busy;
      // Emptying the slot is a fit change like any other, so it previews like
      // one: hovering it ghosts the gauges DOWN by what the module was giving.
      removeBtn.dataset["previewModule"] = "";
      this.bindPreviewSignals(removeBtn, hardpointIndex, null, { pinOnClick: false });
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
      // "The player is considering this one": hover, keyboard focus (it bubbles
      // from the row's own Equip/Buy button) and a tap all raise the ghost.
      row.dataset["previewModule"] = mod.id;
      this.bindPreviewSignals(row, hardpointIndex, mod.id, { pinOnClick: true });

      const head = el("div", "hangar-picker-head");
      head.append(el("span", "hangar-picker-name", mod.name ?? mod.id));
      head.append(
        el(
          "span",
          "hangar-picker-meta",
          locked ? `Lv ${mod.requiresLevel}` : owned ? "Owned" : this.offlineFitting ? "Locked" : `${mod.price} cr`,
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
        // Offline every module is free — but still bought, so the unlock flow
        // is the shipped one and only the price is provisional.
        buyBtn.textContent = this.offlineFitting || mod.price <= 0 ? "Unlock (free)" : `Buy (${mod.price} cr)`;
        buyBtn.disabled = this.busy || (!this.offlineFitting && credits < mod.price);
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
    this.disposed = true;
    this.hide();
    this.unsubscribeAuth();
    this.previewRig?.dispose();
    this.previewInstance?.dispose();
    this.lockedMaterial?.dispose();
    this.lockedMaterial = null;
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
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

/** One label/value line in the bottom instrument strip. */
function specRow(label: string, value: string): HTMLDivElement {
  const row = el("div", "hangar-spec-row");
  row.append(el("span", "hangar-spec-label", label), el("span", "hangar-spec-value", value));
  return row;
}

/**
 * One power-rail bar. Fills against CAPACITY, so the empty remainder is the
 * headroom the pilot still has — and a bar that runs past its track is a fit
 * that cannot be online all at once.
 */
function powerBar(label: string, draw: number, capacity: number): HTMLDivElement {
  const row = el("div", "hangar-power-row");
  row.append(el("span", "hangar-power-label", label));
  const track = el("div", "hangar-power-track");
  const over = capacity > 0 && draw > capacity;
  const fill = el("div", "hangar-power-fill" + (over ? " over" : ""));
  fill.style.width = `${capacity > 0 ? Math.min(100, (draw / capacity) * 100) : 0}%`;
  track.append(fill);
  row.append(track);
  row.append(el("span", "hangar-power-value", draw.toFixed(0)));
  return row;
}

/**
 * One gauge line on the STAGE overlay: caption, track, reading. The ghost is a
 * SEGMENT covering the ground between the current fill and the projected one —
 * hatched where a candidate would add, dimmed where it would take away — so the
 * direction of a change reads before its number does.
 */
function gaugeRow(gauge: HangarGauge): HTMLDivElement {
  const row = el("div", "hangar-gauge");
  row.dataset["key"] = gauge.key;
  row.append(el("span", "hangar-gauge-label", gauge.label));

  const track = el("div", "hangar-gauge-track");
  const fill = el("div", "hangar-gauge-fill" + (gauge.warn ? " warn" : ""));
  fill.style.width = pct(gauge.fraction);
  track.append(fill);
  if (gauge.ghostFraction !== null) {
    const rising = gauge.ghostFraction > gauge.fraction;
    const lo = Math.min(gauge.fraction, gauge.ghostFraction);
    const hi = Math.max(gauge.fraction, gauge.ghostFraction);
    const ghost = el("div", `hangar-gauge-ghost ${rising ? "up" : "down"}${gauge.ghostWarn ? " warn" : ""}`);
    ghost.style.left = pct(lo);
    ghost.style.width = pct(hi - lo);
    track.append(ghost);
  }
  // Power's reference line: where the rail runs out. Nothing else has one.
  if (gauge.limitFraction !== null) {
    const limit = el("div", "hangar-gauge-limit");
    limit.style.left = pct(gauge.limitFraction);
    track.append(limit);
  }
  row.append(track);

  const read = el("div", "hangar-gauge-read");
  read.append(el("span", "hangar-gauge-value" + (gauge.warn ? " warn" : ""), gauge.valueText));
  if (gauge.deltaText !== null) {
    read.append(
      el("span", `hangar-gauge-delta ${gauge.trend}${gauge.ghostWarn ? " warn" : ""}`, gauge.deltaText),
    );
  }
  row.append(read);
  return row;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
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
 * OUTFITTING (owner 2026-07-31) — restyled after the space-sim outfitting
 * screens the game is aiming at: flat charcoal panels, square corners, hairline
 * rules, condensed uppercase labels, and ONE accent colour (amber) that means
 * "this is the thing you have selected". No rounded chrome, no glass, no second
 * accent competing for attention.
 *
 * The split itself is unchanged: the ship's 3D stage gets one half — STACKED in
 * portrait, SIDE BY SIDE in landscape — and \`hangarLayout.stageViewport()\`
 * confines the camera to exactly the same rectangle, so the two must always be
 * changed together.
 */
.hangar-overlay {
  position: fixed;
  inset: 0;
  z-index: 15;
  pointer-events: none;
  font-family: "Roboto Condensed", "Segoe UI", system-ui, sans-serif;
  color: #d9dde2;
  display: flex;
  flex-direction: column; /* portrait: stage above, panel below */
  --hg-accent: #f07b05;
  --hg-accent-dim: rgba(240, 123, 5, .18);
  --hg-panel: rgba(14, 16, 19, .95);
  --hg-panel-2: rgba(26, 29, 33, .95);
  --hg-line: #3a3f45;
  --hg-dim: #8b939b;
  --hg-danger: #ff5a5a;
}
/* The stage takes its half of the flex box but never any pointer events —
   orbit and zoom drags belong to the canvas underneath it. */
.hangar-stage {
  position: relative;
  flex: 1 1 50%;
  min-height: 0;
  min-width: 0;
  pointer-events: none;
}
/* Stage arrows: the only thing in the stage half that takes pointer events, so
   orbit and zoom drags still reach the canvas between them. */
.hangar-stage-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 68px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: linear-gradient(90deg, rgba(14, 16, 19, 0) 0%, rgba(14, 16, 19, .72) 100%);
  color: var(--hg-accent);
  border: 0;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  opacity: .78;
  transition: opacity .12s linear, color .12s linear;
}
.hangar-stage-arrow.prev { left: 0; background: linear-gradient(270deg, rgba(14, 16, 19, 0) 0%, rgba(14, 16, 19, .72) 100%); }
.hangar-stage-arrow.next { right: 0; }
.hangar-stage-arrow svg { width: 26px; height: 26px; display: block; filter: drop-shadow(0 0 5px rgba(240, 123, 5, .45)); }
.hangar-stage-arrow:hover:not(:disabled) { opacity: 1; color: #ffb35c; }
.hangar-stage-arrow:disabled { opacity: .22; cursor: default; }
/*
 * ---- ship characteristics, over the 3D stage (owner 2026-08-01) ----
 *
 * The primary read on a fit, put where the player is already looking. Anchored
 * to the stage's top-left CORNER (the hull frames itself in the middle) and,
 * like the rest of the stage half, click-through: an orbit drag that starts on
 * these gauges must still reach the canvas underneath.
 */
.hangar-gauges {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: calc(env(safe-area-inset-left, 0px) + 8px);
  width: min(258px, 62%);
  box-sizing: border-box;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 9px 8px;
  background: rgba(10, 12, 15, .62);
  border: 1px solid rgba(58, 63, 69, .8);
  border-left: 2px solid var(--hg-accent);
  backdrop-filter: blur(2px);
}
.hangar-gauges.previewing { border-left-color: #ffb35c; }
.hangar-gauges-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.hangar-gauges-title { font-size: 9.5px; letter-spacing: .18em; text-transform: uppercase; color: var(--hg-accent); }
.hangar-gauges-preview {
  font-size: 8.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: #ffd9ac;
  background: var(--hg-accent-dim);
  padding: 1px 5px;
}
.hangar-gauge { display: grid; grid-template-columns: 48px 1fr auto; align-items: center; column-gap: 6px; }
.hangar-gauge-label { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--hg-dim); }
.hangar-gauge-track { position: relative; height: 7px; background: rgba(255, 255, 255, .08); overflow: hidden; }
.hangar-gauge-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--hg-accent); }
.hangar-gauge-fill.warn { background: var(--hg-danger); }
/*
 * The GHOST: the ground between the current value and the projected one. Going
 * UP it is a translucent hatch drawn past the fill (what the module would add);
 * coming DOWN it dims the part of the fill that would be given back.
 */
.hangar-gauge-ghost { position: absolute; top: 0; bottom: 0; }
.hangar-gauge-ghost.up {
  background:
    repeating-linear-gradient(135deg, rgba(240, 123, 5, .85) 0 3px, rgba(240, 123, 5, .3) 3px 6px);
}
.hangar-gauge-ghost.down {
  background:
    repeating-linear-gradient(135deg, rgba(217, 221, 226, .5) 0 3px, rgba(10, 12, 15, .65) 3px 6px);
}
.hangar-gauge-ghost.up.warn {
  background:
    repeating-linear-gradient(135deg, rgba(255, 90, 90, .9) 0 3px, rgba(255, 90, 90, .35) 3px 6px);
}
.hangar-gauge-ghost.down.warn {
  background:
    repeating-linear-gradient(135deg, rgba(255, 90, 90, .6) 0 3px, rgba(10, 12, 15, .65) 3px 6px);
}
/* Where the power rail runs out — the one line a fit must not cross. */
.hangar-gauge-limit { position: absolute; top: -1px; bottom: -1px; width: 1px; background: #e8ecf1; opacity: .7; }
.hangar-gauge-read { display: flex; align-items: baseline; justify-content: flex-end; gap: 4px; min-width: 74px; }
.hangar-gauge-value { font-size: 10px; font-variant-numeric: tabular-nums; }
.hangar-gauge-value.warn { color: var(--hg-danger); font-weight: 700; }
.hangar-gauge-delta { font-size: 9.5px; font-variant-numeric: tabular-nums; font-weight: 700; }
.hangar-gauge-delta.better { color: #7fd18a; }
.hangar-gauge-delta.worse { color: #ffb35c; }
.hangar-gauge-delta.warn { color: var(--hg-danger); }
.hangar-gauges-warn { font-size: 9.5px; line-height: 1.2; color: var(--hg-danger); }
/* Phones: the stage half is small, so the block gives the hull more room. */
@media (max-width: 520px), (orientation: landscape) and (max-height: 480px) {
  .hangar-gauges { width: min(216px, 68%); padding: 5px 7px 6px; gap: 3px; }
  .hangar-gauge { grid-template-columns: 42px 1fr auto; column-gap: 5px; }
  .hangar-gauge-read { min-width: 66px; }
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
  background: var(--hg-panel);
  border-top: 1px solid var(--hg-line);
  padding:
    10px
    calc(env(safe-area-inset-right, 0px) + 12px)
    calc(env(safe-area-inset-bottom, 0px) + 10px)
    calc(env(safe-area-inset-left, 0px) + 12px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/*
 * Rail + content, with the instrument strip under both.
 *
 * Every direct child of the scrolling panel is \`flex-shrink: 0\`. Without it a
 * flex column SHRINKS its children below their content instead of scrolling,
 * and the overflow paints straight over the next section — which is exactly how
 * the ship specs ended up printed across the rail (owner report 2026-07-31).
 */
.hangar-header, .hangar-body, .hangar-statusbar { flex: 0 0 auto; }
.hangar-body { display: flex; gap: 10px; align-items: flex-start; }
.hangar-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.hangar-rail { flex: 0 0 132px; }

/* ---- the outfitting rail ---- */
.hangar-rail { flex: 0 0 132px; display: flex; flex-direction: column; gap: 2px; }
.hangar-rail-btn {
  display: flex;
  flex-direction: column;
  gap: 1px;
  text-align: left;
  padding: 7px 9px;
  min-height: 42px;
  background: var(--hg-panel-2);
  color: #d9dde2;
  border: 0;
  border-left: 3px solid transparent;
  cursor: pointer;
  touch-action: manipulation;
}
.hangar-rail-btn:hover:not(:disabled) { background: #23272c; }
.hangar-rail-btn.active { background: var(--hg-accent); color: #140b02; border-left-color: #ffb35c; }
.hangar-rail-btn.active .hangar-rail-hint { color: rgba(20, 11, 2, .72); }
.hangar-rail-btn:disabled { opacity: .35; cursor: default; }
.hangar-rail-btn.back { margin-top: 8px; background: transparent; border: 1px solid var(--hg-line); }
.hangar-rail-label { font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.hangar-rail-hint { font-size: 9.5px; color: var(--hg-dim); line-height: 1.15; }

/* Landscape: the same halves, laid out left (stage) / right (panel). */
@media (orientation: landscape) {
  .hangar-overlay { flex-direction: row; }
  .hangar-panel {
    border-top: none;
    border-left: 1px solid var(--hg-line);
    padding-top: calc(env(safe-area-inset-top, 0px) + 10px);
  }
}
.hangar-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--hg-line); padding-bottom: 6px; }
.hangar-title { letter-spacing: .3em; font-weight: 700; color: var(--hg-accent); font-size: 14px; text-transform: uppercase; }
.hangar-close { background: transparent; color: #d9dde2; border: 1px solid var(--hg-line); padding: 6px 12px; min-height: 34px; cursor: pointer; touch-action: manipulation; text-transform: uppercase; letter-spacing: .08em; font-size: 11px; }
.hangar-hint { font-size: 11px; color: var(--hg-dim); border-left: 2px solid var(--hg-line); padding: 4px 8px; }
.hangar-error { font-size: 11px; color: var(--hg-danger); border-left: 2px solid var(--hg-danger); padding: 4px 8px; }
.hangar-section-title { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--hg-dim); margin-bottom: 4px; }
.hangar-ships { display: flex; flex-direction: column; gap: 8px; }
/* Arrows either side of the hull on screen — the pointer equivalent of the
   swipe gesture on the 3D stage. */
.hangar-ship-nav { display: flex; align-items: center; gap: 8px; }
.hangar-ship-step { flex: 0 0 auto; width: 38px; min-height: 42px; font-size: 20px; line-height: 1; background: var(--hg-panel-2); color: #d9dde2; border: 1px solid var(--hg-line); cursor: pointer; touch-action: manipulation; }
.hangar-ship-step:disabled { opacity: 0.3; cursor: default; }
.hangar-ship-current { flex: 1 1 auto; min-width: 0; text-align: center; }
.hangar-ship-title { display: flex; align-items: center; justify-content: center; gap: 8px; }
.hangar-ship-title .hangar-ship-name { font-size: 15px; letter-spacing: .1em; text-transform: uppercase; }
.hangar-badge { font-size: 9.5px; font-weight: 700; letter-spacing: .1em; padding: 2px 6px; }
.hangar-badge.main { background: var(--hg-accent); color: #140b02; }
.hangar-badge.locked { background: transparent; color: var(--hg-danger); border: 1px solid var(--hg-danger); }
.hangar-ship-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hangar-ship-actions .hangar-hint { flex: 1 1 140px; margin: 0; }
.hangar-ship-list { display: flex; flex-wrap: wrap; gap: 4px; }
.hangar-ship-btn { flex: 1 1 96px; min-height: 42px; touch-action: manipulation; display: flex; flex-direction: column; gap: 1px; padding: 6px; background: var(--hg-panel-2); color: #d9dde2; border: 1px solid var(--hg-line); border-left: 3px solid transparent; cursor: pointer; }
.hangar-ship-btn.active { border-left-color: var(--hg-accent); background: #23272c; }
.hangar-ship-btn.locked { opacity: 0.55; border-style: dashed; }
.hangar-ship-name { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; }
.hangar-ship-class { font-size: 9.5px; color: var(--hg-dim); text-transform: uppercase; letter-spacing: .1em; }
.hangar-stats { display: flex; flex-direction: column; gap: 2px; }
.hangar-stat-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; border-bottom: 1px solid rgba(58, 63, 69, .5); padding: 2px 0; }
.hangar-stat-label { color: var(--hg-dim); text-transform: uppercase; letter-spacing: .06em; }
.hangar-stat-value { font-variant-numeric: tabular-nums; }
.hangar-bar-row { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
.hangar-bar-label { font-size: 10.5px; color: var(--hg-dim); }
.hangar-bar-label.warn-text { color: var(--hg-danger); }
.hangar-bar-track { height: 5px; background: rgba(255,255,255,.07); overflow: hidden; }
.hangar-bar-fill { height: 100%; background: var(--hg-accent); }
.hangar-bar-fill.warn { background: var(--hg-danger); }

/* ---- bottom instrument strip ---- */
.hangar-statusbar { display: flex; gap: 16px; flex-wrap: wrap; border-top: 1px solid var(--hg-line); padding-top: 8px; }
.hangar-specs { flex: 1 1 160px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hangar-specs-title { font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--hg-accent); margin-bottom: 3px; }
.hangar-spec-row { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; }
.hangar-spec-label { color: var(--hg-dim); text-transform: uppercase; letter-spacing: .06em; }
.hangar-spec-value { font-variant-numeric: tabular-nums; }
.hangar-power { flex: 2 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.hangar-power-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.hangar-power-max { font-size: 10px; letter-spacing: .1em; color: var(--hg-dim); font-variant-numeric: tabular-nums; }
.hangar-power-row { display: flex; align-items: center; gap: 8px; font-size: 10.5px; }
.hangar-power-label { flex: 0 0 68px; color: var(--hg-dim); text-transform: uppercase; letter-spacing: .08em; }
.hangar-power-track { flex: 1 1 auto; height: 8px; background: rgba(255,255,255,.07); overflow: hidden; }
.hangar-power-fill { height: 100%; background: var(--hg-accent); }
.hangar-power-fill.over { background: var(--hg-danger); }
.hangar-power-value { flex: 0 0 28px; text-align: right; font-variant-numeric: tabular-nums; }
.hangar-power-warn { font-size: 10.5px; color: var(--hg-danger); }

.hangar-slot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 4px; }
.hangar-slot { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 8px; min-height: 56px; touch-action: manipulation; background: var(--hg-panel-2); color: #d9dde2; border: 1px solid var(--hg-line); border-left: 3px solid var(--hg-line); cursor: pointer; text-align: left; }
.hangar-slot.filled { border-left-color: var(--hg-accent); }
.hangar-slot.open { background: var(--hg-accent); color: #140b02; }
.hangar-slot.open .hangar-slot-socket { color: rgba(20, 11, 2, .72); }
.hangar-slot:disabled { opacity: .45; cursor: default; }
/* The slot's glyph is an inline SVG from the shared module icon set; an empty
   slot falls back to a "+" character, so size both paths the same. */
.hangar-slot-icon { font-size: 14px; line-height: 1; color: var(--hg-accent); }
.hangar-slot-icon .hud-icon-svg { width: 16px; height: 16px; display: block; }
.hangar-slot.open .hangar-slot-icon { color: #140b02; }
.hangar-slot-label { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.hangar-slot-socket { font-size: 9px; color: var(--hg-dim); letter-spacing: .04em; }
/* Systems-bay slots read cool, so a bay never looks like a hardpoint. */
.hangar-slot[data-kind="internal"].filled { border-left-color: #6fb2d2; }
.hangar-picker { display: flex; flex-direction: column; gap: 6px; background: var(--hg-panel-2); border: 1px solid var(--hg-line); padding: 8px; }
.hangar-picker-kind { margin-left: 8px; color: var(--hg-dim); letter-spacing: .06em; }
/*
 * Rolling list: a fixed-height scroller showing ~3-4 rows at a time, so a long
 * candidate list scrolls INSIDE the picker instead of pushing the instrument
 * strip off the screen.
 */
.hangar-picker-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 224px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-right: 2px;
}
.hangar-picker-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  font-size: 11.5px;
  background: rgba(0, 0, 0, .25);
  border: 1px solid var(--hg-line);
  border-left: 3px solid transparent;
}
.hangar-picker-item[draggable="true"] { cursor: grab; }
.hangar-picker-item[draggable="true"]:active { cursor: grabbing; }
.hangar-picker-item.fitted { border-left-color: var(--hg-accent); }
/* The candidate whose ghost is on the stage gauges right now. */
.hangar-picker-item.considering { border-left-color: #ffb35c; background: rgba(240, 123, 5, .12); }
.hangar-btn.considering { border-color: #ffb35c; }
.hangar-picker-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.hangar-picker-name { font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.hangar-picker-meta { color: var(--hg-dim); font-size: 10.5px; white-space: nowrap; text-transform: uppercase; letter-spacing: .06em; }
.hangar-picker-stats { display: flex; flex-wrap: wrap; gap: 3px; }
.hangar-stat-chip {
  display: inline-flex;
  gap: 4px;
  padding: 1px 5px;
  font-size: 10px;
  background: rgba(240, 123, 5, .1);
  border-left: 2px solid var(--hg-accent-dim);
}
.hangar-stat-chip .k { color: var(--hg-dim); text-transform: uppercase; letter-spacing: .05em; }
.hangar-stat-chip .v { color: #d9dde2; font-variant-numeric: tabular-nums; }
.hangar-picker-actions { display: flex; justify-content: flex-end; }
.hangar-picker-actions:empty { display: none; }
/* Landscape phones have little height: show fewer rows before scrolling. */
@media (orientation: landscape) and (max-height: 520px) {
  .hangar-picker-list { max-height: 152px; }
  .hangar-rail { flex-basis: 116px; }
}
.hangar-upgrades { display: flex; flex-direction: column; gap: 5px; }
.hangar-upgrade-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11.5px; }
.hangar-upgrade-label { width: 72px; color: var(--hg-dim); text-transform: uppercase; letter-spacing: .06em; }
.hangar-pips { display: flex; flex-wrap: wrap; gap: 3px; flex: 1 1 60px; }
.pip { width: 9px; height: 5px; background: rgba(255,255,255,.12); }
.pip.filled { background: var(--hg-accent); }
.hangar-fit-controls { display: flex; flex-direction: column; gap: 6px; }
.hangar-fit-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }
.hangar-select, .hangar-input { width: 100%; box-sizing: border-box; padding: 8px; min-height: 38px; font-size: 16px; background: rgba(0,0,0,.35); color: #d9dde2; border: 1px solid var(--hg-line); }
.hangar-btn { padding: 7px 12px; min-height: 34px; touch-action: manipulation; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; background: var(--hg-panel-2); color: #d9dde2; border: 1px solid var(--hg-line); cursor: pointer; }
.hangar-btn:disabled { opacity: .45; cursor: default; }
.hangar-btn-primary { background: var(--hg-accent); color: #140b02; font-weight: 700; border-color: var(--hg-accent); }
.hangar-btn-danger { background: transparent; color: var(--hg-danger); border-color: var(--hg-danger); }
`;
