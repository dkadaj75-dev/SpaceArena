import "@fontsource/orbitron/400.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/rajdhani/400.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import { Engine, EngineFactory, Scene, Color4, Matrix, TransformNode, Vector3, Viewport } from "@babylonjs/core";
import {
  createLogger,
  ConfigService,
  GameLoop,
  EventBus,
  type ConfigEvents,
  type GamemodeConfig,
  type TutorialConfig,
  type TuningConfig,
  type ShipSnapshot,
  type EntityId,
  type ShipConfig,
  type ThemeConfig,
  type FrameAttitude,
  type ArenaConfig,
  interpolateFrame,
  teamSizeOf,
  BASICS_TUTORIAL_ID,
  arenaSchema,
} from "@space-arena/shared";
import { wireContentHotReload } from "./core/contentHotReload.js";
import { recoverFromStaleContentPack } from "./core/contentRecovery.js";
import { designTokenCssVars } from "./game/themeTokens.js";
import { createUpdateGate } from "./core/swUpdate.js";
import { installTouchGuards } from "./core/touchGuards.js";
import { preloadArenaModels, preloadMatchModels, preloadShipModels, type MatchPreload } from "./core/assetPreload.js";
import { createBootAssetRegistry } from "./core/bootAssets.js";
import { MenuDiorama } from "./game/screens/MenuDiorama.js";
import { ModelLoadQueue } from "./core/modelLoadQueue.js";
import { QualityManager, readWebglRenderer } from "./core/QualityManager.js";
import { engineAntialiasForProbe, probeDevice } from "./core/qualityTier.js";
import { SceneBuilder } from "./core/SceneBuilder.js";
import { AuthService } from "./core/AuthService.js";
import {
  looksLikeServerUnreachable,
  SERVER_OFFLINE_MESSAGE,
  ServerHealthState,
} from "./core/serverHealth.js";
import { TelemetryClient } from "./core/TelemetryClient.js";
import { TacticalCamera } from "./game/TacticalCamera.js";
import { LaunchCinematic } from "./game/launchCinematic.js";
import { GameSession } from "./game/GameSession.js";
import { ViewManager } from "./game/EntityView.js";
import { Hud } from "./game/hud/Hud.js";
import { Lobby, type LobbyChoice } from "./game/screens/Lobby.js";
import { BootScreen } from "./game/screens/BootScreen.js";
import { AuthScreen } from "./game/screens/AuthScreen.js";
import { Hangar, loadHangarSelection } from "./game/screens/Hangar.js";
import { allHangarShipJobs } from "./game/hangarAssetPreload.js";
import { ShopScreen } from "./game/screens/ShopScreen.js";
import { createSessionOwnership } from "./game/sessionOwnership.js";
import { runTeardown } from "./game/matchTeardown.js";
import { TutorialDirector, type TutorialHost } from "./game/tutorial/TutorialDirector.js";
import { TutorialOverlay, showTutorialToast } from "./game/tutorial/TutorialOverlay.js";
import { markTutorialCompleted } from "./game/tutorial/tutorialProgress.js";
import { SettingsScreen } from "./game/screens/SettingsScreen.js";
import { FullscreenPrompt } from "./game/screens/FullscreenPrompt.js";
import { loadingRoster, MatchLoadingScreen } from "./game/screens/MatchLoadingScreen.js";
import {
  defaultRendererPreference,
  parseRenderer,
  UserSettingsStore,
  type UserSettings,
} from "./core/userSettings.js";
import { NetGameSession } from "./net/NetGameSession.js";
import { waitForMatchStart } from "./net/matchStart.js";
import { NetDebugOverlay } from "./net/NetDebugOverlay.js";
import { BotDebugOverlay } from "./game/BotDebugOverlay.js";
import { AudioManager } from "./audio/AudioManager.js";
import { MusicController } from "./audio/MusicController.js";
import { AudioFeedback } from "./audio/AudioFeedback.js";
import { audioSettingsOf } from "./audio/soundIds.js";
import { ScreenShake } from "./game/juice/ScreenShake.js";
import type { FlightHudBinding } from "./game/hud/FlightControls.js";
import type { CameraView, ProjectedPoint } from "./game/hud/flightHudLayout.js";
import { mvpPresentationSettings } from "./game/hud/matchPresentation.js";

const log = createLogger("Client");

/** Scratch frame for the per-render-frame chase-camera interpolation — no allocation. */
const chaseFrameScratch: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };

/**
 * Arena rendered before any match resolves one (boot/menu backdrop) and for a
 * gamemode that declares no `defaultArena`. The ONLY arena id literal in the
 * client — every in-match consumer routes through the session's resolved id.
 */
const FALLBACK_ARENA_ID = "arena.ring-nebula";

/**
 * Content lives at `content/*` under the site base (BASE_URL is "/" everywhere
 * except GitHub Pages): the Vite plugin serves it in dev
 * (client/vite.config.ts), Express serves it in production
 * (server/src/staticSite.ts), and the service worker puts a network-first cache
 * in front of it so a new pack goes live without a redeploy (ROADMAP §11 6.5).
 */
