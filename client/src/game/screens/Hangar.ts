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
import { designTokenCssVars } from "../themeTokens.js";
import {
  createLogger,
  type ConfigService,
  type HardpointMap,
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
import { ModelLoadQueue } from "../../core/modelLoadQueue.js";
import type { AuthService } from "../../core/AuthService.js";
import { HangarApi, HangarApiError, HangarRefreshScope, type ApiModule, type ApiShip } from "../HangarApi.js";
import {
  buildHardpointMap,
  fittedModuleIdsOf,
  slotAccepts,
  slotsFromDefaultFitting,
  slotsFromHardpointMap,
  type HangarSlot,
} from "../hangarFitting.js";
import { computeStatPanel, type HangarStatPanel } from "../hangarStats.js";
import { deckCompareRows, deckPower, slotLabel, type DeckCompareRow } from "../hangarDeck.js";
import { moduleIconId, moduleIconSvg } from "../hud/moduleIcons.js";
import { loadLocalLoadout, saveLocalLoadout } from "../offlineFittings.js";
import { buyShipLocal, ownsModule, ownsShip, STARTER_SHIP_ID } from "../offlineOwnership.js";
import type { OwnershipStore } from "../ownershipStore.js";
import { hullOwned, moduleOwned } from "../hangarGating.js";
import { priceLabel } from "../shopModel.js";
import { buyAndEquipSkin, hangarSkinEntries, type HangarSkinEntry } from "../hangarSkins.js";
import { cosmeticById } from "../cosmetics.js";
import { ShipPaintBank } from "../shipPaint.js";
import { SwipeWatcher, wrapIndex } from "../hangarSwipe.js";
import { HangarBay } from "./HangarBay.js";
import { swapFrame, SWAP_DISTANCE_RADII, SWAP_DURATION_SEC } from "../shipSwap.js";
import { juiceSettingsOf } from "../juice/juiceSettings.js";
import { framingRadius, isLandscape, stageAspect, stageViewport, STAGE_FRACTION } from "../hangarLayout.js";
import { ShipSocketRig, type ParticleQuality } from "../ShipSocketRig.js";
import { pinInstanceLod0 } from "../../core/modelLod.js";
import type { TacticalCamera } from "../TacticalCamera.js";
import { allHangarShipJobs, hangarPriorityJobs } from "../hangarAssetPreload.js";

const log = createLogger("Hangar");

/**
 * The MAIN loadout (owner 2026-07-31): the ship and the module list the player
 * actually takes into a match. Browsing the hangar does NOT touch it — you can
 * swipe through every hull in the bay without losing what you fly. It changes
 * only when the player sets a new main, or when they edit the fit of the hull
 * that already is one.
 */
const LS_SHIP = "hangar.shipId";
/**
 * Where the carousel was left, for THIS SESSION only (playtest 2026-08-23 §26).
 * Presentation, never flown — and deliberately in `sessionStorage`: the hangar
 * opens on the hull you FLY, and a browse position that outlived the tab was
 * how a pilot whose main was the Brawler kept arriving at an Interceptor three
 * arrow-taps away. Stepping out to the Shop and back inside one sitting still
 * lands where you left off, which is the only case the memory was ever for.
 */
const SS_BROWSE = "hangar.browseShipId";
/**
 * Whether the press-and-hold preview has ever been advertised (§37). A finger
 * gets no hover, so the compare box only fills in after a 260ms hold and
 * nothing said so; the sheet now says it once, and remembers that it did.
 */
const LS_PREVIEW_HINT = "hangar.previewHintSeen";
/**
 * The selected ship's upgrade levels as `/api/ships` last reported them. Cached
 * here because a MATCH needs them (client prediction resolves the same engine
 * stats the sim does — FLIGHT.md §5) and the match path has no authenticated
 * REST call of its own. Purely a local hint: it is never sent to the server,
 * which loads the authoritative levels from the DB at spawn.
 */
const LS_UPGRADES = "hangar.upgrades";
/**
 * The MAIN hull's loadout as a POSITIONAL module list — a derived cache of what
 * the per-hull loadout store already holds, in the shape an offline match spawns
 * from directly ({@link loadHangarSelection}). Kept beside the ship id for the
 * same reason {@link LS_UPGRADES} is: a module list belonging to another hull
 * would not fit this one's sockets.
 */
const LS_MODULES = "hangar.moduleIds";
const THEME_ID = "theme.default";
/**
 * Grace on top of {@link SWAP_DURATION_SEC} before the wall-clock guard lands a
 * ship swap the render loop never finished. Long enough that a healthy screen
 * always beats it to the punch, short enough that a stalled one is not stuck.
 */
const SWAP_GUARD_SLACK_MS = 120;

/**
 * Share of a LANDSCAPE screen the viewer takes on the loadout deck: 545 of the
 * design's 960px frame. Portrait keeps the even {@link STAGE_FRACTION} split —
 * the deck stacks under the ship there, and a 57/43 vertical split would leave
 * the tiles too short to press. The CSS below must agree with this or the hull
 * renders behind the panel.
 */
const DECK_STAGE_FRACTION = 545 / 960;

/** How long a finger has to rest on a module card before it previews (touch). */
const PRESS_HOLD_MS = 260;

/** How long the one-time "hold a card" hint stays up before it bows out. */
const PREVIEW_HINT_MS = 5000;

/**
 * Whole cards the sheet's row is sized to show (see the `.hangar-card` width in
 * the sheet below). The half card that follows is the point: a row cut off at a
 * card boundary reads as a row that ENDS, which is how twenty-one modules came
 * to look like five (playtest match §2).
 */
const CARDS_IN_VIEW = 4;

/**
 * How far the chevron walks the card row when the viewport cannot be measured —
 * roughly two cards, so a press always moves the row by something the eye can
 * follow rather than by nothing at all.
 */
const CARD_STEP_PX = 220;

/**
 * How far a pointer may travel during a press on the card row before the click
 * that ends it is treated as a PAN rather than as a pick (spec). Five pixels is
 * the design's own threshold, and it is small enough that a deliberate tap on a
 * 96px card never trips it.
 */
const ROW_DRAG_SLOP_PX = 5;

/** Monotonic where available; a plain clock is still better than a frame delta. */
function swapNowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const STAGE_POS = new Vector3(0, 5, 300); // far from the arena (radius 90) — nothing else renders out here
const UPGRADE_TRACKS: readonly UpgradeTrackName[] = ["hull", "engine", "energy"];
const UPGRADE_LABELS: Record<UpgradeTrackName, string> = { hull: "Hull", engine: "Engine", energy: "Capacitor" };

export interface HangarSelection {
  shipId: string | null;
  /** Upgrade levels cached for {@link HangarSelection.shipId}; null when unknown (never logged in / never opened Hangar). */
  upgradeLevels: UpgradeLevels | null;
  /**
   * The loadout for {@link HangarSelection.shipId} as a POSITIONAL module-id
   * array (index = hardpoint index, `null` = empty), or null when unknown.
   * Offline matches spawn from it directly.
   *
   * An ONLINE match sends no loadout at all: the server holds one row per
   * (user, ship) and looks it up from the authenticated user plus the hull in
   * the join options, because it validates module ownership against the DB and
   * cannot take a client's list on trust anyway (owner 2026-08-22).
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
    upgradeLevels: loadCachedUpgrades(shipId),
    moduleIds: loadCachedModules(shipId),
  };
}

/**
 * The main hull's loadout, but only if it was stored for `shipId` — a list from
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

const ZERO_LEVELS: UpgradeLevels = { hull: 0, engine: 0, energy: 0 };

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
    return { hull: track(levels.hull), engine: track(levels.engine), energy: track(levels.energy) };
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
 * ## One loadout per hull (owner 2026-08-22)
 *
 * There is no fitting submenu, because there is nothing to manage: "when a
 * player fits its ship, it becomes the fitting the ship is going to use". Every
 * slot edit IS the save — {@link Hangar.persistLoadout} writes it immediately,
 * to the server when signed in and to `localStorage` when not — and the hull
 * that has never been fitted shows its stock `defaultFitting`. Nothing in the
 * UI names, selects or deletes a loadout, and the client never holds a fitting
 * id: the server derives the row's id from (user, ship).
 *
 * ## Offline fitting (TESTING AFFORDANCE — owner 2026-07-31, to be removed)
 *
 * Fitting is available WITHOUT an account: every module counts as owned, level
 * gates are ignored, and the loadouts live in `localStorage` (see
 * `offlineFittings.ts`). Only the parts that move real credits — purchases and
 * upgrade tracks — still require `/api/*` and a real account. Removing this
 * later means deleting `offlineFittings.ts` and the `offlineFitting` branch
 * here; nothing else grew a second code path.
 */
export class Hangar {
  private readonly root: HTMLDivElement;
  /** Transparent half the 3D stage renders into (see `.hangar-stage` CSS). */
  private readonly stage: HTMLDivElement;
  /**
   * The viewer WINDOW inside that half: the stage minus the characteristics
   * band docked under it. The camera viewport is matched to this rectangle, so
   * whatever the band takes, the hull is framed in what remains.
   */
  private readonly stageView: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly api: HangarApi;
  private readonly assets: AssetRegistry;
  private readonly modelQueue: ModelLoadQueue;
  private readonly awaitOwnership: () => Promise<void>;
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
  /**
   * The signed-in pilot's loadouts, hull id → hardpoint map, as `/api/fittings`
   * last reported them. Empty while signed out, where {@link loadLocalLoadout}
   * is the store instead — see {@link storedLoadout}, the one place that knows
   * which of the two is in force.
   */
  private serverLoadouts = new Map<string, HardpointMap>();
  private slots: HangarSlot[] = [];
  /**
   * The slot whose card SHEET is open over the bottom of the viewer, by
   * hardpoint index — the one piece of screen state the deck adds. Null when the
   * ship is unobstructed.
   */
  private sheetSlot: number | null = null;
  /**
   * The fit as it stood when the sheet OPENED, in hardpoint order — the BEFORE
   * side of the compare box (spec). Fitting from a card keeps the sheet open and
   * leaves this alone, so a pilot who tries three guns in a row still reads them
   * all against the fit they walked in with; closing the sheet drops it, which
   * is what "closing commits" means on this screen. Null when no sheet is open.
   */
  private baseFits: (string | null)[] | null = null;
  /**
   * Where the card row was scrolled to, carried across the `render()` a fit
   * triggers — the sheet stays open when a card is picked, and a row that
   * snapped back to its first card every time would lose the pilot's place.
   */
  private cardScrollLeft = 0;
  /**
   * True when the press currently on the card row has moved further than
   * {@link ROW_DRAG_SLOP_PX}: the release is a pan finishing, not a pick.
   */
  private rowDragged = false;
  private busy = false;
  private error = "";

  private previewInstance: InstancedMesh | null = null;
  /** Painted hull masters for the staged preview (contract §5). */
  private readonly paint: ShipPaintBank;
  private readonly unsubscribeOwnership: (() => void) | null = null;
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
  /**
   * In-flight ship-swap transition, or null when the bay is at rest.
   *
   * `startedAtMs` is a WALL clock, not an accumulated render delta (owner
   * 2026-08-22). The transition is what commits the hull change, and it used to
   * advance on `engine.getDeltaTime()` from inside a scene render observer: a
   * frame clock that reads 0 — a backgrounded/throttled tab, a paused loop, the
   * frame after a context restore — left `swap` latched forever, which disabled
   * both arrows (see {@link stepShip}'s guard) and stranded the panel on the old
   * hull. A clock the renderer cannot stall is the fix; {@link swapGuard} is the
   * belt to its braces for the case where no frame arrives at all.
   */
  private swap: { direction: -1 | 1; startedAtMs: number; distance: number; applied: boolean } | null = null;
  /** Wall-clock fallback that lands a swap no render frame ever finished. */
  private swapGuard: ReturnType<typeof setTimeout> | null = null;
  /** Stage-overlay arrows, kept so they can be disabled mid-transition. */
  private stageArrows: HTMLButtonElement[] = [];
  /**
   * The BEFORE / AFTER compare box inside the deck. Held so a hovered or
   * press-held module card can rewrite the four readings WITHOUT a `render()`,
   * which would destroy the very card the pointer is on.
   */
  private compare: HTMLDivElement | null = null;
  /**
   * The module-picker layer over the viewer — the dim and the card sheet that
   * slides up from its foot. Built once and refilled by {@link renderSheet},
   * because it belongs to the stage half and `render()` owns the panel.
   */
  private readonly sheet: HTMLDivElement;
  /** Hull name / class, bottom-left of the viewer (spec). */
  private readonly shipReadout: HTMLDivElement;
  /** Bay position dots, bottom-centre of the viewer (spec). */
  private readonly shipDots: HTMLDivElement;
  /** The stage TITLE — "HANGAR", top-left of the viewer (spec). */
  private readonly stageTitle: HTMLDivElement;
  /**
   * The single ACTION slot over the 3D stage, top-right (owner 2026-08-08).
   * Ownership decides what it holds: buy the hull, make it your main, or the
   * badge saying it already is. Built once and refreshed in place for the same
   * reason {@link gauges} is — `render()` owns the info panel, not this half.
   */
  private readonly stageAction: HTMLDivElement;
  private readonly previewLoader: HTMLDivElement;
  private loadingOverlay: HTMLDivElement | null = null;
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
  /**
   * Press-hold timer for the card sheet (touch). A finger has no hover to give,
   * so resting on a card is what raises the before/after preview; the release that
   * follows must then NOT fit the module the pilot was only weighing up.
   */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdFired = false;
  /**
   * Whether the one-time press-and-hold hint is up in the open sheet (§37). It
   * is raised by the FIRST sheet this browser ever opens and taken down by the
   * first hold or {@link PREVIEW_HINT_MS}, whichever comes first.
   */
  private previewHintVisible = false;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
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
    /**
     * The shop's ownership seam (contract §5). Wired, it is the sole authority
     * on what may be flown or fitted and the path every purchase takes; absent,
     * the screen keeps its pre-shop answers (see `hangarGating.ts`).
     */
    private readonly ownership: OwnershipStore | null = null,
    assets?: AssetRegistry,
    modelQueue?: ModelLoadQueue,
    awaitOwnership?: () => Promise<void>,
  ) {
    this.api = new HangarApi(auth);
    this.paint = new ShipPaintBank(scene, configs);
    this.assets = assets ?? new AssetRegistry(scene);
    this.modelQueue = modelQueue ?? new ModelLoadQueue(this.assets);
    this.awaitOwnership = awaitOwnership ?? (() => this.ownership?.refresh() ?? Promise.resolve());
    this.stageRoot = new TransformNode("hangarStage", scene);
    this.stageRoot.position.copyFrom(STAGE_POS);
    this.shipPivot = new TransformNode("hangarShipPivot", scene);
    this.shipPivot.parent = this.stageRoot;

    this.idleCur = idleSnapshot();
    this.idlePrev = idleSnapshot();

    injectHangarStyle();
    this.root = document.createElement("div");
    this.root.className = "hangar-overlay game-screen";
    for (const [prop, value] of Object.entries(designTokenCssVars(this.configs.get<ThemeConfig>("theme", "theme.default")))) {
      this.root.style.setProperty(prop, value);
    }
    // Half the screen is a hole onto the 3D stage: it must NOT take pointer
    // events, or it would eat the orbit/zoom drags meant for the canvas below.
    // It is NOT `aria-hidden`, though — the ship arrows and the hull action in
    // its corner are real controls a screen reader (and Playwright's role
    // queries) must be able to reach.
    this.stage = document.createElement("div");
    this.stage.className = "hangar-stage";
    // The VIEWER proper: the transparent window the camera's stage viewport is
    // matched to. Everything that belongs "over the hull" is anchored in here,
    // so the characteristics band docked beneath it can never cover the ship.
    this.stageView = el("div", "hangar-stage-view");
    this.stage.append(this.stageView);
    this.panel = document.createElement("div");
    this.panel.className = "hangar-panel";
    this.root.append(this.stage, this.panel);
    // Stylised arrows OVER the 3D stage: the primary way to walk the bay on a
    // pointer, and the visible twin of the swipe gesture. They live in the stage
    // half (which is otherwise click-through) and re-enable themselves when a
    // transition finishes.
    this.stageArrows = [this.buildStageArrow(-1), this.buildStageArrow(1)];
    // The stage's own furniture (owner 2026-08-22, loadout deck). All of it is
    // anchored INSIDE the viewer and all of it is click-through except the
    // controls themselves, so an orbit/zoom drag between them still reaches the
    // canvas underneath.
    this.stageTitle = el("div", "hangar-title", "HANGAR");
    this.shipReadout = el("div", "hangar-ship-readout");
    this.shipDots = el("div", "hangar-ship-dots");
    // The one thing on this screen that changes what the player flies. Only the
    // control inside it takes pointer events; the corner around it stays
    // click-through.
    this.stageAction = el("div", "hangar-stage-action");
    this.previewLoader = el("div", "hangar-preview-loading", "LOADING HULL");
    this.previewLoader.setAttribute("role", "status");
    this.previewLoader.style.display = "none";
    // The card sheet dims and covers the viewer, so it is the stage's last
    // child — above the hull and above every other overlay.
    this.sheet = el("div", "hangar-sheet-layer");
    this.sheet.style.display = "none";
    this.stageView.append(
      this.stageTitle,
      this.stageAction,
      this.previewLoader,
      ...this.stageArrows,
      this.shipReadout,
      this.shipDots,
      this.sheet,
    );
    parent.append(this.root);

    this.ships = [...this.configs.getAll<ShipConfig>("ship")].sort((a, b) => a.id.localeCompare(b.id));

    this.unsubscribeAuth = this.auth.onChange(() => {
      if (this.root.style.display !== "none") void this.refreshFromServer();
    });
    // A purchase or a paint equipped in the Shop reaches the staged hull without
    // a revisit — the ledger, not the click, is what the screen listens to.
    this.unsubscribeOwnership =
      this.ownership?.onChange(() => {
        if (this.root.style.display === "none") return;
        this.rebuildPreview();
        this.render();
      }) ?? null;

    this.root.style.display = "none";
  }

  /**
   * A module was fitted, swapped or cleared in the slots (owner 2026-08-08).
   * Assigned by the tutorial, which teaches the fitting screen and has to know
   * when the lesson actually happened; unset for every ordinary visit.
   */
  onLoadoutChanged: (() => void) | null = null;

  /** One stage-overlay arrow. `delta` is the direction it walks the bay. */
  private buildStageArrow(delta: -1 | 1): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = `hangar-stage-arrow ${delta < 0 ? "prev" : "next"}`;
    btn.type = "button";
    btn.setAttribute("aria-label", delta < 0 ? "Previous ship" : "Next ship");
    // A single guillemet, not an SVG: the deck's arrows are typographic (spec).
    btn.textContent = delta < 0 ? "‹" : "›";
    btn.addEventListener("click", () => this.stepShip(delta));
    return btn;
  }

  private isAuthed(): boolean {
    return this.auth.getState().status === "authed";
  }

  /**
   * Whether the screen is on. Public because a caller that is about to `show()`
   * an ALREADY-open hangar would rebuild the preview under the player's hands
   * (the tutorial's stage navigation is exactly that caller).
   */
  get isOpen(): boolean {
    return this.root.style.display !== "none";
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
    const legacy = this.offlineFitting
      ? ownsModule(this.configs, moduleId)
      : (this.apiModules.find((m) => m.id === moduleId)?.owned ?? false);
    return moduleOwned(this.ownership, moduleId, legacy);
  }

  /**
   * Whether this hull can be flown. Hull ownership currently exists only in the
   * local ledger — `/api/ships` returns the whole catalogue with no `owned`
   * flag — so an authenticated session sees every hull unlocked until the
   * server grows the same notion.
   */
  private canFly(shipId: string): boolean {
    return hullOwned(this.ownership, shipId, this.offlineFitting ? ownsShip(shipId) : true);
  }

  /** The hull the player takes into a match, as last set. */
  private mainShipId(): string | null {
    return localStorage.getItem(LS_SHIP);
  }

  private isMainShip(shipId: string): boolean {
    return this.mainShipId() === shipId;
  }

  /**
   * The hull a visit OPENS on (playtest 2026-08-23 §26). The rule is your MAIN
   * — the ship you actually fly is the one the bay should have on the pad — and
   * the only thing allowed to beat it is a carousel position from this same
   * session, so stepping out to the Shop and back does not throw away where you
   * were.
   *
   * That session position is ownership-checked, which is the other half of the
   * report: browsing onto a hull you have not bought and coming back later used
   * to open the screen on a silhouette with an empty fitting panel. A hull the
   * pilot cannot fly is never the ANSWER here, only ever somewhere they walked
   * to on purpose.
   */
  private openingShipIndex(): number {
    const mainId = this.mainShipId();
    const browsed = sessionStorage.getItem(SS_BROWSE);
    const openId = browsed && browsed !== mainId && this.canFly(browsed) ? browsed : mainId;
    const idx = openId ? this.ships.findIndex((s) => s.id === openId) : -1;
    if (idx >= 0) return idx;
    // No main, or a main this build no longer ships: the first hull that can be
    // flown, and only then the first hull at all.
    const owned = this.ships.findIndex((s) => this.canFly(s.id));
    return owned >= 0 ? owned : 0;
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
    // A transition the last visit left in flight (the player pressed an arrow
    // and went straight to the Shop) would otherwise survive as a latch that
    // keeps both arrows disabled for the rest of the session — the reported
    // "the hangar never noticed my purchase", which was really "the hangar
    // never let go of a swap".
    this.abandonSwap();
    this.refreshScope.invalidate();
    const visitToken = ++this.visitToken;
    this.resetIdlePreview();
    // A pilot who has never set a main gets one now, so "what do I fly" is
    // never an unanswered question after the first visit to the bay.
    if (!this.mainShipId()) {
      const starter = this.ships.find((s) => s.id === STARTER_SHIP_ID) ?? this.ships[0];
      if (starter) localStorage.setItem(LS_SHIP, starter.id);
    }
    this.shipIndex = this.openingShipIndex();
    const fittingContextToken = ++this.fittingContextToken;
    this.closeSheet();
    this.error = "";

    const ship = this.currentShip();
    // Every hull opens on ITS OWN loadout — the stock fit only for one never
    // fitted (owner 2026-08-22). Signed in, the real answer arrives with the
    // `/api/fittings` read below; this is the local guess until it does.
    this.slots = ship ? this.slotsForShip(ship) : [];

    this.root.style.display = "flex";
    this.mountLoadingOverlay();
    // The bay installs its own IBL for this visit. Let authored GLB PBR values
    // participate while staged, then restore the match-safe fallback in hide().
    this.assets.setHangarMaterialMode(true);
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

    this.render();
    this.applyStageViewport();
    void this.revealAfterPriorityLoad(visitToken);

    // The server's copy of this hull's loadout lands after the first paint. Adopt
    // it only if nothing has moved since — a different hull on the stage, or an
    // edit the player already made, both mean the answer is stale on arrival.
    const storedShipId = ship?.id;
    void this.refreshFromServer().then((applied) => {
      if (!applied || !this.isVisible) return;
      if (this.visitToken !== visitToken || this.fittingContextToken !== fittingContextToken) return;
      const current = this.currentShip();
      if (!current || current.id !== storedShipId) return;
      this.slots = this.slotsForShip(current);
      // Re-cache the positional list an offline match spawns from: the server's
      // answer may differ from the local guess this visit opened on.
      this.persistSelection();
      this.rebuildPreview();
      this.render();
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
    this.clearHintTimer();
    this.abandonSwap();
    this.visitToken++;
    this.root.style.display = "none";
    this.loadingOverlay?.remove();
    this.loadingOverlay = null;
    this.previewLoader.style.display = "none";
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
    this.assets.setHangarMaterialMode(false);
  }

  private mountLoadingOverlay(): void {
    this.loadingOverlay?.remove();
    const overlay = el("div", "hangar-loading-overlay");
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-label", "Loading owned ships and fitted modules");
    overlay.innerHTML = '<div class="hangar-loading-panel"><i aria-hidden="true"></i><strong>PREPARING YOUR HANGAR</strong><span>Loading owned ships and fitted systems</span></div>';
    this.loadingOverlay = overlay;
    this.root.append(overlay);
  }

  private async revealAfterPriorityLoad(visitToken: number): Promise<void> {
    try {
      await this.awaitOwnership();
      if (!this.isVisible || this.visitToken !== visitToken) return;
      const owned = new Set(this.ownership?.ownedShips() ?? []);
      const current = this.currentShip();
      if (current && this.canFly(current.id)) owned.add(current.id);
      const selection = loadHangarSelection();
      await this.modelQueue.loadBlocking(hangarPriorityJobs(this.configs, owned, selection));
      if (!this.isVisible || this.visitToken !== visitToken) return;
      this.loadingOverlay?.remove();
      this.loadingOverlay = null;
      this.rebuildPreview();
      this.frameShip(this.stageAspectNow());
      this.render();
      for (const job of allHangarShipJobs(this.configs)) void this.modelQueue.enqueue(job);
    } catch (error) {
      if (!this.isVisible || this.visitToken !== visitToken) return;
      log.warn("priority hangar asset load failed", error);
      this.loadingOverlay?.remove();
      this.loadingOverlay = null;
      this.rebuildPreview();
      this.render();
    }
  }

  private async refreshFromServer(): Promise<boolean> {
    const request = this.refreshScope.begin();
    if (!this.isAuthed()) {
      if (!this.refreshScope.isCurrent(request.token, request.signal) || !this.isVisible) return false;
      this.apiShips = [];
      this.apiModules = [];
      // Offline test mode: the loadouts live in localStorage instead, and are
      // read per hull on demand — there is no list to hold here.
      this.serverLoadouts.clear();
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
      // One row per hull since 2026-08-22; a duplicate could only come from a
      // pre-migration server, and last-wins matches the migration's own rule.
      this.serverLoadouts = new Map(fittingsRes.fittings.map((f) => [f.ship_id, f.hardpointMap]));
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
    if (ship.render.model && !this.modelQueue.hasLoaded(loadingFor) && !this.modelsRequested.has(loadingFor)) {
      this.modelsRequested.add(loadingFor);
      this.previewLoader.style.display = "flex";
      void this.modelQueue.prioritize({ id: loadingFor, render: ship.render }).then(() => {
        this.modelsRequested.delete(loadingFor);
        if (this.currentShip()?.id !== loadingFor) return;
        if (this.root.style.display === "none") return;
        this.previewLoader.style.display = "none";
        this.rebuildPreview();
        this.frameShip(this.stageAspectNow());
      });
    } else if (this.modelQueue.hasLoaded(loadingFor)) {
      this.previewLoader.style.display = "none";
    }

    // The hull wears whatever paint the pilot has equipped on it; an absent
    // selection is the authored look (contract §1).
    const master = this.paint.masterFor(
      this.assets.getShipMaster(ship.render),
      ship,
      this.ownership?.selectedCosmetic(ship.id) ?? null,
    );

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
    pinInstanceLod0(instance);
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
      { isLocal: true },
      cosmeticById(this.configs, this.ownership?.selectedCosmetic(ship.id) ?? ""),
    );
    this.idleModules = this.slots
      .filter((s): s is HangarSlot & { moduleId: string } => s.moduleId !== null)
      .map((s) => ({ moduleId: s.moduleId, hardpointIndex: s.hardpointIndex, state: "active", energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, channeling: false, shieldPool: 0 }) satisfies ModuleSnapshot);
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
    const hull = this.previewInstance ?? this.lockedPreview;
    if (hull) this.bay.addShadowCaster(hull);
  }

  /** The shared black translucent material every locked hull is painted with. */
  private lockedShipMaterial(): StandardMaterial {
    if (this.lockedMaterial) return this.lockedMaterial;
    const mat = new StandardMaterial("hangarLockedShip", this.scene);
    // Dark, but no longer a HOLE (playtest §30: "the model renders almost black
    // so you cannot see what you'd be buying"). The diffuse stays near-black so
    // the bay's lamps only ever graze it — the hull's detail is still the thing
    // being sold — while the emissive floor lifts the whole silhouette off the
    // black bay floor it was disappearing into.
    mat.diffuseColor = new Color3(0.06, 0.07, 0.1);
    mat.specularColor = new Color3(0.05, 0.06, 0.08);
    mat.emissiveColor = new Color3(0.1, 0.13, 0.19);
    mat.alpha = 0.6;
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
    // No docked band any more (owner 2026-08-22): the characteristics moved into
    // the deck's BEFORE / AFTER box, so the viewer is the whole stage half again
    // and only the split ratio differs between the two orientations.
    this.camera.setStageViewport(stageViewport(w, h, this.stageFraction(w, h)));
    this.frameShip(stageAspect(w, h, this.stageFraction(w, h)));
  }

  /** The viewer's share of the screen — see {@link DECK_STAGE_FRACTION}. */
  private stageFraction(width: number, height: number): number {
    return isLandscape(width, height) ? DECK_STAGE_FRACTION : STAGE_FRACTION;
  }

  /** Aspect of the rectangle the hull is framed in, for the current viewport. */
  private stageAspectNow(): number {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    return stageAspect(w, h, this.stageFraction(w, h));
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
    this.tickSwap();

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
   * THE loadout for one hull — server-side when signed in, `localStorage` when
   * not. The single place that knows which store is in force, so nothing else
   * in the screen has to branch on the account state to read a fit.
   *
   * Null means "never fitted this hull", which is a different answer from "an
   * empty loadout": the caller opens the hull on its stock `defaultFitting`
   * rather than on a bare hull nobody chose.
   */
  private storedLoadout(shipId: string): HardpointMap | null {
    if (this.offlineFitting) return loadLocalLoadout(shipId);
    return this.serverLoadouts.get(shipId) ?? null;
  }

  /**
   * The slot grid to open a hull on: that hull's own loadout, or its stock
   * fitting if it has never been fitted. Every hull carries its own since
   * 2026-08-22 — browsing the bay shows each ship as the pilot last left it, and
   * still never touches which hull is MAIN.
   */
  private slotsForShip(ship: ShipConfig): HangarSlot[] {
    const stored = this.storedLoadout(ship.id);
    if (!stored) return slotsFromDefaultFitting(ship);
    // The family lookup is what lets a loadout stored against an OLDER socket
    // layout degrade to empty slots instead of an illegal fit.
    return slotsFromHardpointMap(ship, stored, (id) => this.configs.get<ModuleConfig>("module", id)?.family);
  }

  private selectShip(index: number): void {
    this.shipIndex = index;
    this.fittingContextToken++;
    // A sheet belongs to a socket on the hull that opened it; the next hull may
    // not even have that socket, so switching ships always closes it — and
    // closing is what commits the before/after baseline (spec).
    this.closeSheet();
    const ship = this.currentShip();
    this.slots = ship ? this.slotsForShip(ship) : [];
    // Browsing is NOT choosing (2026-07-31): remember where the carousel is,
    // but leave the main loadout exactly as it was.
    this.persistBrowse();
    this.rebuildPreview();
    // A different hull is a different size: re-frame it. (Swapping a MODULE
    // deliberately does not, so an edit never yanks the player's zoom back.)
    this.frameShip(this.stageAspectNow());
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
    this.swap = { direction: delta, startedAtMs: swapNowMs(), distance, applied: false };
    this.setArrowsEnabled(false);
    // The slide is DECORATION; the hull change is not. A screen that stops
    // receiving render frames must still end up on the ship the player asked
    // for, so the commit has a timer of its own rather than living or dying
    // with the animation.
    this.clearSwapGuard();
    this.swapGuard = setTimeout(() => this.settleSwap(), SWAP_DURATION_SEC * 1000 + SWAP_GUARD_SLACK_MS);
  }

  /**
   * Go straight to one hull, from its dot (playtest §27). No slide: the arrows
   * animate one step because the motion IS the "next ship along", and a jump of
   * four bays has no such story to tell — it is a direct pick, so it lands the
   * way pressing a tab does.
   */
  private jumpToShip(index: number): void {
    if (this.busy || this.swap || index === this.shipIndex) return;
    if (index < 0 || index >= this.ships.length) return;
    this.selectShip(index);
  }

  private clearSwapGuard(): void {
    if (this.swapGuard === null) return;
    clearTimeout(this.swapGuard);
    this.swapGuard = null;
  }

  /**
   * End the transition wherever it got to: commit the hull if the midpoint was
   * never reached, park the pivot, and hand the arrows back. Reached from the
   * animation's own last frame and from the wall-clock guard, so "the swap is
   * over" has exactly one meaning however it finished.
   */
  private settleSwap(): void {
    const swap = this.swap;
    if (!swap) return;
    this.clearSwapGuard();
    this.swap = null;
    if (!swap.applied) this.selectShip(wrapIndex(this.shipIndex, swap.direction, this.ships.length));
    this.shipPivot.position.setAll(0);
    this.setPreviewVisibility(1);
    this.setArrowsEnabled(true);
  }

  /** Drop a transition without committing it (leaving the screen, disposal). */
  private abandonSwap(): void {
    this.clearSwapGuard();
    this.swap = null;
    this.shipPivot.position.setAll(0);
    this.setPreviewVisibility(1);
  }

  /** Advance an in-flight swap; called from the per-frame preview tick. */
  private tickSwap(): void {
    const swap = this.swap;
    if (!swap) return;
    const elapsed = Math.max(0, (swapNowMs() - swap.startedAtMs) / 1000);
    const frame = swapFrame(elapsed, swap.direction, swap.distance, SWAP_DURATION_SEC);

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
    if (frame.done) this.settleSwap();
  }

  private setPreviewVisibility(v: number): void {
    if (this.previewInstance) this.previewInstance.visibility = v;
    if (this.lockedPreview) this.lockedPreview.visibility = v;
  }

  /**
   * Enabled unless a step is genuinely impossible right now. Called from
   * `render()` as well as from the transition, so no path can leave the bay
   * unwalkable: the arrows are a function of the screen's state, never a latch
   * something has to remember to release.
   *
   * The DOTS walk the same bay under exactly the same conditions, so they are
   * decided here too rather than where they are built — a transition that ends
   * without a re-render (the common case: the midpoint renders, the last frame
   * does not) would otherwise leave them latched off.
   */
  private setArrowsEnabled(enabled = true): void {
    const blocked = !enabled || this.busy || this.swap !== null || this.ships.length < 2;
    for (const btn of this.stageArrows) btn.disabled = blocked;
    for (const dot of this.shipDots.querySelectorAll<HTMLButtonElement>("button")) dot.disabled = blocked;
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
  private async buyShip(shipId: string): Promise<void> {
    if (this.ownership) {
      this.busy = true;
      this.render();
      try {
        await this.ownership.buyShip(shipId);
      } catch (err) {
        this.error = errorMessage(err, "Purchase failed");
      }
      this.busy = false;
      if (!this.isVisible) return;
      this.afterHullUnlock();
      return;
    }
    if (this.offlineFitting) {
      buyShipLocal(shipId);
      this.afterHullUnlock();
    }
  }

  /** An unlocked hull stops being a silhouette, so the stage is rebuilt around it. */
  private afterHullUnlock(): void {
    this.rebuildPreview();
    this.frameShip(this.stageAspectNow());
    this.render();
  }

  /**
   * Tap a slot tile: slide its card sheet up over the foot of the viewer, or
   * close the one already open for it (spec — the tile toggles).
   *
   * Opening is where the BEFORE side of the compare box is captured: everything
   * the pilot does while the sheet is up reads against the fit they opened it
   * on, however many modules they try in between.
   */
  private selectSlot(hardpointIndex: number): void {
    if (!this.slots[hardpointIndex]) return;
    const open = this.sheetSlot === hardpointIndex;
    this.closeSheet();
    if (!open) {
      this.sheetSlot = hardpointIndex;
      this.baseFits = fittedModuleIdsOf(this.slots);
      // A fresh sheet starts at its first card, whatever the last one showed.
      this.cardScrollLeft = 0;
      this.raisePreviewHint();
    }
    this.render();
  }

  /**
   * Close the sheet and COMMIT: dropping {@link baseFits} is what collapses the
   * before/after box back to a single column of current readings, which the
   * next sheet then becomes the new baseline for. Reached from DONE, from the
   * dim, and from every path that changes hull — the fit itself was already
   * saved by each {@link equip}, so there is nothing else to write.
   */
  private closeSheet(): void {
    this.cancelHold();
    this.dismissPreviewHint();
    this.sheetSlot = null;
    this.baseFits = null;
    this.rowDragged = false;
    this.preview = null;
    this.previewPinned = false;
  }

  private equip(hardpointIndex: number, moduleId: string | null): void {
    const slot = this.slots[hardpointIndex];
    if (!slot) return;
    slot.moduleId = moduleId;
    // Announced before the re-render, so a listener that reads the screen (the
    // tutorial's coach mark) sees the fit it is reacting to.
    this.onLoadoutChanged?.();
    this.fittingContextToken++;
    // Picking a card fits it and KEEPS THE SHEET OPEN (spec): the point of the
    // sheet is to try modules against each other, so only DONE / the dim / a
    // hull change close it. The ghost goes, though — the AFTER column is now
    // the real fit rather than a projection of it.
    this.preview = null;
    this.previewPinned = false;
    // Fitting IS saving (owner 2026-08-22). There is no submenu to confirm in,
    // so the write happens here or nowhere.
    this.persistLoadout();
    this.persistSelection();
    this.rebuildPreview();
    this.render();
  }

  /*
   * There is no BUY here any more (owner 2026-08-22). The sheet is a menu of
   * modules, not a shopfront: an unowned one shows greyed out at the third of
   * opacity the spec asks for and does nothing when pressed, and the Shop —
   * which is the screen that spends credits — is where it is bought. The
   * Hangar's own unlock path survives only for HULLS, whose purchase still lives
   * in the stage's action corner because there is nowhere else to put it.
   */

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

  /**
   * Write what is in the slots as THIS hull's loadout. Called from every slot
   * edit, because since 2026-08-22 fitting a module IS saving it — there is no
   * name to type, no fitting to select and no button to press.
   *
   * The write is FIRE-AND-FORGET when signed in, and the local map is updated
   * before it goes out. A hangar that blocked on a round trip per slot would
   * make fitting feel like filing paperwork, and the optimism costs nothing that
   * matters: the server re-validates ownership and family on every write, so the
   * worst case is an error line and a screen that re-reads the truth on the next
   * visit. It is also why a rejected write puts the message on screen rather
   * than silently reverting the slot the player is looking at.
   */
  private persistLoadout(): void {
    const ship = this.currentShip();
    if (!ship) return;
    const hardpointMap = buildHardpointMap(this.slots);

    if (this.offlineFitting) {
      saveLocalLoadout(ship.id, hardpointMap);
      return;
    }
    this.serverLoadouts.set(ship.id, hardpointMap);
    void this.api.saveLoadout(ship.id, hardpointMap).catch((err: unknown) => {
      if (!this.isVisible || this.currentShip()?.id !== ship.id) return;
      this.error = errorMessage(err, "Could not save this fit");
      this.render();
    });
  }

  /**
   * Remember where the carousel is, for this session only. Presentation — never
   * flown, and never carried into the next launch (see {@link SS_BROWSE}).
   */
  private persistBrowse(): void {
    const shipId = this.currentShip()?.id;
    if (shipId) sessionStorage.setItem(SS_BROWSE, shipId);
    else sessionStorage.removeItem(SS_BROWSE);
    // The key this used to live under, from before it was session-scoped. Left
    // behind it would be nothing but a stale answer to a question nobody asks.
    localStorage.removeItem(SS_BROWSE);
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
    // Stored WITH the ship id: `loadCachedUpgrades` refuses levels belonging to
    // another hull. Dropped entirely for an unauthenticated visitor, whose
    // `apiShips` list is empty and whose levels are therefore unknown, not zero.
    if (shipId && this.apiShips.some((s) => s.id === shipId)) {
      localStorage.setItem(LS_UPGRADES, JSON.stringify({ shipId, levels: this.currentUpgradeLevels() }));
    } else {
      localStorage.removeItem(LS_UPGRADES);
    }
    // The MAIN hull's loadout in POSITIONAL form — the shape an offline match
    // spawns from. A cache of what the per-hull store already holds, kept here
    // because the match path has no ConfigService lookup to turn a hardpoint map
    // back into slot order, and re-derived on every fit change so walking
    // straight out of the Hangar flies exactly what is on screen.
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
    this.renderCompare();
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
    this.renderCompare();
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
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-preview-module]")) {
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
   * Press-and-hold on a module card (owner 2026-08-22). A finger has no hover to
   * give, and the designer's intent for the compare box is explicit — "see the
   * delta before committing" — so resting on an item for {@link PRESS_HOLD_MS}
   * raises the same preview a mouse gets for free. The release that follows is
   * then swallowed by {@link consumeHold}, because a pilot who held an item to
   * read its numbers has not asked to fit it.
   */
  private startHold(hardpointIndex: number, moduleId: string | null): void {
    this.cancelHold();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.holdFired = true;
      this.considerModule(hardpointIndex, moduleId, true);
      // The pilot has just done the thing the hint describes: it has said all
      // it has to say, and it goes without disturbing the card under the finger.
      this.dismissPreviewHint();
    }, PRESS_HOLD_MS);
  }

  private cancelHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** True when the click that just arrived was the end of a preview hold. */
  private consumeHold(): boolean {
    const held = this.holdFired;
    this.holdFired = false;
    this.cancelHold();
    return held;
  }

  // --- the loadout deck ----------------------------------------------------

  /**
   * The BEFORE / AFTER compare box (spec: "SHIP SPECS — BEFORE / AFTER").
   *
   * Four readings — INTEGRITY, SPEED, DPS and POWER — and what the two columns
   * mean depends on whether a sheet is open:
   *
   *  - CLOSED: one column, the fit as it stands. There is nothing to compare it
   *    against, because closing the sheet is what made it the baseline.
   *  - OPEN: BEFORE is the snapshot {@link selectSlot} took, AFTER is the fit
   *    NOW — or, while a card is hovered or press-held, the fit that card would
   *    produce. So a pilot who fits three guns in a row still reads the running
   *    total against what they walked in with.
   *
   * Rewritten in place rather than through `render()`, because a rebuild would
   * destroy the card the pointer is resting on.
   */
  private renderCompare(): void {
    const box = this.compare;
    if (!box) return;
    const open = this.sheetSlot !== null;
    const current = fittedModuleIdsOf(this.slots);
    const base = this.statPanelFor(open && this.baseFits ? this.baseFits : current);
    box.innerHTML = "";
    if (!base) {
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    // `previewModuleIds` is null when nothing is being weighed up OR when the
    // candidate is already in its slot; with the sheet open both mean "AFTER is
    // simply the fit as it stands", which is exactly what the box should read.
    const targetIds = this.previewModuleIds() ?? (open ? current : null);
    const ghost = targetIds ? this.statPanelFor(targetIds) : null;
    box.classList.toggle("previewing", this.preview !== null);
    box.append(el("span", "hangar-compare-title", "SHIP SPECS — BEFORE / AFTER"));
    for (const row of deckCompareRows(base, ghost)) box.append(compareRow(row));
  }

  /**
   * Everything drawn OVER the 3D viewer that is not the sheet: the title, the
   * hull's name and class, the bay dots and the one action that changes what the
   * player flies. Refreshed together because they all describe the staged hull.
   */
  private renderStageChrome(): void {
    const ship = this.currentShip();
    this.shipReadout.innerHTML = "";
    this.shipDots.innerHTML = "";
    if (ship) {
      this.shipReadout.append(
        el("span", "hangar-ship-name", (ship.name ?? ship.id).toUpperCase()),
        el("span", "hangar-ship-class", `${ship.class} hull`.toUpperCase()),
      );
    }
    // One dot per hull in the bay — the carousel's position, and the twin of the
    // ‹ › arrows either side of it. Each one is a real CONTROL (playtest §27):
    // the row shipped `pointer-events: none` over 22×4px marks, so every tap
    // aimed at a dot fell through to the 3D canvas and stepping the bay was
    // arrows-only. The bar stays 22×4; the button around it is the touch target.
    for (let i = 0; i < this.ships.length; i++) {
      const hull = this.ships[i]!;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "hangar-ship-dot" + (i === this.shipIndex ? " active" : "");
      dot.dataset["ship"] = hull.id;
      dot.setAttribute("aria-label", `Show ${hull.name ?? hull.id}`);
      if (i === this.shipIndex) dot.setAttribute("aria-current", "true");
      // Enabled by `setArrowsEnabled`, which render() calls immediately after
      // this — see there for why that is the only place either control's state
      // is decided.
      dot.addEventListener("click", () => this.jumpToShip(i));
      this.shipDots.append(dot);
    }
    this.shipDots.style.display = this.ships.length > 1 ? "" : "none";
    this.renderStageAction();
  }

  /**
   * The hull ACTION, top-right of the 3D viewer (owner 2026-08-08). One slot,
   * and OWNERSHIP decides what is in it:
   *
   *  - not bought → the LOCKED badge and the unlock, because that is the only
   *    thing this hull can do for you yet;
   *  - bought, not your main → "★ Set as main", the single point at which
   *    browsing the bay turns into a decision;
   *  - already your main → the badge saying so, and nothing to press.
   *
   * It sits in the viewer rather than the deck so the decision is where the ship
   * is: you look at the hull, then you take it.
   */
  private renderStageAction(): void {
    this.stageAction.innerHTML = "";
    const ship = this.currentShip();
    if (!ship) {
      this.stageAction.style.display = "none";
      return;
    }
    this.stageAction.style.display = "";

    if (!this.canFly(ship.id)) {
      this.stageAction.append(el("span", "hangar-badge locked", "LOCKED"));
      const buy = document.createElement("button");
      buy.className = "hangar-btn hangar-btn-primary hangar-stage-btn sa-button sa-button--primary";
      // Free for now (testing) — the purchase still has to happen, so the flow
      // is the real one and only the price is provisional.
      buy.type = "button";
      buy.textContent = `Buy · ${priceLabel(0)}`;
      buy.disabled = this.busy || !(this.ownership || this.offlineFitting);
      buy.addEventListener("click", () => void this.buyShip(ship.id));
      this.stageAction.append(buy);
      return;
    }

    if (this.isMainShip(ship.id)) {
      const badge = el("span", "hangar-badge main hangar-stage-badge", "★ MAIN");
      badge.title = "This ship and fitting is what you fly.";
      this.stageAction.append(badge);
      return;
    }

    const main = document.createElement("button");
    main.className = "hangar-btn hangar-btn-primary hangar-stage-btn sa-button sa-button--primary";
    main.type = "button";
    main.textContent = "★ Set as main";
    main.disabled = this.busy;
    main.addEventListener("click", () => this.setAsMain());
    this.stageAction.append(main);
  }

  /**
   * The MODULE SHEET: the modules one socket accepts, as a row of cards that
   * slides up over the foot of the viewer (spec, replacing the earlier radial).
   *
   * A FLAT list, one card per module the socket takes — the tier ladders are
   * being reworked, and a picker that grouped them would only have to be
   * ungrouped again. Unowned candidates are still SEEN, at the third of opacity
   * the spec gives "unavailable", rather than hidden until they are bought: the
   * Shop is where they are bought, and a menu that hides what you are missing
   * cannot tell you what to go and buy.
   *
   * Built into {@link sheet} rather than by `render()`, because the whole thing
   * is anchored to the VIEWER half — the dim covers the ship, not the deck.
   */
  private renderSheet(): void {
    this.sheet.innerHTML = "";
    const index = this.sheetSlot;
    const slot = index === null ? undefined : this.slots[index];
    if (index === null || !slot) {
      this.sheet.style.display = "none";
      return;
    }
    this.sheet.style.display = "";

    // Tapping the dim closes the picker and COMMITS, exactly as DONE does —
    // there is nothing to cancel, because every pick was already saved.
    const dim = el("div", "hangar-sheet-dim");
    dim.addEventListener("click", () => {
      this.closeSheet();
      this.render();
    });

    const panel = el("div", "hangar-sheet");
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", `Fit ${slotLabel(slot.socketId)}`);
    panel.append(this.buildSheetHead(slot, index));
    // Above the cards, and only ever once: the row is the thing it is talking
    // about, and the sheet is anchored to the viewer's foot, so a hint that
    // leaves takes its own space with it without moving a single card.
    if (this.previewHintVisible) panel.append(buildPreviewHint());
    panel.append(this.buildCardDeck(slot, index));
    this.sheet.append(dim, panel);
  }

  /**
   * Raise the one-time press-and-hold hint (playtest §37). "The preview
   * interaction is undiscoverable on a phone": there is no hover on touch, so
   * the compare box only answers a 260ms hold, and a pilot who taps normally
   * commits the fit and never sees the comparison the panel exists for.
   *
   * Marked SEEN the moment it goes up rather than when it comes down — it is an
   * introduction, and one that reappeared because the last sheet was closed
   * quickly would stop being one.
   */
  private raisePreviewHint(): void {
    if (this.previewHintVisible || localStorage.getItem(LS_PREVIEW_HINT) === "1") return;
    this.previewHintVisible = true;
    localStorage.setItem(LS_PREVIEW_HINT, "1");
    this.clearHintTimer();
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.dismissPreviewHint();
    }, PREVIEW_HINT_MS);
  }

  /**
   * Take the hint down — its few seconds are up, the pilot has just done the
   * thing it describes, or the sheet is closing.
   *
   * Removed from the DOM in place rather than through {@link renderSheet},
   * because the first hold is one of the ways this is reached and rebuilding
   * the row would destroy the very card the finger is resting on.
   */
  private dismissPreviewHint(): void {
    this.clearHintTimer();
    if (!this.previewHintVisible) return;
    this.previewHintVisible = false;
    this.sheet.querySelector(".hangar-sheet-hint")?.remove();
  }

  private clearHintTimer(): void {
    if (this.hintTimer === null) return;
    clearTimeout(this.hintTimer);
    this.hintTimer = null;
  }

  /** The sheet's title, and its two buttons: CLEAR SLOT and DONE ✓ (spec). */
  private buildSheetHead(slot: HangarSlot, index: number): HTMLDivElement {
    const head = el("div", "hangar-sheet-head");
    head.append(el("span", "hangar-sheet-title", `FIT — ${slotLabel(slot.socketId)}`));

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "hangar-sheet-clear";
    clear.textContent = "CLEAR SLOT";
    clear.disabled = this.busy;
    clear.dataset["previewModule"] = "";
    // Emptying the slot previews like any other change: the AFTER column ghosts
    // DOWN by exactly what the fitted module was giving.
    this.bindPreviewSignals(clear, index, null, { pinOnClick: false });
    clear.addEventListener("pointerdown", () => this.startHold(index, null));
    for (const end of ["pointerup", "pointerleave", "pointercancel"] as const) {
      clear.addEventListener(end, () => this.cancelHold());
    }
    clear.addEventListener("click", () => {
      // A hold was a question, not an answer.
      if (this.consumeHold()) return;
      // CLEAR keeps the sheet open (spec), so on an empty slot it does nothing
      // at all rather than doubling as a second way out.
      if (slot.moduleId === null) return;
      this.equip(index, null);
    });

    const done = document.createElement("button");
    done.type = "button";
    done.className = "hangar-sheet-done";
    done.textContent = "DONE ✓";
    done.disabled = this.busy;
    done.addEventListener("click", () => {
      this.closeSheet();
      this.render();
    });

    const actions = el("div", "hangar-sheet-actions");
    actions.append(clear, done);
    head.append(actions);
    return head;
  }

  /**
   * The card row and the three things that say it SCROLLS (playtest match §2).
   *
   * A sheet 519px wide showed five of twenty-one modules, cut off flush at a
   * card boundary with no arrow, no peeking card and no scrollbar — so the row
   * read as a row that ends, and a tap aimed at the sixth card (which still
   * reports an on-screen bounding box) silently did nothing. All three are back:
   * the cards are sized so a half one always shows past the fold, a gradient
   * fades the row out into it, and a chevron walks it for anyone who would
   * rather press than swipe. Every one of them is hidden the moment the row
   * genuinely fits, and the chevron goes when there is no more row to walk.
   */
  private buildCardDeck(slot: HangarSlot, index: number): HTMLDivElement {
    const deck = el("div", "hangar-card-deck");
    const row = this.buildCardRow(slot, index);
    const fade = el("div", "hangar-card-fade");
    fade.setAttribute("aria-hidden", "true");

    const more = document.createElement("button");
    more.type = "button";
    more.className = "hangar-card-more";
    more.setAttribute("aria-label", "Scroll to more modules");
    // A guillemet, matching the bay arrows either side of the ship (spec).
    more.textContent = "›";
    more.addEventListener("click", () => {
      const page = row.clientWidth > 0 ? row.clientWidth * 0.8 : CARD_STEP_PX;
      row.scrollLeft += page;
      this.cardScrollLeft = row.scrollLeft;
      syncCardAffordance(deck, row);
    });

    row.addEventListener("scroll", () => syncCardAffordance(deck, row));
    deck.append(row, fade, more);
    syncCardAffordance(deck, row);
    return deck;
  }

  /**
   * The scrolling card row. A finger swipes it natively; a mouse gets the two
   * affordances the spec asks for, because a desktop has neither:
   *
   *  - the WHEEL maps `deltaY` (plus whatever `deltaX` a trackpad sends) onto
   *    `scrollLeft`, so a vertical wheel walks the row;
   *  - a click-DRAG pans it, and a press that travelled further than
   *    {@link ROW_DRAG_SLOP_PX} suppresses the click that ends it — a drag must
   *    never fit whatever card happened to be under the pointer when it stopped.
   */
  private buildCardRow(slot: HangarSlot, index: number): HTMLDivElement {
    const row = el("div", "hangar-card-row");
    for (const mod of this.slotCandidates(slot)) row.append(this.buildModuleCard(slot, index, mod));

    row.addEventListener(
      "wheel",
      (ev) => {
        row.scrollLeft += ev.deltaY + ev.deltaX;
        this.cardScrollLeft = row.scrollLeft;
        // Claim the gesture: an unclaimed wheel over a full-bleed overlay
        // scrolls whatever is behind it instead.
        ev.preventDefault();
      },
      { passive: false },
    );
    row.addEventListener("mousedown", (ev) => this.beginRowDrag(row, ev));
    row.addEventListener("scroll", () => {
      this.cardScrollLeft = row.scrollLeft;
    });
    // Back to where the row was before the fit that rebuilt it: the sheet stays
    // open when a card is picked, and one that snapped to its first card every
    // time would lose the pilot's place on every try.
    row.scrollLeft = this.cardScrollLeft;
    return row;
  }

  /** Pan the card row with the mouse, remembering whether it actually moved. */
  private beginRowDrag(row: HTMLDivElement, ev: MouseEvent): void {
    this.rowDragged = false;
    const startX = ev.clientX;
    const startScroll = row.scrollLeft;
    const move = (moveEv: MouseEvent): void => {
      const dx = moveEv.clientX - startX;
      if (Math.abs(dx) > ROW_DRAG_SLOP_PX) this.rowDragged = true;
      row.scrollLeft = startScroll - dx;
      this.cardScrollLeft = row.scrollLeft;
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // The click lands AFTER mouseup, so the flag has to outlive this handler
      // by exactly one task — long enough for the card to read it, no longer.
      setTimeout(() => {
        this.rowDragged = false;
      }, 0);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /**
   * Every module this socket accepts, lowest tier first — a FLAT list (owner
   * 2026-08-22 amendment). The radial grouped a socket's candidates into lines
   * because a fan of twenty buttons is unreadable; a row that scrolls has no
   * such limit, and the tier ladders themselves are being reworked, so the
   * picker offers the catalogue rather than a shape of it that will not survive.
   */
  private slotCandidates(slot: HangarSlot): ModuleConfig[] {
    return this.configs
      .getAll<ModuleConfig>("module")
      .filter((m) => slotAccepts(slot, m.family))
      .sort((a, b) => a.level - b.level || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  /**
   * One module card: its ICON (never a letter acronym — spec), its name, and
   * the line of what it buys, pinned to the card's foot.
   *
   * There is no `×N` count badge. The spec draws one, but ownership in this
   * game is BINARY — `OwnershipStore` holds a set of unlocked ids and no
   * quantities anywhere — so a count could only be invented, and one unlocked
   * module may legally sit in two sockets at once (the brawler's stock fit
   * carries the same generator twice). "Unavailable" here means UNLOCKED-NO.
   */
  private buildModuleCard(slot: HangarSlot, index: number, mod: ModuleConfig): HTMLButtonElement {
    const fitted = slot.moduleId === mod.id;
    // Unlocked, or already in this socket — a module can outlive the licence
    // that bought it, and the honest thing is to keep showing what is fitted.
    const usable = this.canEquip(mod.id) || fitted;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `hangar-card${fitted ? " fitted" : ""}${usable ? "" : " unavailable"}`;
    btn.dataset["module"] = mod.id;
    btn.disabled = this.busy || !usable;

    const icon = el("span", "hangar-card-icon");
    icon.innerHTML = moduleIconSvg(moduleIconId(mod));
    btn.append(icon);
    btn.append(el("span", "hangar-card-name", mod.name ?? mod.id));
    btn.append(el("span", "hangar-card-stat", moduleStatLine(mod)));
    if (!usable) {
      // WHY it cannot be fitted (playtest §38: an unavailable card was greyed
      // and otherwise silent — no badge, no price, no "requires level N", and a
      // `title` a phone never shows). The level gate is the reason worth naming
      // when content authors one, because it is the one the pilot cannot fix by
      // spending credits; everything else is "you have not bought this yet".
      const tag = el("span", "hangar-card-tag", this.moduleGateTag(mod));
      btn.append(tag);
      btn.setAttribute("aria-label", `${mod.name ?? mod.id} — ${tag.textContent ?? ""}`);
      return btn;
    }

    btn.dataset["previewModule"] = mod.id;
    this.bindPreviewSignals(btn, index, mod.id, { pinOnClick: false });
    btn.addEventListener("pointerdown", () => this.startHold(index, mod.id));
    for (const end of ["pointerup", "pointerleave", "pointercancel"] as const) {
      btn.addEventListener(end, () => this.cancelHold());
    }
    btn.addEventListener("click", () => {
      // A pan that happened to finish over a card is not a pick (spec).
      if (this.rowDragged) return;
      // …and neither is a press-hold, which has already put the delta on screen
      // and must not fit the module the pilot was only weighing up.
      if (this.consumeHold()) return;
      this.equip(index, mod.id);
    });
    return btn;
  }

  /**
   * WHY an unavailable card cannot be fitted, short enough for a 96px card
   * (playtest §38). `LV 3` while a level gate is genuinely shut — that number is
   * the one the Shop's own refusal quotes, and it is the reason credits cannot
   * fix — and the plain lock for every "you have not bought this yet", which is
   * the only reason there is in offline fitting, where gates do not apply.
   */
  private moduleGateTag(mod: ModuleConfig): string {
    const requires = mod.requiresLevel ?? 0;
    const state = this.auth.getState();
    const gated = state.status === "authed" && requires > state.profile.level;
    return gated ? `LV ${requires}` : "LOCKED";
  }

  // --- rendering ---------------------------------------------------------

  /**
   * The LOADOUT DECK (owner 2026-08-22) — the right half of the screen, top to
   * bottom: the HARDPOINTS heading and BACK, a grid of hardpoint tiles, the
   * CORE / INTERNAL heading and its tiles, the before/after compare box, the
   * upgrade tracks, and — pinned to the foot — the power pips and the skin
   * swatches.
   *
   * There is no rail and no picker in the deck itself: a slot tile IS the
   * control, and what it opens is the card sheet over the ship rather than a
   * list under itself.
   */
  private render(): void {
    const ship = this.currentShip();
    // A full render rebuilds the sheet, so whatever card the pointer was over no
    // longer exists: the ghost goes with it. The sheet itself STAYS open — only
    // {@link closeSheet} closes it — so `sheetSlot` and `baseFits` survive.
    this.preview = null;
    this.previewPinned = false;
    this.cancelHold();
    this.holdFired = false;
    this.panel.innerHTML = "";
    this.compare = null;
    this.renderStageChrome();
    this.setArrowsEnabled();
    if (!ship) {
      this.renderSheet();
      return;
    }

    const owned = this.canFly(ship.id);
    // A hull you have not bought has nothing to outfit, so its sheet can never
    // be open — and the one thing you CAN do with it lives on the stage.
    if (!owned) this.closeSheet();

    this.panel.append(this.buildDeckHead(owned));

    const body = el("div", "hangar-deck-body");
    if (this.error) body.append(el("div", "hangar-error", this.error));
    if (!owned) {
      body.append(this.buildLockedBrief(ship));
      body.append(el("div", "hangar-hint", "You do not own this hull yet — buy it on the stage to fit and fly it."));
    } else {
      body.append(this.buildTileGrid("hardpoint"));
      body.append(el("span", "hangar-section-title", "CORE / INTERNAL"));
      body.append(this.buildTileGrid("internal"));
    }
    this.panel.append(body);

    // The compare box, the upgrades, the pips and the skins are PINNED under
    // the scroller. The design stacks them after the tiles, and on a 440px-tall
    // landscape phone the tiles alone fill the deck — a before/after box you
    // have to scroll to is not a before/after box, so the tiles are what
    // scrolls.
    const foot = el("div", "hangar-deck-foot");
    this.compare = el("div", "hangar-compare");
    foot.append(this.compare);
    // The upgrade tracks (owner 2026-08-08) are the hull's own internals and
    // this screen is still the only place they can be bought — the Shop sells
    // hulls, modules and paints. The spec does not draw them, so they take the
    // one seam it leaves: between the specs box and the power row, where they
    // read as more of the same hull's numbers rather than as a second picker.
    if (owned) foot.append(this.buildUpgrades(ship, !this.isAuthed()));
    foot.append(this.buildPowerRow());
    if (owned) foot.append(this.buildSkinRow(ship));
    this.panel.append(foot);

    this.renderCompare();
    this.renderSheet();
  }

  /**
   * What a hull you have NOT bought says about itself (playtest §30). The deck
   * has nothing to outfit, so it used to be one sentence in an empty half —
   * beside a silhouette dark enough to hide the shape it was selling. This is
   * the smallest honest answer to "what am I being offered": the class, what it
   * carries, and the two numbers that separate a light hull from a heavy one.
   */
  private buildLockedBrief(ship: ShipConfig): HTMLDivElement {
    const brief = el("div", "hangar-locked-brief");
    brief.append(el("span", "hangar-locked-class", `${ship.class} hull`.toUpperCase()));
    const hardpoints = this.slots.filter((s) => s.kind === "hardpoint").length;
    const internals = this.slots.length - hardpoints;
    const panel = this.statPanelFor(fittedModuleIdsOf(this.slots));
    const parts = [
      `${hardpoints} HARDPOINT${hardpoints === 1 ? "" : "S"}`,
      `${internals} INTERNAL${internals === 1 ? "" : "S"}`,
    ];
    if (panel) {
      parts.push(`${Math.round(panel.hullMax)} INTEGRITY`, `${Math.round(panel.nominalSpeed)} SPEED`);
    }
    brief.append(el("span", "hangar-locked-stats", parts.join(" · ")));
    return brief;
  }

  /** The deck's first row: the HARDPOINTS heading, and the way out (spec). */
  private buildDeckHead(owned: boolean): HTMLDivElement {
    const head = el("div", "hangar-deck-head");
    head.append(el("span", "hangar-section-title", owned ? "HARDPOINTS" : "HULL"));
    const close = document.createElement("button");
    close.className = "hangar-close";
    close.type = "button";
    close.textContent = "✕ BACK";
    close.disabled = this.busy;
    close.addEventListener("click", () => this.onClose());
    head.append(close);
    return head;
  }

  /**
   * One bay's tiles. A tile carries the fitted module's ICON, its name (or
   * EMPTY) and the socket's label, and pressing it toggles that socket's card
   * sheet over the ship.
   *
   * The icon, not a two-letter code (owner 2026-08-22 amendment). The codes were
   * derived initials — `moduleCode` says so itself — and a grid of eight tiles
   * reading PL / AC / MR / HS is a grid of eight things you have to have learnt.
   * An empty socket keeps the `+` it has always shown, because there is no
   * module there to draw.
   */
  private buildTileGrid(kind: "hardpoint" | "internal"): HTMLDivElement {
    const grid = el("div", "hangar-slot-grid");
    for (const slot of this.slots) {
      if (slot.kind !== kind) continue;
      const mod = slot.moduleId ? this.configs.get<ModuleConfig>("module", slot.moduleId) : undefined;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "hangar-slot" + (mod ? " filled" : "") + (this.sheetSlot === slot.hardpointIndex ? " open" : "");
      btn.dataset["kind"] = slot.kind;
      btn.dataset["socket"] = slot.socketId;
      // What is actually in the socket, for anything that has to ask without
      // reading a picture — the tutorial's coach marks, and this file's tests.
      btn.dataset["module"] = slot.moduleId ?? "";
      btn.disabled = this.busy;
      const icon = el("span", "hangar-slot-icon");
      if (mod) icon.innerHTML = moduleIconSvg(moduleIconId(mod));
      else icon.textContent = "+";
      btn.append(icon);
      btn.append(el("span", "hangar-slot-label", mod?.name ?? "EMPTY"));
      btn.append(el("span", "hangar-slot-socket", slotLabel(slot.socketId)));
      // Both lines are clipped to the tile with an ellipsis (playtest §29:
      // COUNTERMEASURE rendered as "UNTERMEASU", overflowing a 66px tile on
      // both sides and over its neighbours). What no longer fits is still on
      // the control itself, for everything that can ask rather than look.
      const socketName = slotLabel(slot.socketId);
      btn.title = `${socketName} — ${mod?.name ?? "Empty"}`;
      btn.setAttribute("aria-label", btn.title);
      btn.addEventListener("click", () => this.selectSlot(slot.hardpointIndex));
      grid.append(btn);
    }
    // The deck must NEVER scroll (owner 2026-08-23): the reference frame is two
    // tile rows tall, so a section that would wrap — five internals on a
    // four-column grid — widens to one column per socket instead of taking a
    // second row. Capped at 6 so a future many-socketed hull degrades to
    // wrapping rather than to unreadably thin tiles.
    const count = grid.childElementCount;
    if (count >= 5) grid.style.gridTemplateColumns = `repeat(${Math.min(count, 6)}, minmax(0, 1fr))`;
    return grid;
  }

  /**
   * The power budget as PIPS (spec): one per point of rail capacity, filled to
   * what the fit draws, and every filled pip turning red the moment the fit asks
   * for more than the rail can give. The pips read the CURRENT fit — the
   * projected draw is the compare box's POWER row.
   */
  private buildPowerRow(): HTMLDivElement {
    const row = el("div", "hangar-powerrow");
    row.append(el("span", "hangar-foot-label", "POWER"));
    const panel = this.statPanelFor(fittedModuleIdsOf(this.slots));
    const power = panel ? deckPower(panel) : null;
    const pips = el("div", "hangar-pips");
    for (const state of power?.pips ?? []) pips.append(el("span", `hangar-pip ${state}`));
    row.append(pips);
    row.append(el("span", "hangar-power-text" + (power?.over ? " over" : ""), power?.text ?? "—"));
    return row;
  }

  /**
   * The skin swatches (spec): the paints this account owns for this hull, the
   * equipped one ringed. A paint it does not own yet is shown dimmed and buys
   * itself on the way to being equipped — the Shop is where they are browsed,
   * this is where the one you fly is chosen.
   */
  private buildSkinRow(ship: ShipConfig): HTMLDivElement {
    const row = el("div", "hangar-skinrow");
    row.append(el("span", "hangar-foot-label", "SKIN"));
    if (!this.ownership) return row;
    for (const cosmetic of hangarSkinEntries(this.configs, this.ownership, ship.id)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `hangar-skin${cosmetic.equipped ? " equipped" : ""}${cosmetic.owned ? "" : " unowned"}`;
      btn.dataset["cosmetic"] = cosmetic.id;
      btn.title = cosmetic.owned ? cosmetic.name : `${cosmetic.name} · ${priceLabel(cosmetic.price)}`;
      btn.setAttribute("aria-label", btn.title);
      btn.disabled = this.busy || cosmetic.equipped;
      btn.style.setProperty("--skin-primary", cosmetic.primary);
      btn.style.setProperty("--skin-accent", cosmetic.accent);
      btn.addEventListener("click", () => void this.chooseSkin(ship, cosmetic, cosmetic.owned));
      row.append(btn);
    }
    return row;
  }

  private async chooseSkin(ship: ShipConfig, cosmetic: HangarSkinEntry, owned: boolean): Promise<void> {
    if (!this.ownership || this.busy) return;
    this.busy = true;
    this.error = "";
    this.render();
    try {
      await buyAndEquipSkin(this.ownership, ship.id, cosmetic.id, owned);
    } catch (err) {
      this.error = errorMessage(err, "Could not buy or equip that skin");
    } finally {
      this.busy = false;
      this.rebuildPreview();
      this.render();
    }
  }

  private buildUpgrades(ship: ShipConfig, readOnly: boolean): HTMLDivElement {
    const wrap = el("div", "hangar-upgrades");
    wrap.append(el("span", "hangar-section-title", "UPGRADES"));
    const profile = this.auth.getState();
    const credits = profile.status === "authed" ? profile.profile.credits : 0;
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
      for (let i = 0; i < maxLevel; i++) pips.append(el("span", "hangar-pip " + (i < current ? "filled" : "empty")));
      row.append(pips);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hangar-btn sa-button sa-button--secondary";
      if (!nextConfig) {
        btn.textContent = "MAX";
        btn.disabled = true;
      } else {
        // FREE, not "0 cr" (playtest §35): three buttons all reading "0 cr" is
        // read as broken data, not as a tier that costs nothing. Same label the
        // Shop and the hull buy already use.
        btn.textContent = priceLabel(nextConfig.price);
        btn.disabled = readOnly || this.busy || credits < nextConfig.price;
        btn.setAttribute("aria-label", `Upgrade ${UPGRADE_LABELS[track]} to level ${current + 1} — ${btn.textContent}`);
        btn.addEventListener("click", () => void this.upgradeTrack(track));
      }
      row.append(btn);
      wrap.append(row);
    }
    return wrap;
  }

  dispose(): void {
    this.disposed = true;
    this.hide();
    this.clearSwapGuard();
    this.unsubscribeAuth();
    this.previewRig?.dispose();
    this.previewInstance?.dispose();
    this.lockedMaterial?.dispose();
    this.lockedMaterial = null;
    this.unsubscribeOwnership?.();
    // After the preview instance above: a painted master disposed under a live
    // instance would take the staged hull with it.
    this.paint.dispose();
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

/**
 * The one-time press-and-hold hint (playtest §37), as its own node so
 * {@link Hangar.dismissPreviewHint} can lift it back out without touching a
 * card. `role="status"` rather than an alert: it is an aside, not an
 * interruption, and it must not steal the sheet's focus.
 */
function buildPreviewHint(): HTMLDivElement {
  const hint = el("div", "hangar-sheet-hint", "Hold a card to preview what it changes");
  hint.setAttribute("role", "status");
  return hint;
}

/**
 * Show the row's scroll affordances only while there is row left to scroll.
 *
 * Measured where it can be: `scrollWidth` against `clientWidth`. Where it
 * cannot — the first pass before layout, and a headless DOM — the CARD COUNT
 * stands in, because "we could not measure" must fall towards showing the
 * affordance. The bug being fixed here is a row that looked finished when it
 * was not; a fade over a row that happens to fit is a much cheaper mistake.
 */
function syncCardAffordance(deck: HTMLElement, row: HTMLElement): void {
  const measurable = row.clientWidth > 0;
  const scrollable = measurable ? row.scrollWidth - row.clientWidth > 1 : row.childElementCount > CARDS_IN_VIEW;
  deck.classList.toggle("scrollable", scrollable);
  deck.classList.toggle("at-end", measurable && row.scrollLeft >= row.scrollWidth - row.clientWidth - 1);
}

function el(tag: string, className?: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One row of the BEFORE / AFTER box: caption, the current reading, and — while
 * a candidate is being weighed — where that reading LANDS.
 *
 * `DPS 3.2 → 117.2`, not `DPS 3.2 ▲ 117.2` (playtest §36). The box is a
 * before/after, never a delta, but a ▲ in front of a number is read as a signed
 * one: "3.2 now, +117.2 more". A plain arrow between the two readings cannot be
 * read that way, and with `POWER 5 / 10 ▼ 2 / 10` — where the "delta" was a
 * fraction — it was worse still. The colour keeps saying which way it moved;
 * `data-trend` says the same thing to anything that cannot see colour.
 */
const COMPARE_ARROW = "→";

function compareRow(row: DeckCompareRow): HTMLDivElement {
  const node = el("div", "hangar-compare-row");
  node.dataset["key"] = row.key;
  node.append(el("span", "hangar-compare-label", row.label));
  const read = el("div", "hangar-compare-read");
  read.append(el("span", "hangar-compare-value", row.value));
  if (row.projected !== null) {
    const delta = el("span", `hangar-compare-delta ${row.trend}${row.warn ? " warn" : ""}`, `${COMPARE_ARROW} ${row.projected}`);
    // The trend as DATA as well as as colour — the row reads "DPS 3.2 → 117.2"
    // aloud without help, but nothing in that sentence says which way is good.
    delta.dataset["trend"] = row.trend;
    read.append(delta);
  }
  node.append(read);
  return node;
}

/**
 * The line pinned to the foot of a module card — what this module buys, e.g.
 * `DPS+18 ⌁2` (spec).
 *
 * Read off the module's OWN authored numbers rather than resolved against the
 * hull, because it is a label on a catalogue entry, not a projection: the
 * projection is the before/after box, which the same card raises on hover or a
 * press-hold and which does go through `computeStatPanel`. Costing twenty cards
 * through the resolver to print a headline would also mean forty stat-panel
 * resolves every time the sheet opens.
 *
 * A module with no `fire` block (an alloy, a reactor, an engine) has no damage
 * to quote, so its line is just the rail current it holds — which for most
 * internals is the only number the pilot is trading anyway.
 */
function moduleStatLine(mod: ModuleConfig): string {
  const parts: string[] = [];
  const fire = mod.fire;
  if (fire) {
    // Nominal, un-resolved DPS: damage per shot over the authored cycle. A
    // channelled weapon deals its damage per second by definition.
    const dps = fire.mode === "continuous" ? fire.damage : fire.damage / Math.max(0.01, fire.cycleTime);
    parts.push(`DPS+${Math.round(dps)}`);
  }
  parts.push(`⌁${Math.round(mod.power?.draw ?? 0)}`);
  return parts.join(" ");
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
 * LOADOUT DECK (owner 2026-08-22) — the hangar redesign.
 *
 * Left: the live 3D viewer, full bleed, with the hull's identity, the bay
 * arrows and the module card sheet drawn over it. Right: a DECK of slot tiles,
 * the before/after compare box, and — pinned to its foot — the upgrade tracks,
 * the power pips and the skin swatches. Tapping a tile slides a row of the
 * modules that socket accepts up over the foot of the viewer; picking one fits
 * it and leaves the sheet up, so the next pick reads against the same baseline.
 *
 * The palette, the chamfer geometry and the sizes are the design's, published
 * as --hg-* custom properties on the overlay root the way this sheet has
 * always carried its own — the shared --sa-* tokens are the arena's
 * design system and this screen is a themed surface on top of it, not a second
 * copy of it. The split ratio is the one thing that must agree with code:
 * DECK_STAGE_FRACTION confines the camera to exactly the width the stage
 * takes here, or the hull renders behind the deck.
 *
 * Fonts: the design's own — Titillium Web for headings and buttons, IBM Plex
 * Mono for codes, labels and numbers, both bundled through @fontsource in
 * main.ts beside Orbitron and Rajdhani (this game makes no webfont request at
 * runtime). Each keeps a fallback stack, so a build that ever drops the package
 * degrades to the shipped sans and the platform mono rather than to serif.
 */
.hangar-overlay {
  position: fixed;
  inset: 0;
  z-index: 15;
  pointer-events: none;
  display: flex;
  flex-direction: column; /* portrait: viewer above, deck below */
  color: var(--hg-text);
  font-family: var(--hg-sans);
  -webkit-font-smoothing: antialiased;

  --hg-sans: 'Titillium Web', 'Rajdhani', system-ui, sans-serif;
  --hg-mono: 'IBM Plex Mono', ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, 'Liberation Mono', monospace;

  --hg-bg: #05080f;
  --hg-bg-2: #070c16;
  --hg-panel: #0a1220;
  --hg-panel-2: #0a1424;
  --hg-panel-3: #0d1830;
  --hg-raised: #0f1f3a;
  --hg-active: #16305c;
  --hg-active-2: #2059b8;
  --hg-line: #14243c;
  --hg-line-2: #1d3252;
  --hg-line-3: #24405f;
  --hg-line-4: #2a3f5c;
  --hg-line-5: #2f4f7a;
  --hg-line-hi: #7fb0ff;
  --hg-accent: #4f8df9;
  --hg-text: #dfe9f7;
  --hg-text-blue: #9cc0ff;
  --hg-muted: #7d93b4;
  --hg-muted-2: #9fb6d6;
  --hg-faint: #587499;
  --hg-good: #39d98a;
  --hg-bad: #e07a6a;
  --hg-over: #c0564a;
  --hg-clear-bg: #1a0f14;
  --hg-clear-line: #8a3a3a;
  --hg-clear-text: #e58f8f;
  --hg-pip-empty: #182b47;
  /* Bottom-right corner cut — the deck's one shape, at the spec's four sizes. */
  --hg-chamfer-xs: polygon(0 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%);
  --hg-chamfer-sm: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
  --hg-chamfer-card: polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%);
  --hg-chamfer: polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
}
/* The sheet's entrance (spec): 220ms, a 24px rise and a fade. */
@keyframes hangar-sheet-up {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes hangar-load-spin { to { transform: rotate(360deg); } }

/* ---- loading ---- */
.hangar-loading-overlay {
  position: absolute; inset: 0; z-index: 40; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 42%, rgba(24, 64, 86, .3), rgba(3, 7, 17, .96) 66%);
  pointer-events: auto;
}
.hangar-loading-panel { display: flex; flex-direction: column; align-items: center; gap: 9px; letter-spacing: .13em; text-align: center; }
.hangar-loading-panel i, .hangar-preview-loading::before { width: 24px; height: 24px; border: 2px solid var(--hg-accent); border-right-color: transparent; border-radius: 50%; animation: hangar-load-spin .8s linear infinite; }
.hangar-loading-panel strong { color: var(--hg-accent); font-size: 13px; letter-spacing: .22em; }
.hangar-loading-panel span { color: var(--hg-muted); font-size: 10px; }
.hangar-preview-loading { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--hg-accent); font-family: var(--hg-mono); font-size: 10px; letter-spacing: .16em; pointer-events: none; }
.hangar-preview-loading::before { content: ""; width: 16px; height: 16px; }

/* ---- the viewer half ---- */
.hangar-stage {
  position: relative;
  flex: 1 1 50%;
  min-height: 0;
  min-width: 0;
  pointer-events: none; /* orbit/zoom drags belong to the canvas underneath */
  display: flex;
  /* TRANSPARENT, and it has to stay that way: this is the window the 3D stage
     renders THROUGH (see the stage field's doc comment). It shipped as
     var(--hg-bg) — an opaque #05080f rectangle over exactly the half the hull
     draws into, inside an overlay at z-index 15, above an unpositioned canvas —
     which presented as a pure-black viewer with a completely healthy renderer
     behind it. The deck half keeps the solid background; the viewer half must
     not have one. */
  background: transparent;
}
.hangar-stage-view { position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; }
/* The scrim that lets the deck's edge read against the 3D scene (spec). It
   follows the split: down the viewer's foot in portrait, across its right edge
   in landscape, where the deck is the thing it has to separate from. */
.hangar-stage-view::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(7, 12, 22, 0) 62%, rgba(7, 12, 22, .9) 100%);
}
.hangar-overlay .hangar-title {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 14px);
  left: calc(env(safe-area-inset-left, 0px) + 16px);
  z-index: 10;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: .45em;
  color: var(--hg-accent);
  text-shadow: 0 1px 4px #000;
  pointer-events: none;
}
/* ‹ › — the bay walk, and the visible twin of the swipe gesture. */
.hangar-stage-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 15;
  width: 38px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-family: var(--hg-sans);
  font-size: 20px;
  line-height: 1;
  color: var(--hg-line-hi);
  background: rgba(9, 16, 32, .55);
  border: 1px solid var(--hg-line-5);
  clip-path: var(--hg-chamfer);
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  transition: background .12s ease, opacity .12s ease;
}
.hangar-stage-arrow.prev { left: 10px; }
.hangar-stage-arrow.next { right: 10px; }
.hangar-stage-arrow:hover:not(:disabled) { background: var(--hg-active); }
.hangar-stage-arrow:disabled { opacity: .25; cursor: default; }
/* The hull's identity sits ABOVE the dot row, not beside it (playtest §28): at
   915×412 the readout ended at x≈206 and the dots began at x≈207, sharing one
   13px band over the darkest part of the bay floor. Two bands, and the dot row
   can grow a real touch target into the space that frees up. */
.hangar-ship-readout {
  position: absolute;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 44px);
  left: calc(env(safe-area-inset-left, 0px) + 16px);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 32px);
  pointer-events: none;
}
.hangar-ship-name { font-family: var(--hg-mono); font-size: 10px; letter-spacing: .2em; color: var(--hg-text); text-shadow: 0 1px 3px #000; white-space: nowrap; }
.hangar-ship-class { font-family: var(--hg-mono); font-size: 10px; letter-spacing: .2em; color: var(--hg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hangar-ship-dots {
  position: absolute;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  gap: 0;
  max-width: 100%;
  /* Click-through between the dots, like every other overlay in the viewer —
     the dots THEMSELVES take their events back below. */
  pointer-events: none;
}
/* A real control (playtest §27): the mark stays the design's 22×4 bar, drawn by
   ::before, and the button around it is a 30×28 touch target with the padding
   doing the work. It shipped as a 22×4 span under pointer-events: none, so
   every tap fell through to the render canvas behind it. */
.hangar-ship-dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  padding: 12px 4px;
  background: none;
  border: 0;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
}
.hangar-ship-dot::before {
  content: "";
  display: block;
  width: 22px;
  height: 4px;
  background: var(--hg-line-4);
  clip-path: polygon(2px 0, 100% 0, calc(100% - 2px) 100%, 0 100%);
  transition: background .18s ease, height .18s ease;
}
.hangar-ship-dot:hover:not(:disabled)::before { background: var(--hg-line-hi); }
.hangar-ship-dot.active::before { background: var(--hg-accent); height: 5px; }
.hangar-ship-dot:disabled { cursor: default; }
.hangar-stage-action {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  right: calc(env(safe-area-inset-right, 0px) + 8px);
  z-index: 12;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  /* LOCKED sat on the buy button's top-right corner (playtest §31). A badge and
     the control it qualifies are two things, and they now read as two. */
  gap: 10px;
  max-width: 46%;
  pointer-events: none;
}
.hangar-stage-action > * { pointer-events: auto; }
/* 44px minimum touch target — this is a phone-first screen. */
.hangar-stage-action .hangar-stage-btn { min-height: 44px; margin: 0; padding: 10px 14px; box-shadow: 0 2px 10px rgba(0, 0, 0, .45); }
.hangar-stage-action .hangar-badge { flex: 0 0 auto; margin: 0; }
.hangar-stage-action .hangar-badge.main { border: 1px solid var(--hg-accent); }
.hangar-stage-action .hangar-badge.locked { background: rgba(10, 12, 15, .82); }

/* ---- the module card sheet ---- */
.hangar-sheet-layer { position: absolute; inset: 0; z-index: 20; pointer-events: auto; }
/* The dim covers the VIEWER only (spec) — the deck stays live behind it, so the
   pilot can read the compare box change while the sheet is up. */
.hangar-sheet-dim { position: absolute; inset: 0; background: rgba(4, 6, 12, .35); }
.hangar-sheet {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  z-index: 30;
  padding: 24px 0 0;
  background: linear-gradient(180deg, rgba(5, 9, 17, 0) 0%, rgba(5, 9, 17, .96) 22%);
  animation: hangar-sheet-up .22s ease both;
}
.hangar-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 14px 7px; }
.hangar-sheet-title { font-family: var(--hg-mono); font-size: 10px; letter-spacing: .3em; color: var(--hg-line-hi); }
.hangar-sheet-actions { display: flex; gap: 8px; }
.hangar-sheet-clear,
.hangar-sheet-done {
  padding: 5px 12px;
  min-height: 32px;
  font-family: var(--hg-mono);
  font-size: 9px;
  letter-spacing: .15em;
  cursor: pointer;
  touch-action: manipulation;
  clip-path: var(--hg-chamfer-xs);
  transition: background .12s ease, border-color .12s ease;
}
.hangar-sheet-clear { background: var(--hg-clear-bg); border: 1px solid var(--hg-clear-line); color: var(--hg-clear-text); }
.hangar-sheet-clear:hover:not(:disabled) { background: #2c1418; }
.hangar-sheet-clear.considering { border-color: #fff; }
.hangar-sheet-done { background: var(--hg-panel-3); border: 1px solid var(--hg-line-5); color: var(--hg-muted-2); }
.hangar-sheet-done:hover:not(:disabled) { background: var(--hg-active); color: var(--hg-text); }
.hangar-sheet-clear:disabled, .hangar-sheet-done:disabled { opacity: .45; cursor: default; }
/* The once-ever "there is a preview under a long press" line (playtest §37). */
.hangar-sheet-hint {
  margin: 0 14px 6px;
  padding: 5px 9px;
  border-left: 2px solid var(--hg-accent);
  background: rgba(12, 24, 46, .82);
  font-family: var(--hg-mono);
  font-size: 9px;
  letter-spacing: .12em;
  color: var(--hg-text-blue);
  animation: hangar-sheet-up .22s ease both;
}
/* The row and its scroll affordances (playtest match §2 — see buildCardDeck). */
.hangar-card-deck { position: relative; }
/* One horizontal row: a finger swipes it natively, and the mouse affordances
   (wheel → scrollLeft, click-drag pan) live in the screen. The scrollbar is
   drawn now rather than hidden — thin, and in the deck's own palette. */
.hangar-card-row {
  display: flex;
  gap: 8px;
  padding: 2px 14px 10px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: var(--hg-line-5) transparent;
  cursor: grab;
}
.hangar-card-row::-webkit-scrollbar { height: 4px; }
.hangar-card-row::-webkit-scrollbar-track { background: rgba(20, 36, 60, .5); }
.hangar-card-row::-webkit-scrollbar-thumb { background: var(--hg-line-5); }
.hangar-card-row:active { cursor: grabbing; }
/* The fade the row runs out into, and the chevron that walks it. Both are for
   the case where there IS more row — a fold with nothing past it needs neither. */
.hangar-card-fade {
  position: absolute;
  top: 0; right: 0; bottom: 10px;
  width: 54px;
  background: linear-gradient(90deg, rgba(5, 9, 17, 0) 0%, rgba(5, 9, 17, .92) 78%);
  opacity: 0;
  pointer-events: none;
  transition: opacity .16s ease;
}
.hangar-card-more {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 30px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-family: var(--hg-sans);
  font-size: 20px;
  line-height: 1;
  color: var(--hg-line-hi);
  background: rgba(9, 16, 32, .72);
  border: 1px solid var(--hg-line-5);
  clip-path: var(--hg-chamfer-xs);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  touch-action: manipulation;
  transition: opacity .16s ease, background .12s ease;
}
.hangar-card-more:hover { background: var(--hg-active); }
.hangar-card-deck.scrollable:not(.at-end) .hangar-card-fade { opacity: 1; }
.hangar-card-deck.scrollable:not(.at-end) .hangar-card-more { opacity: 1; pointer-events: auto; }
.hangar-card {
  position: relative;
  flex: 0 0 auto;
  /* Sized so FOUR whole cards and a HALF one fit the row (playtest match §2):
     the peek is the affordance, and a fixed 96px happened to land flush with
     the sheet's edge, which is what made a 21-card row look like a 5-card one.
     Clamped so the card never becomes unreadable or absurd on other widths. */
  width: clamp(88px, calc(100% / 4.5 - 8px), 112px);
  height: 84px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 7px 9px;
  text-align: left;
  background: var(--hg-panel-3);
  border: 1px solid var(--hg-line-5);
  color: #c7d8f2;
  clip-path: var(--hg-chamfer-card);
  cursor: pointer;
  touch-action: pan-x;
  transition: filter .12s ease, background .12s ease, border-color .12s ease;
}
.hangar-card.fitted { background: var(--hg-active-2); border-color: var(--hg-line-hi); color: #fff; }
/* Unavailable is still the spec's "dimmed to a third" — but the dimming is on
   the card's CONTENTS, so the reason tag stays readable (playtest §38). A card
   whose explanation is as faint as the thing it explains explains nothing. */
.hangar-card.unavailable { background: var(--hg-panel); border-color: var(--hg-line-2); cursor: default; pointer-events: none; }
.hangar-card.unavailable .hangar-card-icon,
.hangar-card.unavailable .hangar-card-name,
.hangar-card.unavailable .hangar-card-stat { opacity: .38; }
.hangar-card-tag {
  position: absolute;
  top: 5px;
  right: 6px;
  padding: 1px 4px;
  font-family: var(--hg-mono);
  font-size: 7px;
  font-weight: 600;
  letter-spacing: .1em;
  color: var(--hg-bad);
  border: 1px solid var(--hg-bad);
  background: rgba(10, 12, 15, .6);
}
.hangar-card:hover:not(:disabled) { filter: brightness(1.25); }
.hangar-card.considering { border-color: #fff; filter: brightness(1.25); }
.hangar-card-icon { display: flex; color: var(--hg-text-blue); }
.hangar-card.fitted .hangar-card-icon { color: #fff; }
.hangar-card-icon svg { width: 20px; height: 20px; stroke-width: 1.8; }
.hangar-card-name {
  font-size: 10px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--hg-text);
  /* Two lines, then it stops — the card is a fixed 96×84 (spec). */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.hangar-card.fitted .hangar-card-name { color: #fff; }
/* Pinned to the foot, whatever height the name took. */
.hangar-card-stat { margin-top: auto; font-family: var(--hg-mono); font-size: 8px; letter-spacing: .06em; color: var(--hg-line-hi); }
.hangar-card.fitted .hangar-card-stat { color: #dbe8ff; }

/* ---- the deck ---- */
.hangar-panel {
  pointer-events: auto;
  flex: 1 1 50%;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--hg-bg-2);
  border-top: 1px solid var(--hg-line);
  padding:
    14px
    calc(env(safe-area-inset-right, 0px) + 16px)
    calc(env(safe-area-inset-bottom, 0px) + 14px)
    calc(env(safe-area-inset-left, 0px) + 16px);
}
.hangar-deck-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
/* The scrolling middle. The foot below it is PINNED, which is what "pushed to
   the bottom with an auto margin" means once the deck is taller than a phone. */
.hangar-deck-body {
  flex: 1 1 auto;
  min-height: 0;
  /* The deck fits, it does not scroll (owner 2026-08-23): tiles compress and a
     five-socket section widens to five columns instead of wrapping. hidden
     rather than visible so a pathologically short window clips instead of
     bleeding into the pinned foot. */
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hangar-deck-foot { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; }
.hangar-section-title { font-family: var(--hg-mono); font-size: 10px; letter-spacing: .3em; color: var(--hg-muted); }
.hangar-close {
  background: var(--hg-panel-3);
  color: var(--hg-text);
  border: 1px solid var(--hg-line-5);
  font-family: var(--hg-sans);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .2em;
  padding: 6px 14px;
  min-height: 34px;
  cursor: pointer;
  touch-action: manipulation;
  clip-path: var(--hg-chamfer-sm);
}
.hangar-close:hover:not(:disabled) { background: var(--hg-active); }
.hangar-close:disabled { opacity: .45; cursor: default; }
.hangar-hint { font-size: 12px; color: var(--hg-muted-2); border-left: 2px solid var(--hg-line-2); padding: 4px 8px; }
/* What a hull you have not bought says about itself (playtest §30). */
.hangar-locked-brief { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; background: var(--hg-panel-2); border: 1px solid var(--hg-line-2); }
.hangar-locked-class { font-family: var(--hg-mono); font-size: 11px; letter-spacing: .28em; color: var(--hg-text-blue); }
.hangar-locked-stats { font-family: var(--hg-mono); font-size: 10px; letter-spacing: .08em; color: var(--hg-muted); font-variant-numeric: tabular-nums; }
.hangar-error { font-family: var(--hg-mono); font-size: 11px; color: var(--hg-bad); border-left: 2px solid var(--hg-bad); padding: 4px 8px; }

/* ---- slot tiles ---- */
.hangar-slot-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.hangar-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  /* 76px at the design's 440-tall reference, compressing on shorter windows so
     the deck never grows a scrollbar. The floor still seats icon + two labels. */
  height: clamp(54px, 12vh, 76px);
  padding: 2px;
  background: var(--hg-panel);
  border: 1px dashed var(--hg-line-4);
  color: var(--hg-faint);
  clip-path: var(--hg-chamfer);
  cursor: pointer;
  touch-action: manipulation;
  transition: filter .12s ease, background .16s ease, border-color .16s ease;
}
.hangar-slot.filled { background: var(--hg-raised); border: 1px solid var(--hg-line-5); color: var(--hg-text-blue); }
.hangar-slot.open { background: var(--hg-active); border: 1px solid var(--hg-line-hi); color: var(--hg-text-blue); }
.hangar-slot:hover:not(:disabled) { filter: brightness(1.25); }
.hangar-slot:disabled { opacity: .45; cursor: default; }
/* The fitted module's glyph, 22px (spec); an empty socket's "+" is text, so the
   box is sized here rather than by whichever of the two is inside it. (No
   backticks anywhere below this line: the whole sheet is one template literal,
   and an unescaped pair silently splits it into two concatenated strings.) */
.hangar-slot-icon { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; font-size: 18px; line-height: 1; }
.hangar-slot-icon svg { width: 22px; height: 22px; stroke-width: 1.8; }
/* Both lines are CLIPPED TO THE TILE (playtest §29). The socket sub-label had
   no overflow rule and .18em of tracking, so COUNTERMEASURE rendered 87px
   wide in a 66px tile — centred, so it bled out of both sides at once and
   arrived as "UNTERMEASU". Tighter tracking buys back roughly three characters;
   the ellipsis is what guarantees the rest. The full text is on the tile's
   title/aria-label, which is where the part that no longer fits now lives. */
.hangar-slot-label,
.hangar-slot-socket {
  width: 100%;
  min-width: 0;
  padding: 0 2px;
  box-sizing: border-box;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hangar-slot-label { font-size: 9px; line-height: 1.1; letter-spacing: .03em; color: var(--hg-muted-2); }
.hangar-slot-socket { font-family: var(--hg-mono); font-size: 8px; letter-spacing: .06em; color: var(--hg-faint); }

/* ---- before / after ---- */
.hangar-compare {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  background: var(--hg-panel-2);
  border: 1px solid var(--hg-line-2);
  transition: border-color .16s ease;
}
.hangar-compare.previewing { border-color: var(--hg-line-hi); }
.hangar-compare-title { font-family: var(--hg-mono); font-size: 9px; letter-spacing: .3em; color: var(--hg-faint); }
.hangar-compare-row { display: flex; justify-content: space-between; gap: 16px; font-family: var(--hg-mono); font-size: 11px; }
.hangar-compare-label { color: var(--hg-muted); }
.hangar-compare-read { display: flex; gap: 8px; }
.hangar-compare-value { color: var(--hg-text); font-variant-numeric: tabular-nums; }
.hangar-compare-delta { font-variant-numeric: tabular-nums; }
.hangar-compare-delta.better { color: var(--hg-good); }
.hangar-compare-delta.worse { color: var(--hg-bad); }
.hangar-compare-delta.none { color: var(--hg-muted-2); }
.hangar-compare-delta.warn { color: var(--hg-over); }

/* ---- power pips + skins ---- */
.hangar-powerrow, .hangar-skinrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* The swatches were 18×18 pinned to the very bottom edge (playtest §33): under
   half a touch target, in the last 18px of the screen. The row keeps its own
   air now, and every swatch is a 40px target around a 28px mark. */
.hangar-skinrow { gap: 4px; padding-bottom: 2px; }
.hangar-skinrow .hangar-foot-label { margin-right: 4px; }
.hangar-foot-label { font-family: var(--hg-mono); font-size: 9px; letter-spacing: .25em; color: var(--hg-muted); }
.hangar-pips { display: flex; flex-wrap: wrap; gap: 3px; }
.hangar-pip {
  width: 14px;
  height: 7px;
  background: var(--hg-pip-empty);
  clip-path: polygon(3px 0, 100% 0, calc(100% - 3px) 100%, 0 100%);
  transition: background .16s ease;
}
.hangar-pip.filled { background: var(--hg-accent); }
.hangar-pip.over { background: var(--hg-over); }
.hangar-power-text { font-family: var(--hg-mono); font-size: 10px; color: var(--hg-text); font-variant-numeric: tabular-nums; }
.hangar-power-text.over { color: var(--hg-over); font-weight: 700; }
/* The BUTTON is the touch target, the ::before is the paint chip: 40px of hit
   area around a 28px mark, which is the smallest either can be (playtest §33). */
.hangar-skin {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: none;
  border: 0;
  cursor: pointer;
  touch-action: manipulation;
}
.hangar-skin::before {
  content: "";
  display: block;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--skin-primary) 0 52%, var(--skin-accent) 52% 100%);
  border: 2px solid rgba(0, 0, 0, .4);
  transition: box-shadow .16s ease, border-color .16s ease, transform .16s ease;
}
.hangar-skin.equipped::before { border-color: var(--hg-accent); box-shadow: 0 0 12px rgba(79, 141, 249, .6); }
.hangar-skin.unowned::before { opacity: .45; }
.hangar-skin:hover:not(:disabled)::before { filter: brightness(1.2); transform: scale(1.08); }

/* ---- upgrades (the one block the spec does not draw — see render()) ---- */
.hangar-upgrades { display: flex; flex-direction: column; gap: 5px; }
.hangar-upgrade-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.hangar-upgrade-label { flex: 0 0 66px; font-family: var(--hg-mono); font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: var(--hg-muted); }
.hangar-upgrade-row .hangar-btn { margin-left: auto; }

/* ---- shared controls ---- */
.hangar-btn {
  padding: 6px 12px;
  min-height: 34px;
  font-family: var(--hg-sans);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .18em;
  text-transform: uppercase;
  background: var(--hg-panel-3);
  color: var(--hg-text);
  border: 1px solid var(--hg-line-5);
  clip-path: var(--hg-chamfer-sm);
  cursor: pointer;
  touch-action: manipulation;
}
.hangar-btn:hover:not(:disabled) { background: var(--hg-active); }
.hangar-btn:disabled { opacity: .45; cursor: default; }
.hangar-btn-primary { background: var(--hg-active-2); border-color: var(--hg-accent); color: #fff; }
.hangar-badge { display: inline-flex; align-items: center; font-family: var(--hg-mono); font-size: 9px; font-weight: 600; line-height: 1.5; letter-spacing: .16em; padding: 3px 7px; }
.hangar-badge.main { background: var(--hg-accent); color: var(--hg-bg); }
.hangar-badge.locked { color: var(--hg-bad); border: 1px solid var(--hg-bad); }

/* Landscape — the design's own orientation: viewer left, deck right, split at
   the 545/960 the frame was drawn on (see DECK_STAGE_FRACTION). */
@media (orientation: landscape) {
  .hangar-overlay { flex-direction: row; }
  .hangar-stage { flex: 0 0 56.77%; }
  .hangar-stage-view::after { background: linear-gradient(90deg, rgba(7, 12, 22, 0) 60%, rgba(7, 12, 22, .9) 100%); }
  .hangar-panel {
    flex: 1 1 auto;
    border-top: none;
    border-left: 1px solid var(--hg-line);
    padding-top: calc(env(safe-area-inset-top, 0px) + 14px);
  }
}
/* Short landscape (a phone on its side) — the frame this was designed at.
   Tighter rows, and the tiles give up a little height to the compare box. */
@media (orientation: landscape) and (max-height: 520px) {
  .hangar-panel { gap: 8px; padding-top: calc(env(safe-area-inset-top, 0px) + 10px); }
  .hangar-slot { height: clamp(50px, 12vh, 64px); }
  .hangar-compare { padding: 8px 10px; gap: 3px; }
  /* The foot carries four blocks here (specs, upgrades, power, skins), so the
     one the spec does not draw is the one that gives ground. */
  .hangar-deck-foot { gap: 6px; }
  .hangar-upgrades { gap: 3px; }
  .hangar-upgrades .hangar-section-title { display: none; }
  /* 32px is this screen's floor for a control at phone scale (playtest §34):
     the upgrade buys measured 45×24, the smallest pressable thing in the deck. */
  .hangar-upgrade-row .hangar-btn { min-height: 32px; min-width: 58px; padding: 4px 10px; }
}
/* Phone-height landscape. The tiles are the POINT of this screen, so it is
   the foot that gives ground: the compare box folds to one wrapped line of
   stat pairs, the upgrade buys drop their pips and share a row, and every
   control loses a size step. Budgeted to fit a 350px-tall viewport with no
   scrolling and nothing clipped. */
@media (orientation: landscape) and (max-height: 420px) {
  .hangar-panel { gap: 6px; padding-top: calc(env(safe-area-inset-top, 0px) + 8px); padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 8px); }
  .hangar-deck-body { gap: 6px; }
  .hangar-deck-foot { gap: 5px; }
  .hangar-close { min-height: 28px; padding: 4px 10px; }
  .hangar-slot { height: clamp(40px, 15vh, 56px); gap: 2px; }
  .hangar-slot-icon { width: 18px; height: 18px; font-size: 15px; }
  .hangar-slot-icon svg { width: 18px; height: 18px; }
  .hangar-compare { flex-direction: row; flex-wrap: wrap; align-items: center; column-gap: 14px; row-gap: 2px; padding: 6px 10px; }
  .hangar-compare-title { flex: 1 1 100%; }
  .hangar-compare-row { gap: 6px; font-size: 10px; }
  .hangar-upgrades { flex-direction: row; align-items: center; gap: 6px; }
  .hangar-upgrade-row { flex: 1 1 0; flex-wrap: nowrap; gap: 4px; }
  .hangar-upgrade-label { flex: 0 0 auto; }
  .hangar-upgrade-row .hangar-pips { display: none; }
  /* Never below 32px, however short the window gets — the deck gives its ground
     up elsewhere (playtest §34). */
  .hangar-upgrade-row .hangar-btn { min-height: 32px; min-width: 56px; padding: 3px 8px; font-size: 10px; }
  .hangar-pip { width: 12px; height: 6px; }
  /* The mark shrinks a step; the 40px target does not (playtest §33). */
  .hangar-skin { width: 40px; height: 36px; }
  .hangar-skin::before { width: 28px; height: 28px; }
  .hangar-ship-readout { bottom: calc(env(safe-area-inset-bottom, 0px) + 40px); }
  .hangar-ship-dot { padding: 10px 4px; }
}
/* Shorter still: the tiles keep icon + socket, the labels go, and — only
   here, where even a compacted deck cannot fit — the body may scroll rather
   than clip modules out of existence. */
@media (orientation: landscape) and (max-height: 350px) {
  .hangar-slot-label { display: none; }
  .hangar-slot { height: clamp(32px, 13vh, 44px); }
  .hangar-compare-title { display: none; }
  .hangar-deck-body { overflow-y: auto; }
}
/* Narrow screens: four tiles across stop being pressable, so the grid relaxes. */
@media (max-width: 420px) {
  .hangar-slot-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;