async function fetchLoader(relPath: string): Promise<unknown> {
  const res = await fetch(`${import.meta.env.BASE_URL}content/${relPath}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
  return res.json();
}

/**
 * The one case the precached app shell cannot rescue: installed to the home
 * screen, opened with no network, and the content pack was never cached. The
 * shell boots, `ConfigService.load()` comes back empty, and every screen below
 * would render blank — so hand over to the precached offline page instead
 * (ROADMAP §11 6.5). Online failures fall through to the normal error path,
 * because a redirect would hide a real bug.
 */
function redirectToOfflinePageIfNeeded(): boolean {
  const offlinePage = `${import.meta.env.BASE_URL}offline.html`;
  if (navigator.onLine || import.meta.env.DEV || location.pathname === offlinePage) return false;
  log.warn("offline with no cached content pack — showing the offline page");
  location.replace(offlinePage);
  return true;
}

/**
 * Everything that lives for exactly one match: the authoritative
 * session, its dynamic views/input, and the HUD. Rebuilt from scratch on
 * "Play again" (§6 1.9) so there's no cross-match state to reset by hand —
 * `dispose()` tears every piece down and the render loop picks up the freshly
 * created replacement on its next tick.
 */
interface MatchRuntime {
  session: GameSession;
  viewManager: ViewManager;
  hud: Hud;
  /** Sim events → synthesized SFX (§10 5.7). */
  audioFeedback: AudioFeedback;
  /** Sim events → additive camera micro-shake (§10 5.7). */
  screenShake: ScreenShake;
  /** Hangar spawn establishing shot, while the sim is flying the local hull. */
  launchCinematic: LaunchCinematic;
  netOverlay: NetDebugOverlay | null;
  botOverlay: BotDebugOverlay | null;
  dispose(): void;
}

async function bootstrap(boot: BootScreen | null): Promise<void> {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error("#renderCanvas not found");
  }
  const hudRootMaybe = document.getElementById("hud") as HTMLDivElement | null;
  if (!hudRootMaybe) {
    throw new Error("#hud not found");
  }
  const hudRoot: HTMLDivElement = hudRootMaybe;

  // --- Config pipeline ---
  const bus = new EventBus<ConfigEvents>();
  const configService = new ConfigService(fetchLoader, bus);
  boot?.begin("content");
  const loadResult = await configService.load("manifest.json");
  if (loadResult.ok) {
    log.info("content loaded", loadResult.counts);
    const total = Object.values(loadResult.counts).reduce((sum, n) => sum + n, 0);
    boot?.settle("content", "ok", `${total} configs`);
  } else {
    log.error(`content load failed (${loadResult.errors.length} problem(s)):`);
    for (const e of loadResult.errors) {
      log.error(`  ${e.file} → ${e.path}: ${e.message}`);
    }
    boot?.settle("content", "fail", `${loadResult.errors.length} problem(s) — see console`);
    if (redirectToOfflinePageIfNeeded()) return;
    // A pack this client cannot parse usually means the deploy moved on and
    // THIS page is the stale half of the pairing (contentRecovery.ts). Reload
    // into the new version rather than boot a menu with no valid ships in it.
    if (await recoverFromStaleContentPack()) return;
  }
  wireContentHotReload(configService);

  // Design tokens belong to the DOCUMENT, not to any one widget. Scoping them
  // to a component root left every screen that attaches elsewhere — the launch
  // fullscreen prompt above all — resolving var(--sa-*) to nothing, which
  // invalidates the whole declaration and drops text to inherited near-black.
  // Publishing once on :root is what makes the system actually shared.
  const publishDesignTokens = (): void => {
    const vars = designTokenCssVars(configService.get<ThemeConfig>("theme", "theme.default"));
    for (const [prop, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(prop, value);
    }
  };
  publishDesignTokens();
  bus.on("configChanged", publishDesignTokens);
  boot?.begin("interface");

  // Reachability starts now and is awaited at its own boot stage below, while
  // the engine and menu interface are prepared independently.
  const serverHealth = new ServerHealthState();
  const healthProbe = serverHealth.refresh();

  // --- Auth (§8 3.3): restore any existing session, concurrently. ---
  //
  // Restoring is a NETWORK round trip for anyone who has been here before
  // (`/api/auth/me`, plus a refresh + retry on an expired 15-minute access
  // token, or a guest issue when only the guest token survived), and awaiting it
  // here used to hold the engine, the scene and every menu screen hostage to it.
  // None of that construction needs to know who the player is, so the wait moves
  // down to the join point below — the same shape the health probe above uses.
  const authService = new AuthService();
  const authRestored = authService.restore();

  // An explicit URL or saved backend always wins. Safari's no-preference
  // default is WebGPU, while other browsers retain the conservative WebGL2
  // default. A missing adapter or an engine-init failure must never prevent
  // Safari from reaching the game.
  const rendererPref =
    parseRenderer(new URLSearchParams(window.location.search).get("renderer")) ??
    parseRenderer(localStorage.getItem("spacearena.renderer")) ??
    defaultRendererPreference(window.navigator);
  const startupWebglRenderer = readWebglRenderer();
  const startupNavigator = window.navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  };
  const startupProbe = probeDevice({
    hardwareConcurrency: startupNavigator.hardwareConcurrency,
    deviceMemory: startupNavigator.deviceMemory,
    userAgent: startupNavigator.userAgent,
    userAgentData: startupNavigator.userAgentData,
    maxTouchPoints: startupNavigator.maxTouchPoints,
    webglRenderer: startupWebglRenderer,
  });
  // Tile/mobile-class GPUs avoid the extra multisampled color/depth bandwidth.
  // Desktop keeps the existing antialiasing path unchanged.
  const webglAntialias = engineAntialiasForProbe(startupProbe);
  let actualRenderer = rendererPref;
  let engine: Engine;
  if (rendererPref === "webgpu") {
    if (!("gpu" in navigator)) {
      log.warn("WebGPU requested but unavailable; falling back to WebGL");
      actualRenderer = "webgl";
      engine = new Engine(canvas, webglAntialias);
    } else {
      try {
        engine = (await EngineFactory.CreateAsync(canvas, {})) as Engine;
      } catch (error) {
        log.warn("WebGPU engine creation failed; falling back to WebGL", { error });
        actualRenderer = "webgl";
        engine = new Engine(canvas, webglAntialias);
      }
    }
  } else {
    engine = new Engine(canvas, webglAntialias);
  }
  log.info("engine created", { requestedRenderer: rendererPref, renderer: actualRenderer, cls: engine.getClassName() });

  // Render quality (§10 5.6). The tier owns the DPR cap and the hardware
  // scaling level that used to be hardcoded here: device probe picks the
  // starting tier, `sa.quality` in localStorage overrides it, and measured FPS
  // may adjust it once in the first seconds of a match.
  engine.adaptToDeviceRatio = true;
  const quality = new QualityManager(configService, engine, {
    bus,
    navigator: window.navigator,
    devicePixelRatio: window.devicePixelRatio || 1,
    webglRenderer: startupWebglRenderer,
  });

  // Anonymous per-match perf telemetry (§11 6.8). Constructed once per page
  // load so its session handle covers the whole visit; silent in dev builds
  // unless VITE_SPACE_ARENA_TELEMETRY=1.
  const telemetry = new TelemetryClient();

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);

  // Audio (§10 5.7). One manager for the whole app: it stays silent (and never
  // even constructs an AudioContext) until the first user gesture, and does no
  // work at all while muted. Volumes come from localStorage
  // (`sa.volume.master`/`sa.volume.sfx`) with the theme supplying the defaults.
  const initialAudioSettings = audioSettingsOf(configService.get<ThemeConfig>("theme", "theme.default"));
  const audio = new AudioManager({ settings: initialAudioSettings });
  const music = new MusicController(audio, initialAudioSettings.music);
  audio.attachUnlock();
  music.setScreen("boot");

  // Player settings (§10 5.8). One store owns the localStorage overrides; the
  // apply pass below is the ONLY place that turns a setting into behaviour, so
  // the settings screen never has to know about the engine, the audio graph or
  // the camera rig. Volume defaults come from whatever the AudioManager already
  // resolved (stored value, else the theme's default).
  const userSettings = new UserSettingsStore(undefined, {
    masterVolume: audio.masterVolume,
    sfxVolume: audio.sfxVolume,
    musicVolume: audio.musicVolume,
  });

  // One registry is shared by matches and menu previews, but cold boot only
  // creates the cache. No ensureModel call (and therefore no GLB fetch) occurs.
  const preloadAssets = createBootAssetRegistry(scene);

  // --- Static arena (0.6/0.7/0.8): bounds/skybox/ground/lighting/spawns only ---
  //
  // ONE resolved arena id drives the scene and the minimap. The sim resolves the
  // real arena from the gamemode/join options, so every consumer here reads
  // `session.arenaId` through `setArena` once a match starts (FLIGHT.md §6) —
  // hardcoding an id in either split the client's view of the arena from the sim's.
  const sceneBuilder = new SceneBuilder(scene, configService, bus, quality.current);
  let currentArenaId: string | null = null;
  bus.on("config:changed", (evt) => {
    // Authoring a rock model in the dev editor should not need a page reload.
    if (evt.type === "arena" || evt.type === "asteroid") {
      if (currentArenaId) void preloadArenaModels(preloadAssets, configService, currentArenaId);
    }
  });

  // One subscription fans the active tier out to every consumer.
  quality.onChange((cfg) => {
    sceneBuilder.setQuality(cfg);
    runtime?.viewManager.setQuality(cfg);
    // Ship hull LODs are applied once at preload time (§below), so a tier
    // change mid-match — most commonly an auto-tier demote on a struggling
    // mobile client — would otherwise leave every remote hull's LOD switch
    // distances biased for the tier the match STARTED in. Re-apply is cheap:
    // every hull this match could render was already requested by
    // `preloadMatchModels`, so `ensureModel` resolves cached masters with no
    // re-fetch and `applyModelLods` just clears and re-clones the LOD levels.
    // Gated on `runtime` (mirroring the line above) so a quality change in the
    // main menu never kicks off a full-roster hull download.
    if (runtime) void preloadShipModels(preloadAssets, configService, cfg.scene.ships?.lodBias);
  });

  const tacticalCamera = new TacticalCamera(scene, canvas, configService, bus);

  /**
   * Point the scene at the arena a starting match resolved. A no-op when the id
   * is unchanged (the common case), so a rematch on the same arena never pays
   * for a rebuild.
   */
  function setArena(arenaId: string): void {
    if (arenaId === currentArenaId) return;
    currentArenaId = arenaId;
    stagedArenaId = arenaId;
    sceneBuilder.buildArena(currentArenaId);
    void preloadArenaModels(preloadAssets, configService, currentArenaId);
  }

  // Camera follows a lightweight node tracking the (moving) player ship
  // position. Persists across "Play again" resets — only its target position
  // is re-snapped.
  const playerFollow = new TransformNode("playerFollow", scene);
  tacticalCamera.follow(playerFollow);

  // --- Flight HUD ↔ 3D bridge (FLIGHT.md §4) ---
  //
  // The HUD is pure DOM and knows nothing about Babylon; these two callbacks are
  // the entire surface between them. Both run once per frame, so everything here
  // is scratch-allocated once and mutated in place.
  const projectIdentity = Matrix.Identity();
  // A unit viewport makes `Vector3.ProjectToRef` return normalized 0..1 screen
  // coordinates, which we scale by the canvas's CSS size. Projecting into the
  // RENDER buffer instead would be wrong by the quality tier's hardware-scaling
  // factor — the HUD lives in CSS pixels.
  const projectViewport = new Viewport(0, 0, 1, 1);
  const projectWorld = new Vector3();
  const projectResult = new Vector3();
  // The canvas's CSS size, read from the DOM only when it can actually have
  // changed (see the ResizeObserver at the bottom of this function).
  //
  // `clientWidth`/`clientHeight` are forced-layout reads, and `project()` runs
  // per HUD marker: the flight HUD interleaves a dozen-plus of them with the
  // style writes the off-screen arrows make in the same pass, so every read
  // flushed a layout the previous write had just invalidated. The value is
  // identical for every marker in a frame — it is a property of the canvas, not
  // of the point being projected — so caching it removes the thrash outright.
  let canvasCssW = 0;
  let canvasCssH = 0;
  const refreshCanvasCssSize = (): void => {
    canvasCssW = canvas.clientWidth;
    canvasCssH = canvas.clientHeight;
  };
  const flightBinding: FlightHudBinding = {
    inputSurface: canvas,
    project(x: number, y: number, z: number, out: ProjectedPoint): boolean {
      // Unchanged meaning, cached source: a canvas with no layout yet (hidden
      // tab, display:none) still refuses to place markers until it has one.
      if (canvasCssW <= 0 || canvasCssH <= 0) return false;
      // The HUD updates BEFORE `scene.render()` each frame, so on the very first
      // frame of a match the scene has never computed a view matrix — every later
      // frame reuses the previous one, which is a frame of lag nobody can see.
      // Babylon hands back an undefined matrix in that window, and a HUD marker
      // is not worth a crash.
      const viewMatrix = scene.getViewMatrix() as Matrix | undefined;
      if (!viewMatrix) return false;
      projectWorld.set(x, y, z);
      // Depth first: `Project` divides by w, so a point behind the camera comes
      // back MIRRORED through the screen centre rather than absent. Babylon is
      // left-handed by default, so view-space +z is in front of the camera.
      //
      // The mirroring is reported, not rejected (BUBBLE.md §C): the off-screen
      // arrows undo it to recover the true bearing, which is the only way to
      // point at an enemy dead astern. Only the degenerate band right at the
      // camera plane, where the divide blows up, is refused outright.
      Vector3.TransformCoordinatesToRef(projectWorld, viewMatrix, projectResult);
      const viewZ = projectResult.z;
      if (Math.abs(viewZ) <= 0.01) return false;
      out.behind = viewZ < 0;
      Vector3.ProjectToRef(projectWorld, projectIdentity, scene.getTransformMatrix(), projectViewport, projectResult);
      out.x = projectResult.x * canvasCssW;
      out.y = projectResult.y * canvasCssH;
      return true;
    },
    cameraView(out: CameraView): void {
      out.fovRad = tacticalCamera.camera.fov;
      out.betaRad = tacticalCamera.camera.beta;
    },
  };

  /**
   * The MVP hero shot shares the screen with the results panel, which sits at
   * the BOTTOM in portrait and on the RIGHT in landscape. Lift or slide the
   * staged hull by the authored share of the frame so it centres in the space
   * the panel leaves, rather than hiding behind it (owner 2026-08-06).
   */
  const MVP_PORTRAIT_LIFT = 0.15;
  const MVP_LANDSCAPE_SHIFT = 0.2;
  let mvpStaged = false;
  function applyMvpStageOffset(): void {
    // Render dimensions rather than the canvas element: same source the camera
    // derives its aspect from, and valid inside this hoisted helper.
    const landscape = engine.getRenderWidth() > engine.getRenderHeight();
    tacticalCamera.setStageScreenOffset(
      landscape ? -MVP_LANDSCAPE_SHIFT : 0,
      landscape ? 0 : MVP_PORTRAIT_LIFT,
    );
  }

  function createMatchRuntime(session: GameSession): MatchRuntime {
    const viewManager = new ViewManager(
      scene,
      configService,
      (id) => session.shipConfigIdFor(id),
      quality.current,
      // Explosion sounds are picked from the effect config the view layer
      // already resolved per ship class — one variant lookup, visual + audio.
      { playSound: (id, volume) => audio.play(id, volume), playerId: session.playerId },
    );
    const offline = !(session instanceof NetGameSession);
    const hud = new Hud(
      hudRoot,
      configService,
      bus,
      session,
      session.playerId,
      {
        // "Play again" rebuilds the same kind of match from scratch (§6 1.9):
        // no cross-match state survives, so a rematch is a fresh runtime.
        onPlayAgain: () => {
          const again = lastChoice ?? { kind: "online" as const, gamemode: "gamemode.practice-bots-1v1" };
          endMatch();
          void launchChoice(again);
        },
        onMenu: () => {
          log.info("match over — returning to lobby");
          endMatch();
          music.setScreen("menu");
          lobby.show();
        },
        onMvp: (entityId) => {
          // Keep the beauty shot in open space. Lunar terrain reaches several
          // units above floorY and large hulls render at authored multi-x scale;
          // eighteen units clears both while retaining the arena backdrop.
          const heroCenter = new Vector3(0, 18, 0);
          tacticalCamera.setChaseMode(false);
          tacticalCamera.setHangarMode(true);
          tacticalCamera.resetStageOrbit(heroCenter);
          mvpStaged = true;
          applyMvpStageOffset();
          tacticalCamera.beginMvpOrbit(mvpPresentationSettings(
            configService.get<ThemeConfig>("theme", "theme.default"),
          ).orbitDegreesPerSecond);
          viewManager.setMvpCenter(heroCenter);
          viewManager.showMvp(entityId);
        },
        onSettings: () => openSettings("match"),
      },
      { offline, flight: flightBinding, playSound: (id) => void audio.play(id) },
    );

    // Online sessions: rejection toasts + DEV net telemetry overlay (F9).
    let netOverlay: NetDebugOverlay | null = null;
    if (session instanceof NetGameSession) {
      session.onOrderRejected = (reason) => hud.showToast(`Order rejected: ${reason}`);
      session.onMatchRewards = (rewards) => hud.showMatchRewards(rewards);
      if (import.meta.env.DEV) netOverlay = new NetDebugOverlay(session);
    }

    // Offline Tutorial bots: DEV-only Behavior Editor overlay (5.3) —
    // per-bot utility/behaviour cards plus move-point and LoS lines (F8).
    const botOverlay =
      import.meta.env.DEV && session.bots.size > 0 ? new BotDebugOverlay(scene, session) : null;

    const initial = playerShip(session.curSnapshot.ships, session.playerId);
    if (initial) playerFollow.position.set(initial.pos.x, initial.pos.y, initial.pos.z);
    // Re-arm the follow rig: the Hangar's orbit mode (and the editor's) drop the
    // follow target, and 5.8 lets a player reach the Hangar straight from the
    // results screen — without this a post-Hangar match left the camera parked.
    tacticalCamera.follow(playerFollow);
    tacticalCamera.camera.target.copyFrom(playerFollow.position);
    tacticalCamera.camera.setTarget(tacticalCamera.camera.target);
    // In-match view IS the chase rig (FLIGHT.md §3). Enabled AFTER the setTarget
    // above, which recomputes alpha/beta/radius from the camera position and
    // would otherwise be undone by (and undo) the chase clamps. Seed its FRAME
    // from the spawn pose so the first frame is already behind the ship,
    // looking the way its nose points (BUBBLE.md §C).
    if (initial) tacticalCamera.setChaseFrame(initial.heading, initial.pitch, initial.up);
    else tacticalCamera.setChaseFrame(0, 0, { x: 0, y: 1, z: 0 });
    // Both offline and online sessions inherit the same ArenaSimulation world,
    // so this hands the chase rig the exact static BVH and arena ceiling used by
    // flight collision without building a client-only copy.
    tacticalCamera.setStaticWorld(session.sim.world.staticWorld, session.sim.world.arena.bounds);
    tacticalCamera.setChaseMode(true);

    // Other ships' sounds fade with range, so the feedback layer needs a listener
    // and a way to place a source. The listener is the local hull while it lives
    // and the chase rig's follow point once it doesn't (death, respawn gap).
    const audioFeedback = new AudioFeedback(configService, session.playerId, audio, {
      listenerPosition: () =>
        playerShip(session.curSnapshot.ships, session.playerId)?.pos ?? playerFollow.position,
      entityPosition: (id) => session.curSnapshot.ships.find((s) => s.id === id)?.pos ?? null,
    });
    const screenShake = new ScreenShake(configService, session.playerId, tacticalCamera, bus);
    // Takes the camera off the chase rig for the hangar spawn sequence. Built
    // per match because the pad it captures belongs to this session's arena.
    const launchCinematic = new LaunchCinematic(tacticalCamera, (id) => void audio.play(id));

    let disposed = false;
    return {
      session,
      viewManager,
      hud,
      audioFeedback,
      screenShake,
      launchCinematic,
      netOverlay,
      botOverlay,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        // Order is deliberate and every step is isolated (`runTeardown`): the
        // SESSION goes first so the socket is left and the ticking stops even
        // if Babylon teardown throws below, and the view roots are dropped last
        // as a belt — the Scene is shared with the next match, so a node that
        // survives here comes back as a remnant ship.
        runTeardown([
          { label: "session", run: () => { if (session instanceof NetGameSession) session.dispose(); } },
          { label: "audioFeedback", run: () => audioFeedback.dispose() },
          { label: "screenShake", run: () => screenShake.dispose() },
          { label: "launchCinematic", run: () => launchCinematic.stop() },
          { label: "netOverlay", run: () => netOverlay?.dispose() },
          { label: "botOverlay", run: () => botOverlay?.dispose() },
          { label: "hud", run: () => hud.dispose() },
          { label: "viewManager", run: () => viewManager.dispose() },
          { label: "viewRoots", run: () => viewManager.disposeRoots() },
        ]);
      },
    };
  }

  let runtime: MatchRuntime | null = null;
  let matchAssetsActive = false;
  let simPaused = false;
  /** Blend fraction for the frame being drawn — see `renderFrame`. */
  let frameAlpha = 0;
  /** True while the sim is frozen *because the settings screen is open* (5.8). */
  let pausedBySettings = false;

  // Workbox immediately activates a fresh worker. The running page is still
  // its old bundle, so reload as soon as it is safe; `runtime` is the one
  // authoritative signal that a live match exists.
  const updateGate = createUpdateGate({ isMatchLive: () => runtime !== null });
  if ("serviceWorker" in navigator) {
    let hadController = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      const reloadNow = updateGate.noteControllerChange(hadController);
      hadController = true;
      if (reloadNow) location.reload();
    });
  }

  /**
   * The single place a player setting turns into behaviour (§10 5.8). Called on
   * boot, on every settings change, and once per new match runtime (a fresh
   * `ScreenShake`/`Hud` starts from its own defaults).
   *
   * The renderer choice is deliberately absent: it decides which engine gets
   * constructed at boot, so the settings screen offers a reload button instead.
   */
  function applyUserSettings(values: UserSettings = userSettings.current): void {
    quality.applyOverride(values.quality);
    audio.setMasterVolume(values.masterVolume, { persist: false });
    audio.setSfxVolume(values.sfxVolume, { persist: false });
    audio.setMusicVolume(values.musicVolume, { persist: false });
    tacticalCamera.setPanSensitivityScale(values.cameraPanSens);
    tacticalCamera.setChaseDistanceScale(values.cameraDistanceScale);
    runtime?.screenShake.setUserEnabled(values.cameraShake);
    runtime?.hud.setHapticsEnabled(values.haptics);
    runtime?.hud.setInvertPitch(values.invertPitch);
    runtime?.hud.setSteerSensitivity(values.mouseSteerSens, values.touchSteerSens);
  }

  applyUserSettings();
  userSettings.onChange((values) => applyUserSettings(values));

  /**
   * Freeze/unfreeze the fixed-timestep loop. Shared by the dev editor (which
   * additionally flips the camera into editor mode) and the in-match settings
   * screen (which does not — the tactical view stays exactly as the player left
   * it behind the overlay).
   */
  function setSimPaused(paused: boolean): void {
    simPaused = paused;
  }

  /**
   * Tear the current match down. Every results-screen exit goes through here so
   * the runtime is disposed exactly once and the profile is refreshed (credits /
   * xp / level may have moved server-side via `matchRewards`). Fire-and-forget:
   * the Lobby header updates through `AuthService.onChange` when it resolves.
   *
   * Idempotent and exception-safe by construction. `runtime` is cleared BEFORE
   * anything is disposed, so the loop and `renderFrame` stop touching the dying
   * match on the very next tick no matter what happens below; every remaining
   * step is isolated by `runTeardown`, because a throw partway used to leave a
   * match ticking (and audible) behind the menu.
   *
   * Music is NOT touched here: the call sites own the screen route, and the
   * "Play a New Game" path goes straight into another match — routing to
   * `menu` here would make MusicController fade the match track out, load the
   * menu track for the length of the loading screen, and fade it out again.
   */
  function endMatch(): void {
    const dying = runtime;
    runtime = null;
    matchAssetsActive = false;
    runTeardown([
      { label: "tutorial", run: () => tutorial?.attachMatch(null) },
      {
        label: "settingsPause",
        run: () => {
          if (pausedBySettings) {
            pausedBySettings = false;
            setSimPaused(false);
          }
          settingsScreen.hide();
        },
      },
      { label: "runtime", run: () => dying?.dispose() },
      // In-flight SFX voices outlive the sim that scheduled them: without this
      // the last barrage of the match plays out over the main menu (§10 5.7).
      { label: "audio", run: () => audio.stopAll() },
      // Back to the menu/hangar rigs: the chase view only exists while a ship
      // is flying (FLIGHT.md §3), and leaving it restores the orbit limits.
      {
        label: "camera",
        run: () => {
          mvpStaged = false;
          // Before the mode flips below: leaving the shot restores whichever
          // mode is live, and that has to be the one this teardown lands on.
          tacticalCamera.setCinematicShot(null);
          tacticalCamera.clearStageScreenOffset();
          tacticalCamera.setStaticWorld(null);
          tacticalCamera.setChaseMode(false);
          tacticalCamera.setHangarMode(false);
        },
      },
      { label: "profile", run: () => void authService.refreshProfile() },
    ]);
    if (updateGate.onSafeMoment()) location.reload();
  }

  /**
   * Open the settings overlay. In an OFFLINE match it also freezes the sim (the
   * same `simPaused` flag the dev editor uses) so a player adjusting sliders
   * doesn't get shot; online matches are server-authoritative and keep running,
   * which is why the pause is conditional rather than unconditional.
   */
  function openSettings(context: "menu" | "match"): void {
    music.setScreen(context === "match" ? "match" : "menu");
    const pauseable = context === "match" && runtime !== null && !(runtime.session instanceof NetGameSession);
    if (pauseable) {
      pausedBySettings = true;
      setSimPaused(true);
    }
    settingsScreen.show({
      context,
      onClose: () => {
        if (pausedBySettings) {
          pausedBySettings = false;
          setSimPaused(false);
        }
      },
      // TEMPORARY(designer-access): remove with the settings-screen designer
      // button. The editor pauses the sim itself, so unwind the settings pause
      // first rather than leaving two owners of the same flag.
      onOpenDesigner: () => {
        if (pausedBySettings) {
          pausedBySettings = false;
          setSimPaused(false);
        }
        void openDesigner();
      },
      // Mid-match only: abandon the match outright and land in the lobby.
      // endMatch() already unwinds the settings pause and the chase rig.
      onQuitToMenu:
        context === "match"
          ? () => {
              log.info("quit to main menu from settings");
              // Walking out of the match walks out of the lesson: a director
              // still waiting on a throttle nobody can push is a dead end.
              tutorial?.skip();
              endMatch();
              music.setScreen("menu");
              lobby.show();
            }
          : undefined,
    });
  }

  /** The last match the player started — what "Play again" repeats (5.8). */
  let lastChoice: LobbyChoice | null = null;

  // Theme hot-reload fans out to the 5.7 juice/audio consumers (the HUD wires
  // its own colors/layout/haptics; camera shake listens for `camera.*` itself).
  bus.on("config:changed", (evt) => {
    if (evt.type !== "theme") return;
    const settings = audioSettingsOf(configService.get<ThemeConfig>("theme", "theme.default"));
    audio.applySettings(settings);
    music.applySettings(settings.music);
    runtime?.viewManager.refreshJuice();
    runtime?.audioFeedback.refresh();
  });

  /**
   * The menu's 3D backdrop — the pilot's main hull on lunar regolith with Earth
   * behind it. Built lazily on first show (the pack may not author one) and torn
   * down when the menu closes, because it owns the scene's camera, environment
   * texture and clear colour and must not hold them while a match runs.
   */
  let menuDiorama: MenuDiorama | null = null;
  /** Whether the main menu is the screen on show (the editor asks before restoring). */
  function isMenuVisible(): boolean {
    return lobby.visible;
  }
  function setMenuDiorama(visible: boolean): void {
    if (!visible) {
      menuDiorama?.dispose();
      menuDiorama = null;
      return;
    }
    const authored = configService.get<ThemeConfig>("theme", "theme.default")?.menu?.diorama;
    if (!authored?.enabled) return;
    if (!menuDiorama) menuDiorama = new MenuDiorama(scene, configService, preloadAssets, authored);
    const selection = loadHangarSelection();
    const shipId = selection.shipId ?? configService.getAll<ShipConfig>("ship")[0]?.id ?? null;
    menuDiorama.showHull(shipId, shipId ? ownership.selectedCosmetic(shipId) : null);
    menuDiorama.activate();
  }

  const lobby = new Lobby(
    document.body,
    configService,
    authService,
    serverHealth,
    {
      onChoose: (choice: LobbyChoice) => {
        void launchChoice(choice);
      },
      onLogout: () => {
        // Log out: drop the session and fall back to the auth gate.
        authService.logout();
        lobby.hide();
        music.setScreen("menu");
        authScreen.show();
      },
      onAccountRequested: (tab) => {
        lobby.hide();
        music.setScreen("menu");
        authScreen.show();
        if (tab === "register") authScreen.showRegisterTab();
        else authScreen.showLoginTab();
      },
      onHangarRequested: () => {
        lobby.hide();
        music.setScreen("hangar");
        hangar.show();
        tutorial?.noteScreen("hangar");
      },
      onShopRequested: () => {
        lobby.hide();
        music.setScreen("shop");
        for (const job of allHangarShipJobs(configService)) void hangarModelQueue.enqueue(job);
        shop.show();
        tutorial?.noteScreen("shop");
      },
      // The settings overlay stacks ON TOP of the lobby (z-index 40 vs 20), so
      // there is nothing to restore when it closes.
      onSettingsRequested: () => openSettings("menu"),
      onVisibilityChange: (visible) => setMenuDiorama(visible),
    },
    bus,
  );
  lobby.hide();


  const matchLoading = new MatchLoadingScreen(document.body, configService, bus);

  const settingsScreen = new SettingsScreen(document.body, {
    configs: configService,
    audio,
    settings: userSettings,
  });

  // One ownership ledger for the whole session: the Shop buys through it and
  // the Hangar gates on it, so the two can never disagree about what is owned.
  const ownership = createSessionOwnership(authService, configService);
  const ensureOwnershipReady = () => ownership.refresh().catch((err: unknown) => log.warn("ownership read failed", err));
  void ensureOwnershipReady();
  const hangarModelQueue = new ModelLoadQueue(preloadAssets, {
    gapMs: 250,
    isPaused: () => matchAssetsActive || runtime !== null,
  });

  const hangar = new Hangar(
    document.body,
    scene,
    configService,
    authService,
    tacticalCamera,
    () => {
      hangar.hide();
      music.setScreen("menu");
      lobby.show();
    },
    quality.current.particles,
    ownership,
    preloadAssets,
    hangarModelQueue,
    ensureOwnershipReady,
  );

  const shop = new ShopScreen(
    document.body,
    configService,
    ownership,
    {
      onClose: () => {
        shop.hide();
        music.setScreen("menu");
        lobby.show();
      },
    },
    bus,
  );

  // --- Tutorial (owner 2026-08-08) ------------------------------------------
  //
  // Flight school is a CONTENT config walked by a {@link TutorialDirector}. This
  // file owns only the four things a director cannot do for itself: move the
  // player between screens, stand up (and tear down) its offline match, draw the
  // coach mark, and remember the run happened. WHICH lessons exist, in what
  // order, and what counts as done all live in `content/tutorials/*.json`.
  let tutorial: TutorialDirector | null = null;
  let tutorialOverlay: TutorialOverlay | null = null;
  /** Ledger size at the last change, so only GROWTH counts as a purchase. */
  let ownedCount = ownedItemCount();
  function ownedItemCount(): number {
    return ownership.ownedShips().size + ownership.ownedModules().size + ownership.ownedCosmetics().size;
  }
  ownership.onChange(() => {
    const owned = ownedItemCount();
    if (owned > ownedCount) tutorial?.notePurchase();
    ownedCount = owned;
  });

  const tutorialHost: TutorialHost = {
    navigate(stage) {
      switch (stage) {
        case "flight":
          if (!runtime) void startTutorialMatch();
          break;
        case "lobby":
          leaveTutorialMatch();
          hangar.hide();
          shop.hide();
          music.setScreen("menu");
          lobby.show();
          tutorial?.noteScreen("lobby");
          break;
        case "hangar":
          leaveTutorialMatch();
          lobby.hide();
          shop.hide();
          music.setScreen("hangar");
          // Re-showing an open screen would rebuild its preview under the
          // player's hands; the step that sent them here already opened it.
          if (!hangar.isOpen) hangar.show();
          tutorial?.noteScreen("hangar");
          break;
        case "shop":
          leaveTutorialMatch();
          lobby.hide();
          hangar.hide();
          music.setScreen("shop");
          for (const job of allHangarShipJobs(configService)) void hangarModelQueue.enqueue(job);
          if (!shop.isOpen) shop.show();
          tutorial?.noteScreen("shop");
          break;
      }
    },
    present(view) {
      tutorialOverlay?.present(view);
    },
    finish(outcome, config) {
      log.info("tutorial finished", { outcome });
      // A SKIP counts as completion: the player made a decision, and asking
      // again would be the game arguing with them.
      markTutorialCompleted();
      tutorial = null;
      tutorialOverlay?.dispose();
      tutorialOverlay = null;
      hangar.onLoadoutChanged = null;
      if (outcome === "completed") {
        showTutorialToast(config.completeToast);
        return;
      }
      // Skipped: put them back somewhere they can play from.
      if (runtime) endMatch();
      hangar.hide();
      shop.hide();
      music.setScreen("menu");
      lobby.show();
    },
  };

  /** End the tutorial's match, if one is running, and unbind it from the director. */
  function leaveTutorialMatch(): void {
    if (runtime) endMatch();
    tutorial?.attachMatch(null);
  }

  /** Launch flight school from the menu button. */
  function startTutorial(): void {
    const config =
      configService.get<TutorialConfig>("tutorial", BASICS_TUTORIAL_ID) ??
      configService.getAll<TutorialConfig>("tutorial")[0];
    if (!config) {
      lobby.showError("This content pack ships no tutorial.");
      return;
    }
    tutorial?.dispose();
    tutorialOverlay?.dispose();
    tutorialOverlay = new TutorialOverlay(document.body, {
      onSkip: () => tutorial?.skip(),
      onConfirm: () => tutorial?.acknowledge(),
    });
    tutorial = new TutorialDirector(config, configService, tutorialHost);
    // The fitting lesson is the one thing the director cannot observe from the
    // sim: the Hangar has to say when a slot changed.
    hangar.onLoadoutChanged = () => tutorial?.noteLoadoutChanged();
    tutorial.begin();
  }

  /**
   * The tutorial's own offline match. Deliberately NOT `startMatch`: it flies an
   * authored loadout rather than the Hangar's (the lessons name a specific heat
   * ring and a specific energy ring), and its gamemode carries no rewards, no
   * clock and no roster — every ship in it is spawned by a step.
   */
  async function startTutorialMatch(): Promise<void> {
    const config = tutorial?.config;
    if (!config) return;
    lobby.hide();
    hangar.hide();
    shop.hide();
    music.setScreen("match");
    matchLoading.showPending("Building flight school");
    try {
      const authState = authService.getState();
      const session = new GameSession(
        configService,
        config.arena ?? gamemodeArena(config.gamemode) ?? FALLBACK_ARENA_ID,
        config.gamemode,
        1,
        {
          playerShipId: config.pilot.ship,
          playerFitting: config.pilot.fitting,
          playerDisplayName: authState.status === "authed" ? authState.profile.displayName : "Cadet",
        },
      );
      await prepareSessionArena(session);
      await matchLoading.dismiss();
      activateSession(session, { kind: "tutorial" });
      tutorial?.attachMatch(session);
    } catch (err) {
      matchAssetsActive = false;
      matchLoading.hide();
      music.setScreen("menu");
      log.error("failed to start the tutorial match", err);
      lobby.showError(err instanceof Error ? err.message : "Could not start the tutorial");
      tutorial?.skip();
    }
  }

  const authScreen = new AuthScreen(
    document.body,
    authService,
    () => {
      authScreen.hide();
      if (new URLSearchParams(window.location.search).has("editor")) void openDesigner();
      else {
        music.setScreen("menu");
        lobby.show();
      }
    },
    () => {
      // Skip goes to the Lobby anonymously; online modes remain disabled, while
      // the offline Tutorial is still available.
      authScreen.hide();
      music.setScreen("menu");
      lobby.show();
    },
    configService,
  );
  authScreen.hide();

  let designToolsEntry: HTMLButtonElement | null = null;
  function installDesignToolsEntry(): void {
    const state = authService.getState();
    if (state.status !== "authed" || designToolsEntry) return;
    // The profile role gates the ATTEMPT only: the shell's actual writes go
    // through the dev middleware (`/__editor/*`), which simply isn't there
    // outside a dev serve — the server stays authoritative on every call.
    if (state.profile.role !== "admin") return;
    designToolsEntry = document.createElement("button"); designToolsEntry.type = "button";
    designToolsEntry.className = "sa-design-tools-entry"; designToolsEntry.textContent = "DESIGN TOOLS";
    Object.assign(designToolsEntry.style, { position: "fixed", right: "max(16px, env(safe-area-inset-right))", bottom: "max(16px, env(safe-area-inset-bottom))", zIndex: "35", minHeight: "44px", padding: "0 18px", color: "#dceaf7", background: "#0d1524", border: "1px solid #57d8ff", font: "600 13px Orbitron, sans-serif", letterSpacing: ".1em" });
    designToolsEntry.setAttribute("aria-label", "Open the Constellation designer shell");
    designToolsEntry.addEventListener("click", () => void openDesigner()); document.body.append(designToolsEntry);
  }
  // Eager, then self-healing: this call is a no-op while the restore above is
  // still in flight, and the subscription re-runs it the moment a session lands.
  installDesignToolsEntry();
  authService.onChange(() => installDesignToolsEntry());

  boot?.settle("interface", "ok", "theme · fonts · menu");

  // --- Auth join: everything above was built while the restore was in flight ---
  //
  // The three gates below are the only places the boot path reads the session
  // SYNCHRONOUSLY, and each would silently take the anonymous branch if it ran
  // first — so this is where the wait has to land, and it has to land before
  // them. (Everything constructed above only holds the service and re-reads it
  // through `onChange`: the design-tools entry, the ownership ledger and the
  // Hangar all repaint themselves when the session arrives.)
  await authRestored;

  // A dev-admin session STORED while the page was on localhost must not survive
  // a visit via the LAN hostname: restore() would silently resurrect it and the
  // phone + laptop would again collapse into one identity (see the dev-login
  // localhost gate below — this closes the restored-session path it misses).
  const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (import.meta.env.DEV && !onLocalhost && authService.getState().status === "authed" && authService.isDevSession()) {
    log.info("dropping restored dev-admin session on a LAN hostname — use guest/login instead");
    authService.logout();
  }

  // DEV convenience: skip the login screen with an instant admin session
  // (server-side dev-login route; hard-absent in production). Escape hatches
  // for testing the real auth flow: `?login=1` for one boot, or
  // `localStorage["sa.devLogin"] = "off"` until cleared.
  // Localhost ONLY: a phone joining over the LAN (http://<pc-ip>:5173) must get
  // the auth screen and its own guest identity — if every dev client silently
  // became the same admin account, two devices could never matchmake against
  // each other (the queue de-duplicates per player).
  if (
    import.meta.env.DEV &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    authService.getState().status !== "authed" &&
    !new URLSearchParams(window.location.search).has("login") &&
    localStorage.getItem("sa.devLogin") !== "off"
  ) {
    const ok = await authService.devLogin();
    if (ok) log.info("dev-login: authenticated as admin (use ?login=1 to test the auth screen)");
  }

  if (new URLSearchParams(window.location.search).has("editor") && authService.getState().status === "authed") void openDesigner();

  // --- Boot stage 3: is the game server actually there? ---
  //
  // The answer changes what the menu is allowed to offer, so it is resolved
  // BEFORE the first screen paints rather than discovered by a player tapping a
  // button and getting a raw fetch error.
  boot?.begin("server");
  const health = await healthProbe;
  if (health.online) {
    const identity = [
      health.protocolVersion === undefined ? null : `protocol ${health.protocolVersion}`,
      health.tickRate === undefined ? null : `${health.tickRate} Hz`,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    boot?.settle("server", "ok", identity);
  } else {
    log.warn(`game server unreachable: ${health.detail}`);
    boot?.settle("server", "warn", health.detail);
    boot?.note(`${SERVER_OFFLINE_MESSAGE} — every mode is available locally.`, "warn");
  }

  if (authService.getState().status === "authed" || !health.online) {
    // No reachable server means the auth gate has exactly one working control
    // (the "Skip" link) — a static host (GitHub Pages) or a dead server should
    // land the player straight in the Lobby, where every mode works anonymously
    // against local bots, the SERVER OFFLINE badge explains the fallback, and the
    // "Log in / Sign up" link reopens the gate if the server comes back.
    music.setScreen("menu");
    lobby.show();
  } else {
    music.setScreen("menu");
    authScreen.show();
  }
  // Hold the boot screen a beat longer when it has bad news, so the player reads
  // it once here before meeting the same message as a lobby badge.
  boot?.subtitle(health.online ? "READY" : "READY — OFFLINE");

  // AWAITED, not fired and forgotten. The launch sequence owns the screen until
  // it removes itself, and the fullscreen offer below is a modal <dialog>: the
  // browser paints those in the TOP LAYER, above every z-index on the page, so
  // offering it early punches a card through the title screen.
  await boot?.dismiss(health.online ? 0 : 1600);

  // Launch fullscreen offer, over whichever screen just appeared. The
  // Fullscreen API needs a user gesture, so this dialog's button IS the
  // gesture — the page cannot simply requestFullscreen() on load.
  FullscreenPrompt.maybeShow();

  /** The Hangar's last-saved ship/fitting choice (ROADMAP §9 4.5), as additive NetGameSession join options. */
  function hangarJoinOptions(): { shipId?: string; fittingId?: string; cosmeticId?: string } {
    const sel = loadHangarSelection();
    const opts: { shipId?: string; fittingId?: string; cosmeticId?: string } = {};
    if (sel.shipId) opts.shipId = sel.shipId;
    if (sel.fittingId) opts.fittingId = sel.fittingId;
    // Stated, not assumed: the room re-reads its own selection when this is
    // absent, and re-validates ownership either way.
    const cosmeticId = sel.shipId ? ownership.selectedCosmetic(sel.shipId) : null;
    if (cosmeticId) opts.cosmeticId = cosmeticId;
    return opts;
  }

  async function launchChoice(choice: LobbyChoice): Promise<void> {
    if (choice.kind === "tutorial") {
      startTutorial();
      return;
    }
    if (!serverHealth.current.online) {
      await startBotMatch(choice);
      return;
    }
    await startOnlineMatch(choice);
  }

  /**
   * Re-check reachability after a join failed with a network error. Fire-and-
   * forget: it exists so a server that comes back up (a restarted dev process,
   * a reconnected phone) clears the badge on its own instead of forcing a page
   * reload. A still-dead server just confirms the state already shown.
   */
  function reprobeServerHealth(): void {
    void serverHealth.refresh();
  }

  function gamemodeArena(gamemodeId: string): string | undefined {
    return configService.get<GamemodeConfig>("gamemode", gamemodeId)?.defaultArena;
  }

  /**
   * How long the launch screen looks for pilots before starting anyway. Only a
   * pack whose gamemode declares no usable bots can reach it: the room's own
   * backfill lands far sooner. Past it, the match starts and the in-match lobby
   * overlay keeps reporting the wait, which is the pre-2026-08 behaviour.
   */
  const MATCH_SEARCH_TIMEOUT_MS = 60_000;

  /** The arena's skybox as a ready-to-use CSS `url()`, for the launch card art. */
  function arenaArt(arenaId: string): string | null {
    const texture = configService.get<ArenaConfig>("arena", arenaId)?.render?.skybox.texture;
    return texture ? `url("${import.meta.env.BASE_URL}content/${texture}")` : null;
  }

  /** Pilots per team the chosen mode seats — the launch card's empty slots. */
  function gamemodeTeamSize(gamemodeId: string): number {
    const gamemode = configService.get<GamemodeConfig>("gamemode", gamemodeId);
    return gamemode ? teamSizeOf(gamemode) : 1;
  }

  /**
   * ONLINE launch (ROADMAP §7 2.8, reordered 2026-08-14).
   *
   * The first thing a player sees is the search: a count-UP clock and both team
   * rosters, growing as real pilots join and again when the room backfills the
   * rest with bots. The arena scene and every match model load CONCURRENTLY with
   * that wait, so "players found" is usually the last thing missing; if it is
   * not, the same card shows what preload is left instead of blocking on it.
   */
  async function startOnlineMatch(choice: Extract<LobbyChoice, { kind: "online" }>): Promise<void> {
    lobby.hide();
    hangar.hide();
    music.setScreen("match");
    const arenaId = gamemodeArena(choice.gamemode) ?? FALLBACK_ARENA_ID;
    let cancelled = false;
    let noteCancelled: () => void = () => {};
    const cancelSignal = new Promise<void>((resolve) => {
      noteCancelled = resolve;
    });
    matchLoading.showSearching({
      teamSize: gamemodeTeamSize(choice.gamemode),
      title: configService.get<ArenaConfig>("arena", arenaId)?.name ?? arenaId,
      art: arenaArt(arenaId),
      onCancel: () => {
        cancelled = true;
        noteCancelled();
        matchAssetsActive = false;
        matchLoading.hide();
        music.setScreen("menu");
        lobby.show();
      },
    });
    // Kicked off BEFORE the join: the map is what makes a match start slow, and
    // the queue wait is free time to spend on it.
    const assets = beginMatchAssets(arenaId);
    void assets.preload.all.catch(() => {
      /* Surfaced by the awaited copy below; this only marks it handled. */
    });
    let session: NetGameSession | null = null;
    try {
      session = await NetGameSession.join(
        configService,
        {
          gamemode: choice.gamemode,
          ...hangarJoinOptions(),
          token: authService.getAccessToken() ?? undefined,
        },
        { upgradeLevels: loadHangarSelection().upgradeLevels ?? undefined },
      );
      if (cancelled) {
        session.dispose();
        return;
      }
      const joined = session;
      const outcome = await waitForMatchStart(joined, {
        onRoster: (snapshot) => matchLoading.setRoster(loadingRoster(joined, snapshot)),
        timeoutMs: MATCH_SEARCH_TIMEOUT_MS,
        cancelled: cancelSignal,
      });
      if (cancelled || outcome === "cancelled") {
        session.dispose();
        return;
      }
      if (outcome === "timeout") log.warn("room never left its lobby — starting anyway");
      await prepareSessionArena(session, assets);
      if (cancelled) {
        session.dispose();
        return;
      }
      await matchLoading.dismiss();
      activateSession(session, choice);
    } catch (err) {
      // Drop the socket unless the match actually took ownership of it — a
      // half-joined room would otherwise keep this client in its roster.
      if (session && runtime?.session !== session) session.dispose();
      if (cancelled) return;
      matchAssetsActive = false;
      matchLoading.hide();
      music.setScreen("menu");
      log.error("failed to start match", err);
      // "Nothing answered" is a different fact from "the server said no", and
      // only the second one has a message worth showing. The first used to reach
      // the player as a raw `NetworkError when attempting to fetch resource.`;
      // it now raises the same SERVER OFFLINE badge the boot probe does, and a
      // background re-probe clears it if the server comes back.
      if (looksLikeServerUnreachable(err)) {
        lobby.showServerOffline("join attempt got no answer");
        reprobeServerHealth();
        await startBotMatch(choice);
      } else {
        lobby.showError(err instanceof Error ? err.message : "Connection failed");
      }
    }
  }

  /**
   * Static-host/dead-server fallback: identical mode and arena, bot-filled teams.
   * Shares the online launch card — the roster simply arrives complete, because
   * the local session seats every bot at construction.
   */
  async function startBotMatch(choice: Extract<LobbyChoice, { kind: "online" }>): Promise<void> {
    lobby.hide();
    hangar.hide();
    music.setScreen("match");
    const arenaId = gamemodeArena(choice.gamemode) ?? FALLBACK_ARENA_ID;
    matchLoading.showSearching({
      teamSize: gamemodeTeamSize(choice.gamemode),
      title: configService.get<ArenaConfig>("arena", arenaId)?.name ?? arenaId,
      art: arenaArt(arenaId),
    });
    const assets = beginMatchAssets(arenaId);
    void assets.preload.all.catch(() => {
      /* Surfaced by the awaited copy below; this only marks it handled. */
    });
    try {
      const selection = loadHangarSelection();
      const authState = authService.getState();
      const session = new GameSession(
        configService,
        arenaId,
        choice.gamemode,
        Date.now() >>> 0,
        {
          fillBotTeams: true,
          playerDisplayName: authState.status === "authed" ? authState.profile.displayName : "Pilot",
          playerShipId: selection.shipId,
          playerFitting: selection.moduleIds,
          playerCosmeticId: selection.shipId ? ownership.selectedCosmetic(selection.shipId) : null,
        },
      );
      // Every bot is already seated locally, so the search card shows the full
      // roster for whatever is left of the preload rather than an empty grid.
      matchLoading.setRoster(loadingRoster(session));
      await prepareSessionArena(session, assets);
      await matchLoading.dismiss();
      activateSession(session, choice);
    } catch (err) {
      matchAssetsActive = false;
      matchLoading.hide();
      music.setScreen("menu");
      log.error("failed to start local bot match", err);
      lobby.showError(err instanceof Error ? err.message : "Local match failed");
      lobby.show();
    }
  }

  /** An arena build + model preload already running behind the launch screen. */
  interface PendingMatchAssets {
    arenaId: string;
    preload: MatchPreload;
  }

  /**
   * Start building the arena and loading its models NOW, reporting progress to
   * the launch screen. Callers keep the handle and await it only when the match
   * is otherwise ready to go — which is what lets the search run concurrently.
   */
  function beginMatchAssets(arenaId: string): PendingMatchAssets {
    matchAssetsActive = true;
    setArena(arenaId);
    return {
      arenaId,
      preload: preloadMatchModels(
        preloadAssets,
        configService,
        arenaId,
        (loaded, total) => matchLoading.setAssetProgress(loaded, total),
        quality.current.scene.ships?.lodBias,
      ),
    };
  }

  /**
   * The ship configs this roster actually seats. The snapshot carries no config
   * id, so the session's own entity → ship map is the only way to name them.
   */
  function seatedHulls(session: GameSession): Set<string> {
    const seated = new Set<string>();
    for (const ship of session.rosterSnapshot.ships) {
      const configId = session.shipConfigIdFor(ship.id);
      if (configId) seated.add(configId);
    }
    return seated;
  }

  /**
   * Resolve and fully preload an arena before any synchronous entity view can
   * choose (and retain) a procedural fallback master for its asteroid. Adopts an
   * in-flight preload when it covers the arena the session actually resolved
   * (the normal case — the client and the room read the same gamemode default).
   *
   * A matchmade launch — the only path that hands over a `pending` handle — has
   * its FINAL roster by now, so it blocks on the hulls that roster seats and lets
   * the rest finish behind the match: a duel waits on one hull instead of the
   * whole fleet. Every other caller (the tutorial, an editor playtest) spawns
   * ships from a script long after launch, and for those the only safe blocking
   * set is all of them.
   */
  async function prepareSessionArena(session: GameSession, pending?: PendingMatchAssets): Promise<void> {
    matchAssetsActive = true;
    setArena(session.arenaId);
    matchLoading.showSession(session, import.meta.env.BASE_URL);
    if (pending && pending.arenaId === session.arenaId) {
      await pending.preload.ready(seatedHulls(session));
      return;
    }
    await preloadMatchModels(
      preloadAssets,
      configService,
      session.arenaId,
      (loaded, total) => matchLoading.setAssetProgress(loaded, total),
      quality.current.scene.ships?.lodBias,
    ).ready();
  }

  /** Activate a session whose arena assets have already been prepared. */
  function activateSession(session: GameSession, choice: LobbyChoice): void {
    // Never let one match overwrite another. Most callers already ran
    // `endMatch()`, but the dev editor's playtest launch does not — and an
    // overwritten runtime is unreachable, so its session would keep ticking,
    // its room stay joined and its ship nodes stay in the shared Scene forever.
    if (runtime) endMatch();
    matchAssetsActive = false;
    music.setScreen("match");
    runtime = createMatchRuntime(session);
    lastChoice = choice;
    applyUserSettings();
    quality.beginMatch();
    telemetry.beginMatch();
    lobby.hide();
    hangar.hide();
  }

  // --- Fixed-timestep sim loop (30 Hz), driven by render delta ---
  const tuning = configService.getAll<TuningConfig>("tuning")[0];
  const loop = new GameLoop((fixedDt) => runtime?.session.tick(fixedDt), {
    maxTicksPerStep: tuning?.maxTicksPerFrame ?? 5,
  });
  // Editor tuning edits reconfigure the running loop's tick clamp live —
  // constructed-once caches are exactly what the tool-propagation audit hunts.
  bus.on("config:changed", (evt) => {
    if (evt.type !== "tuning") return;
    const fresh = configService.getAll<TuningConfig>("tuning")[0];
    loop.setMaxTicksPerStep(fresh?.maxTicksPerFrame ?? 5);
  });

  function renderFrame(dtMsOverride?: number): void {
    const dtMs = dtMsOverride ?? engine.getDeltaTime();
    if (!simPaused) loop.step(dtMs);

    if (runtime) {
      // Resample the session for THIS frame before anything reads its snapshots.
      // Offline that is a no-op returning the loop accumulator's phase; online
      // the session re-reads its snapshot buffer at the current instant and
      // needs no further blend (GameSession.sampleForRender). Skipped while
      // paused, which freezes the drawn frame exactly as it freezes the loop.
      if (!simPaused) frameAlpha = runtime.session.sampleForRender(loop.alpha);
      const prev = runtime.session.prevSnapshot;
      const cur = runtime.session.curSnapshot;
      const alpha = frameAlpha;

      // Drive the camera follow node from the interpolated player position.
      const pp = playerShip(prev.ships, runtime.session.playerId);
      const pc = playerShip(cur.ships, runtime.session.playerId);
      if (pc) {
        const bx = pp ? pp.pos.x : pc.pos.x;
        // The follow point tracks the ship's ALTITUDE too (BUBBLE.md §C) — it
        // used to be pinned to the old ground-plane offset, which would have left
        // the camera at sea level while the player climbed the bubble.
        const by = pp ? pp.pos.y : pc.pos.y;
        const bz = pp ? pp.pos.z : pc.pos.z;
        playerFollow.position.set(
          bx + (pc.pos.x - bx) * alpha,
          by + (pc.pos.y - by) * alpha,
          bz + (pc.pos.z - bz) * alpha,
        );
        const boundaryDistance = sceneBuilder.updatePlayerPosition(
          playerFollow.position.x,
          playerFollow.position.y,
          playerFollow.position.z,
        );
        const boundaryWarning = sceneBuilder.boundaryWarning;
        if (boundaryWarning) {
          runtime.hud.updateBoundaryProximity(
            boundaryDistance,
            boundaryWarning.warnDistance,
            boundaryWarning.warningNotification,
          );
        }
        // The chase rig follows the same interpolated ship the view draws — as
        // one orientation FRAME (nose + replicated up), never as heading and
        // pitch lerped independently, whose coordinate scales blow up near the
        // poles. `chase.yawLag`/`pitchLag` inside the rig do the smoothing.
        const fp = pp ?? pc;
        interpolateFrame(fp.heading, fp.pitch, fp.up, pc.heading, pc.pitch, pc.up, alpha, chaseFrameScratch);
        tacticalCamera.setChaseFrame(chaseFrameScratch.heading, chaseFrameScratch.pitch, chaseFrameScratch.up);
      }
      // After the chase frame, not instead of it: the pursuit rig keeps being
      // fed through the whole sequence so the cut back at control-return is
      // already pointing the right way. Runs on a null `pc` too — a dead player
      // has no sequence, and that is how the shot gets torn down.
      runtime.launchCinematic.update(pc, playerFollow.position, dtMs);

      // Consume this frame's sim events, then render dynamic views + markers + HUD.
      const events = runtime.session.drainFrameEvents();
      // Match-end telemetry (§11 6.8). This event is the one point where offline
      // and online converge: offline it comes from the local ArenaSimulation,
      // online from the server's `simEvent` broadcast, and both land in this
      // same per-frame array. Hooking the results-screen buttons instead would
      // miss every player who closes the tab on the results screen.
      if (events.some((ev) => ev.type === "matchEnded")) {
        void telemetry.endMatch({ qualityTier: quality.currentTier, deviceProbe: quality.deviceProbe });
      }
      runtime.viewManager.consumeEvents(events, cur);
      runtime.hud.consumeEvents(events);
      tutorial?.consumeEvents(events);
      runtime.audioFeedback.consumeEvents(events);
      runtime.screenShake.consumeEvents(events);
      runtime.session.clearFrameEvents();

      runtime.screenShake.update(dtMs);
      // Flags are coloured by allegiance, so the view needs to know whose side
      // the camera is on before it builds one.
      runtime.viewManager.setPlayerTeam(runtime.session.playerTeam);
      runtime.viewManager.render(prev, cur, alpha, dtMs);
      runtime.viewManager.updateMvp(dtMs);
      runtime.hud.update(cur, prev, dtMs, alpha);
      runtime.netOverlay?.update();
      runtime.botOverlay?.update();
      quality.sampleFrame(engine.getFps(), dtMs);
      telemetry.sampleFrame(dtMs);
    }
    // The tutorial ticks on every frame, in or out of a match: its menu-stage
    // steps (open the hangar, fit a module, read the shop) have no sim to read.
    // After the HUD, because a step that spawns a ship replaces the session's
    // current snapshot and every widget above has already read this frame's.
    tutorial?.update(dtMs, runtime?.session.curSnapshot, runtime?.session.prevSnapshot);
    tacticalCamera.update(dtMs / 1000);
    scene.render();
  }

  // A single throwing frame must never silently kill the render loop (the
  // canvas would stay black-cleared while the DOM HUD looks alive). Log,
  // surface once, and keep rendering.
  let frameErrorShown = false;
  engine.runRenderLoop(() => {
    try {
      renderFrame();
    } catch (err) {
      log.error("render frame failed", err);
      if (!frameErrorShown) {
        frameErrorShown = true;
        runtime?.hud.showToast("Render error — see console (F12)");
      }
    }
  });

  // Editor host capabilities. Built unconditionally (not DEV-gated) because the
  // designer shell uses these scene/camera hooks for its 3D viewport in every
  // build; only the F10 shell binding below stays DEV-only.
  //
  // TEMPORARY(designer-access): remove with the settings-screen designer button.
  // `openDesigner()` also sits outside the DEV gate for one reason only — the
  // designer authors from a phone, which has no F10 key, and reaches the shell
  // through the settings screen. Re-gating it (and deleting the settings
  // button) is the whole rollback. The editor modules stay behind a dynamic
  // import in both builds, so nothing of the editor enters the initial payload
  // (tools/bundle-budget.ts gates exactly that). The dev-server save endpoints
  // (/__editor/*) do not exist in a production build: the button is for looking
  // at the UI, not for authoring against it.
  let editorShell: import("./editor/EditorShell.js").EditorShell | null = null;
  /** Arena the editor last staged via `rebuildArena(id)`, if it differs from the game's. */
  let editorArenaId: string | null = null;
  /** Arena the SceneBuilder currently shows — lets stale-only rebuilds no-op. */
  let stagedArenaId: string | null = null;
  const editorHost = {
    scene,
    configService,
    bus,
    pauseSim: () => {
      setSimPaused(true);
      tacticalCamera.setEditorMode(true);
    },
    resumeSim: () => {
      setSimPaused(false);
      tacticalCamera.setEditorMode(false);
      tacticalCamera.follow(playerFollow);
      // The Quality panel writes `sa.quality` directly — pick up whatever the
      // dev changed while the editor was open (5.8 store owns the rest).
      userSettings.refresh();
      // The Map tool may have staged a different arena than the one the game
      // was on; the sim/minimap still read `currentArenaId`, so the scene must
      // return to it or a resumed match plays over the wrong floor and skybox.
      const gameArena = currentArenaId ?? FALLBACK_ARENA_ID;
      if (editorArenaId !== null && editorArenaId !== gameArena) { stagedArenaId = gameArena; sceneBuilder.buildArena(gameArena); }
      editorArenaId = null;
    },
    rebuildArena: (arenaId?: string, onlyIfStale?: boolean) => {
      // The Map tool passes the arena it is editing — which is not necessarily
      // the arena the last match played (`currentArenaId`); without the
      // override, switching maps in the editor kept the old floor and skybox.
      const id = arenaId ?? currentArenaId ?? FALLBACK_ARENA_ID;
      editorArenaId = arenaId ?? null;
      if (onlyIfStale && id === stagedArenaId) return;
      stagedArenaId = id;
      sceneBuilder.buildArena(id);
      // GLB props/terrain for a never-played arena are not in the registry yet.
      void preloadArenaModels(preloadAssets, configService, id);
    },
    // The editor takes over the canvas: the live match (HUD, entity views) is
    // hidden so nothing of the running game shows through behind the editor's
    // own stage. `runtime` is null on the menu screens — nothing to hide then.
    setGameVisible: (visible: boolean) => {
      hudRoot.style.display = visible ? "" : "none";
      // Menu/auth/hangar screens are body-level overlays — hide them too or
      // they float over the editor viewport (editor.css targets this class).
      document.body.classList.toggle("sa-editor-open", !visible);
      runtime?.viewManager.setVisible(visible);
      runtime?.botOverlay?.setSuppressed(!visible);
      // The menu's diorama is not a DOM overlay: it owns the scene's CAMERA,
      // environment texture and clear colour, and parks a hull at the origin.
      // Left up, the editor's own stage renders through the menu's camera with
      // the menu's ship standing in the middle of it.
      setMenuDiorama(visible && isMenuVisible());
    },
    setArenaVisible: (visible: boolean) => {
      sceneBuilder.setVisible(visible);
    },
    setSpawnMarkersForced: (forced: boolean) => {
      sceneBuilder.setSpawnMarkerOverride(forced ? true : null);
    },
    setPropPickingForced: (forced: boolean) => {
      sceneBuilder.setPropPickingOverride(forced);
    },
    launchPlaytest: async (arenaId: string, gamemodeId: string) => {
      const arena = configService.get("arena", arenaId);
      const mode = configService.get<GamemodeConfig>("gamemode", gamemodeId);
      if (!arena || !mode) throw new Error("Playtest arena or gamemode is missing");
      const validation = arenaSchema.safeParse(arena);
      if (!validation.success) throw new Error(validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      editorShell?.close();
      matchLoading.showPending("Building editor playtest");
      try {
        const session = new GameSession(configService, arenaId, gamemodeId, 1);
        await prepareSessionArena(session);
        await matchLoading.dismiss();
        activateSession(session, { kind: "tutorial" });
      } catch (error) {
        matchAssetsActive = false;
        matchLoading.hide();
        throw error;
      }
    },
    suspendCameraGestures: (suspended: boolean) => {
      tacticalCamera.setGesturesSuspended(suspended);
    },
  };

  /**
   * Open (or close) the Constellation designer shell. One entry point for both
   * the DEV F10 key and the temporary settings-screen button; the shell and its
   * late-registered panels are built once and toggled after that.
   */
  async function openDesigner(): Promise<void> {
    const [{ EditorShell }, { ModuleEditor }, { ShipManagerModules }] = await Promise.all([
      import("./editor/EditorShell.js"),
      import("./editor/ModuleEditor.js"),
      import("./editor/ShipManagerModules.js"),
    ]);
    if (!editorShell) {
      editorShell = new EditorShell(editorHost);
      editorShell.registerPanel("Modules", (host, report) => new ModuleEditor(host, report));
      editorShell.registerPanel("Ships", (host, report) => new ShipManagerModules(host, report));
    }
    editorShell.toggle();
  }

  if (import.meta.env.DEV) {
    window.addEventListener("keydown", (event) => {
      if (event.key !== "F10" || event.repeat) return;
      event.preventDefault();
      void openDesigner();
    });
    (window as unknown as Record<string, unknown>)["__debug"] = {
      scene,
      engine,
      sceneBuilder,
      assets: preloadAssets,
      tacticalCamera,
      configService,
      get session() {
        return runtime?.session;
      },
      get viewManager() {
        return runtime?.viewManager;
      },
      get hud() {
        return runtime?.hud;
      },
      get botOverlay() {
        return runtime?.botOverlay;
      },
      lobby,
      settingsScreen,
      userSettings,
      openSettings,
      quality,
      audio,
      get audioFeedback() {
        return runtime?.audioFeedback;
      },
      get screenShake() {
        return runtime?.screenShake;
      },
      startMatch: startOnlineMatch,
      meshCount: () => scene.meshes.length,
      /**
       * Manually drive one render frame (sim tick + HUD/view sync) without
       * relying on `requestAnimationFrame`, which browsers suspend for
       * hidden/uncomposited tabs. Handy for headless verification.
       */
      forceFrame: (dtMs = 33) => renderFrame(dtMs),
    };
  }

  // ResizeObserver, not window "resize": the canvas can change size without a
  // window resize (late CSS, devtools/pane layout, mobile URL bar), and an
  // engine created before layout settles would otherwise keep its 300×150
  // default buffer forever.
  const resizeObserver = new ResizeObserver(() => {
    // A move between displays changes devicePixelRatio; the tier's DPR cap and
    // scaling multiplier have to be re-applied against the new value.
    quality.refreshDevicePixelRatio(window.devicePixelRatio || 1);
    engine.resize();
    // This callback is the ONLY thing that can invalidate the HUD's cached CSS
    // size, so it is also the only place that re-reads it.
    refreshCanvasCssSize();
    // Orientation drives the chase camera's default distance (the authored
    // landscapeRadiusScale) — same width>height rule the HUD layout uses.
    tacticalCamera.setLandscapeOrientation(canvasCssW > canvasCssH);
    if (mvpStaged) applyMvpStageOffset();
  });
  resizeObserver.observe(canvas);
  engine.resize();
  // SEED, and it is load-bearing: the render loop is already running by this
  // line, and the ResizeObserver's first callback does not arrive until after
  // the current task yields. A cache left at 0 until then makes `project()`
  // refuse every marker, so the HUD would come up blank for the opening frames.
  // Nothing between `runRenderLoop` above and here may await.
  refreshCanvasCssSize();
  tacticalCamera.setLandscapeOrientation(canvasCssW > canvasCssH);

  window.addEventListener("beforeunload", () => {
    tutorialOverlay?.dispose();
    runtime?.dispose();
    music.dispose();
    audio.dispose();
    settingsScreen.dispose();
    userSettings.dispose();
    hangar.dispose();
    hangarModelQueue.dispose();
    matchLoading.dispose();
    sceneBuilder.dispose();
    tacticalCamera.dispose();
    quality.dispose();
  });
}


/** Linear scan (no per-frame closure allocation) for a ship by id. */
function playerShip(ships: readonly ShipSnapshot[], id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < ships.length; i++) if (ships[i]!.id === id) return ships[i];
  return undefined;
}

// The boot screen is static markup in index.html, so it is already on screen by
// the time this module runs — adopting it here only hands it a driver. A boot
// that throws leaves the panel up with the reason on it: a blank page is the one
// outcome that tells the player nothing at all.
// iOS ignores the viewport zoom flags in browser tabs, so install the gesture
// guards before the boot screen can receive a touch.
installTouchGuards();
const bootScreen = BootScreen.attach();
bootstrap(bootScreen).catch((err) => {
  log.error("bootstrap failed", err);
  bootScreen?.fail(err instanceof Error ? err.message : "unknown error — see console (F12)");
});
