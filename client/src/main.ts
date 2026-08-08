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
  type ShipConfig,
  type TuningConfig,
  type ShipSnapshot,
  type EntityId,
  type ThemeConfig,
  type FrameAttitude,
  interpolateFrame,
} from "@space-arena/shared";
import { wireContentHotReload } from "./core/contentHotReload.js";
import { recoverFromStaleContentPack } from "./core/contentRecovery.js";
import { designTokenCssVars } from "./game/themeTokens.js";
import { createUpdateGate } from "./core/swUpdate.js";
import { installTouchGuards } from "./core/touchGuards.js";
import { AssetRegistry } from "./core/AssetRegistry.js";
import { preloadArenaModels, preloadShipModelsBeforeTimeout } from "./core/assetPreload.js";
import { QualityManager } from "./core/QualityManager.js";
import { SceneBuilder } from "./core/SceneBuilder.js";
import { AuthService } from "./core/AuthService.js";
import {
  looksLikeServerUnreachable,
  SERVER_OFFLINE_MESSAGE,
  ServerHealthState,
} from "./core/serverHealth.js";
import { TelemetryClient } from "./core/TelemetryClient.js";
import { TacticalCamera } from "./game/TacticalCamera.js";
import { GameSession } from "./game/GameSession.js";
import { ViewManager } from "./game/EntityView.js";
import { Hud } from "./game/hud/Hud.js";
import { Lobby, type LobbyChoice } from "./game/screens/Lobby.js";
import { BootScreen } from "./game/screens/BootScreen.js";
import { AuthScreen } from "./game/screens/AuthScreen.js";
import { Hangar, loadHangarSelection } from "./game/screens/Hangar.js";
import { ShopScreen } from "./game/screens/ShopScreen.js";
import { createSessionOwnership } from "./game/sessionOwnership.js";
import { SettingsScreen } from "./game/screens/SettingsScreen.js";
import { MatchmakingScreen } from "./game/screens/MatchmakingScreen.js";
import { FullscreenPrompt } from "./game/screens/FullscreenPrompt.js";
import { MatchLoadingScreen } from "./game/screens/MatchLoadingScreen.js";
import {
  defaultRendererPreference,
  parseRenderer,
  UserSettingsStore,
  type UserSettings,
} from "./core/userSettings.js";
import { NetGameSession } from "./net/NetGameSession.js";
import { MatchmakingClient } from "./net/MatchmakingClient.js";
import {
  MatchmakingInterruptedError,
  searchForMatch,
} from "./net/MatchmakingSearch.js";
import { NetDebugOverlay } from "./net/NetDebugOverlay.js";
import { BotDebugOverlay } from "./game/BotDebugOverlay.js";
import { AudioManager } from "./audio/AudioManager.js";
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
 * Everything that lives for exactly one practice match: the authoritative
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

  // Reachability probe starts NOW and is awaited at its own boot stage below.
  // Concurrent on purpose: the ship-model preload takes seconds and the probe
  // needs nothing from it, so the boot pays max(preload, probe) rather than the
  // sum — and every auth call between here and there already has its answer
  // waiting when it fails.
  const serverHealth = new ServerHealthState();
  const healthProbe = serverHealth.refresh();

  // --- Auth (§8 3.3): restore any existing session before the first screen shows. ---
  const authService = new AuthService();
  await authService.restore();

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

  // An explicit URL or saved backend always wins. Safari's no-preference
  // default is WebGPU, while other browsers retain the conservative WebGL2
  // default. A missing adapter or an engine-init failure must never prevent
  // Safari from reaching the game.
  const rendererPref =
    parseRenderer(new URLSearchParams(window.location.search).get("renderer")) ??
    parseRenderer(localStorage.getItem("spacearena.renderer")) ??
    defaultRendererPreference(window.navigator);
  let actualRenderer = rendererPref;
  let engine: Engine;
  if (rendererPref === "webgpu") {
    if (!("gpu" in navigator)) {
      log.warn("WebGPU requested but unavailable; falling back to WebGL");
      actualRenderer = "webgl";
      engine = new Engine(canvas, true);
    } else {
      try {
        engine = (await EngineFactory.CreateAsync(canvas, {})) as Engine;
      } catch (error) {
        log.warn("WebGPU engine creation failed; falling back to WebGL", { error });
        actualRenderer = "webgl";
        engine = new Engine(canvas, true);
      }
    }
  } else {
    engine = new Engine(canvas, true);
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
  const audio = new AudioManager({
    settings: audioSettingsOf(configService.get<ThemeConfig>("theme", "theme.default")),
  });
  audio.attachUnlock();

  // Player settings (§10 5.8). One store owns the localStorage overrides; the
  // apply pass below is the ONLY place that turns a setting into behaviour, so
  // the settings screen never has to know about the engine, the audio graph or
  // the camera rig. Volume defaults come from whatever the AudioManager already
  // resolved (stored value, else the theme's default).
  const userSettings = new UserSettingsStore(undefined, {
    masterVolume: audio.masterVolume,
    sfxVolume: audio.sfxVolume,
  });

  // Preload GLB hulls for every ship that configures one (render.model), so
  // the sync view/hangar/editor paths can pick them up from the shared cache.
  // Awaited because a ship view synchronously selects and retains one master;
  // letting the first frame race this load can lock in the procedural fallback.
  //
  // This wait used to raise its own ad-hoc "LOADING SHIP SYSTEMS…" label in the
  // middle of a black page. It is now a STAGE of the boot screen, which was
  // already up before this module even loaded — one loading affordance for the
  // whole boot instead of two that never met.
  const preloadAssets = new AssetRegistry(scene);
  const SHIP_PRELOAD_TIMEOUT_MS = 10_000;
  boot?.begin("assets");
  const shipModelsReady = await preloadShipModelsBeforeTimeout(
    preloadAssets,
    configService,
    SHIP_PRELOAD_TIMEOUT_MS,
  );
  if (shipModelsReady) {
    boot?.settle("assets", "ok");
  } else {
    log.warn("ship model preload timed out after 10s — booting with procedural fallbacks");
    boot?.settle("assets", "warn", "timed out — using procedural hulls");
  }
  bus.on("config:changed", (evt) => {
    if (evt.id.startsWith("ship.")) {
      const ship = configService.get<ShipConfig>("ship", evt.id);
      if (ship?.render.model) void preloadAssets.ensureModel(ship.render);
    }
  });

  // --- Static arena (0.6/0.7/0.8): bounds/skybox/ground/lighting/spawns only ---
  //
  // ONE resolved arena id drives the scene and the minimap. The sim resolves the
  // real arena from the gamemode/join options, so every consumer here reads
  // `session.arenaId` through `setArena` once a match starts (FLIGHT.md §6) —
  // hardcoding an id in either split the client's view of the arena from the sim's.
  const sceneBuilder = new SceneBuilder(scene, configService, bus, quality.current);
  let currentArenaId = FALLBACK_ARENA_ID;
  sceneBuilder.buildArena(currentArenaId);
  // Asteroid hulls are preloaded per-ARENA (unlike ship hulls, which are all
  // preloaded up front): which rocks a match needs is a property of its arena,
  // and they are ~1 MB each. Kicked off here for the fallback arena and again
  // in `setArena` as soon as a match resolves the real one. Match activation
  // also awaits that resolved arena below before creating any asteroid view.
  void preloadArenaModels(preloadAssets, configService, currentArenaId);
  bus.on("config:changed", (evt) => {
    // Authoring a rock model in the dev editor should not need a page reload.
    if (evt.type === "arena" || evt.type === "asteroid") {
      void preloadArenaModels(preloadAssets, configService, currentArenaId);
    }
  });

  // One subscription fans the active tier out to every consumer.
  quality.onChange((cfg) => {
    sceneBuilder.setQuality(cfg);
    runtime?.viewManager.setQuality(cfg);
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
  const flightBinding: FlightHudBinding = {
    inputSurface: canvas,
    project(x: number, y: number, z: number, out: ProjectedPoint): boolean {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= 0 || height <= 0) return false;
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
      out.x = projectResult.x * width;
      out.y = projectResult.y * height;
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
      { playSound: (id, volume) => audio.play(id, volume) },
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
          const again = lastChoice ?? { kind: "practice" as const, gamemode: "gamemode.practice-bots-1v1" };
          endMatch();
          void launchChoice(again);
        },
        onMenu: () => {
          log.info("match over — returning to lobby");
          endMatch();
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

    // Offline practice with bots: DEV-only Behavior Editor overlay (5.3) —
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
    tacticalCamera.setChaseMode(true);

    const audioFeedback = new AudioFeedback(configService, session.playerId, audio);
    const screenShake = new ScreenShake(configService, session.playerId, tacticalCamera, bus);

    return {
      session,
      viewManager,
      hud,
      audioFeedback,
      screenShake,
      netOverlay,
      botOverlay,
      dispose(): void {
        viewManager.dispose();
        hud.dispose();
        screenShake.dispose();
        netOverlay?.dispose();
        botOverlay?.dispose();
        if (session instanceof NetGameSession) session.dispose();
      },
    };
  }

  let runtime: MatchRuntime | null = null;
  let simPaused = false;
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
   */
  function endMatch(): void {
    if (pausedBySettings) {
      pausedBySettings = false;
      setSimPaused(false);
    }
    settingsScreen.hide();
    runtime?.dispose();
    runtime = null;
    // Back to the menu/hangar rigs: the chase view only exists while a ship is
    // flying (FLIGHT.md §3), and leaving it restores the tactical orbit limits.
    mvpStaged = false;
    tacticalCamera.clearStageScreenOffset();
    tacticalCamera.setChaseMode(false);
    tacticalCamera.setHangarMode(false);
    void authService.refreshProfile();
    if (updateGate.onSafeMoment()) location.reload();
  }

  /**
   * Open the settings overlay. In an OFFLINE match it also freezes the sim (the
   * same `simPaused` flag the dev editor uses) so a player adjusting sliders
   * doesn't get shot; online matches are server-authoritative and keep running,
   * which is why the pause is conditional rather than unconditional.
   */
  function openSettings(context: "menu" | "match"): void {
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
      // Mid-match only: abandon the match outright and land in the lobby.
      // endMatch() already unwinds the settings pause and the chase rig.
      onQuitToMenu:
        context === "match"
          ? () => {
              log.info("quit to main menu from settings");
              endMatch();
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
    audio.applySettings(audioSettingsOf(configService.get<ThemeConfig>("theme", "theme.default")));
    runtime?.viewManager.refreshJuice();
    runtime?.audioFeedback.refresh();
  });

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
        authScreen.show();
      },
      onAccountRequested: (tab) => {
        lobby.hide();
        authScreen.show();
        if (tab === "register") authScreen.showRegisterTab();
        else authScreen.showLoginTab();
      },
      onHangarRequested: () => {
        lobby.hide();
        hangar.show();
      },
      onShopRequested: () => {
        lobby.hide();
        shop.show();
      },
      // The settings overlay stacks ON TOP of the lobby (z-index 40 vs 20), so
      // there is nothing to restore when it closes.
      onSettingsRequested: () => openSettings("menu"),
    },
    bus,
  );
  lobby.hide();

  const matchmakingClient = new MatchmakingClient(authService);
  let matchmakingRun = 0;
  let retryMatchmakingChoice: Extract<LobbyChoice, { kind: "matchmaking" }> | null = null;
  const matchmakingScreen = new MatchmakingScreen(
    document.body,
    configService,
    {
      onCancel: () => void leaveMatchmaking(),
      onBack: () => leaveMatchmaking(false),
      onRetry: () => {
        if (retryMatchmakingChoice) void startMatchmaking(retryMatchmakingChoice);
      },
    },
    bus,
  );
  const matchLoading = new MatchLoadingScreen(document.body, configService, bus);

  const settingsScreen = new SettingsScreen(document.body, {
    configs: configService,
    audio,
    settings: userSettings,
  });

  // One ownership ledger for the whole session: the Shop buys through it and
  // the Hangar gates on it, so the two can never disagree about what is owned.
  const ownership = createSessionOwnership(authService, configService);
  void ownership.refresh().catch((err: unknown) => log.warn("initial ownership read failed", err));

  const hangar = new Hangar(
    document.body,
    scene,
    configService,
    authService,
    tacticalCamera,
    () => {
      hangar.hide();
      lobby.show();
    },
    quality.current.particles,
    ownership,
  );

  const shop = new ShopScreen(
    document.body,
    configService,
    ownership,
    {
      onClose: () => {
        shop.hide();
        lobby.show();
      },
    },
    bus,
  );

  const authScreen = new AuthScreen(
    document.body,
    authService,
    () => {
      authScreen.hide();
      lobby.show();
    },
    () => {
      // "Skip (offline practice)": go straight to the Lobby, still anonymous
      // (its online buttons stay disabled — practice works without auth).
      authScreen.hide();
      lobby.show();
    },
    configService,
  );
  authScreen.hide();

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
    boot?.note(`${SERVER_OFFLINE_MESSAGE} — offline practice still works.`, "warn");
  }

  if (authService.getState().status === "authed" || !health.online) {
    // No reachable server means the auth gate has exactly one working control
    // (the "Skip" link) — a static host (GitHub Pages) or a dead server should
    // land the player straight in the Lobby, where practice works anonymously,
    // the SERVER OFFLINE badge explains the disabled online modes, and the
    // "Log in / Sign up" link reopens the gate if the server comes back.
    lobby.show();
  } else {
    authScreen.show();
  }
  // Hold the boot screen a beat longer when it has bad news, so the player reads
  // it once here before meeting the same message as a lobby badge.
  boot?.subtitle(health.online ? "READY" : "READY — OFFLINE");
  void boot?.dismiss(health.online ? 0 : 1600);

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
    if (choice.kind !== "practice" && !serverHealth.current.online) {
      lobby.setBusy(true, "Checking server…");
      const health = await serverHealth.refresh();
      if (!health.online) {
        lobby.showServerOffline(health.detail);
        return;
      }
    }
    if (choice.kind === "matchmaking") await startMatchmaking(choice);
    else await startMatch(choice);
  }

  function matchmakingTiming(): { pollMs: number; foundBeatMs: number } {
    const authored = configService.get<ThemeConfig>("theme", "theme.default")?.menu?.matchmaking;
    return {
      pollMs: authored?.pollIntervalMs ?? 2000,
      foundBeatMs: authored?.foundBeatMs ?? 900,
    };
  }

  function leaveMatchmaking(cancelServer = true): void {
    matchmakingRun++;
    retryMatchmakingChoice = null;
    matchmakingScreen.hide();
    lobby.show();
    if (cancelServer) void matchmakingClient.cancel().catch(() => undefined);
  }

  async function startMatchmaking(choice: Extract<LobbyChoice, { kind: "matchmaking" }>): Promise<void> {
    const run = ++matchmakingRun;
    retryMatchmakingChoice = choice;
    lobby.hide();
    matchmakingScreen.begin();
    try {
      const joinOptions = hangarJoinOptions();
      const status = await searchForMatch(matchmakingClient, {
        mode: choice.mode,
        joinOptions,
        pollMs: () => matchmakingTiming().pollMs,
        isActive: () => run === matchmakingRun,
      });
      if (run !== matchmakingRun || !status) return;

      matchmakingScreen.found(status.opponentName);
      await waitMs(matchmakingTiming().foundBeatMs);
      if (run !== matchmakingRun) return;
      matchmakingScreen.joining();
      matchLoading.showPending("Joining arena");

      const session = await NetGameSession.join(
        configService,
        { gamemode: choice.gamemode, ...joinOptions },
        { upgradeLevels: loadHangarSelection().upgradeLevels ?? undefined },
        status.reservation,
      );
      if (run !== matchmakingRun) {
        session.dispose();
        return;
      }
      await prepareSessionArena(session);
      if (run !== matchmakingRun) {
        session.dispose();
        return;
      }
      await matchLoading.dismiss();
      if (run !== matchmakingRun) {
        session.dispose();
        return;
      }
      activateSession(session, choice);
    } catch (err) {
      if (run !== matchmakingRun) return;
      log.error("matchmaking failed", err);
      matchLoading.hide();
      if (err instanceof MatchmakingInterruptedError) {
        matchmakingScreen.interrupted();
        return;
      }
      matchmakingScreen.serverLost();
      lobby.setServerOnline(false, "matchmaking connection failed");
      reprobeServerHealth();
    }
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

  /** Arena a practice gamemode wants (its `defaultArena`), if it names one. */
  function practiceArena(gamemodeId?: string): string | undefined {
    if (!gamemodeId) return undefined;
    return configService.get<GamemodeConfig>("gamemode", gamemodeId)?.defaultArena;
  }

  async function startMatch(choice: Exclude<LobbyChoice, { kind: "matchmaking" }>): Promise<void> {
    lobby.hide();
    hangar.hide();
    matchLoading.showPending(choice.kind === "practice" ? "Building practice arena" : "Joining arena");
    try {
      // Resolve the gamemode FIRST so the arena lookup sees the same id the
      // session runs.
      const practiceMode = choice.gamemode;
      const hangar = loadHangarSelection();
      const authState = authService.getState();
      const session =
        choice.kind === "practice"
          ? new GameSession(configService, practiceArena(practiceMode) ?? FALLBACK_ARENA_ID, practiceMode, 1, {
              // Offline practice flies the Hangar's loadout too (owner
              // 2026-07-31) — including edits that were never saved to a named
              // fitting, which an online room cannot accept on trust.
              playerShipId: hangar.shipId,
              playerFitting: hangar.moduleIds,
              // The paint equipped on the hull being flown; the sim gates it.
              playerCosmeticId: hangar.shipId ? ownership.selectedCosmetic(hangar.shipId) : null,
              playerDisplayName: authState.status === "authed"
                ? authState.profile.displayName
                : "Pilot",
            })
          : await NetGameSession.join(
              configService,
              {
                gamemode: choice.gamemode,
                ...hangarJoinOptions(),
                ...choice.options,
                token: authService.getAccessToken() ?? undefined,
              },
              // Client-only prediction hint — deliberately NOT part of the join
              // options (those go over the wire); the server resolves its own
              // upgrade levels from the DB. See LocalPredictionHints.
              { upgradeLevels: loadHangarSelection().upgradeLevels ?? undefined },
            );
      await prepareSessionArena(session);
      await matchLoading.dismiss();
      activateSession(session, choice);
    } catch (err) {
      matchLoading.hide();
      log.error("failed to start match", err);
      // "Nothing answered" is a different fact from "the server said no", and
      // only the second one has a message worth showing. The first used to reach
      // the player as a raw `NetworkError when attempting to fetch resource.`;
      // it now raises the same SERVER OFFLINE badge the boot probe does, and a
      // background re-probe clears it if the server comes back.
      if (looksLikeServerUnreachable(err)) {
        lobby.showServerOffline("join attempt got no answer");
        reprobeServerHealth();
      } else {
        lobby.showError(err instanceof Error ? err.message : "Connection failed");
      }
    }
  }

  /**
   * Resolve and fully preload an arena before any synchronous entity view can
   * choose (and retain) a procedural fallback master for its asteroid.
   */
  async function prepareSessionArena(session: GameSession): Promise<void> {
    setArena(session.arenaId);
    matchLoading.showSession(session, import.meta.env.BASE_URL);
    await preloadArenaModels(preloadAssets, configService, session.arenaId);
  }

  /** Activate a session whose arena assets have already been prepared. */
  function activateSession(session: GameSession, choice: LobbyChoice): void {
    runtime = createMatchRuntime(session);
    lastChoice = choice;
    applyUserSettings();
    quality.beginMatch();
    telemetry.beginMatch();
    lobby.hide();
    hangar.hide();
    matchmakingScreen.hide();
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
      const prev = runtime.session.prevSnapshot;
      const cur = runtime.session.curSnapshot;
      const alpha = loop.alpha;

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

  if (import.meta.env.DEV) {
    let editorShell: import("./editor/EditorShell.js").EditorShell | null = null;
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
      },
      rebuildArena: () => {
        sceneBuilder.buildArena(currentArenaId);
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
      },
      setArenaVisible: (visible: boolean) => {
        sceneBuilder.setVisible(visible);
      },
      setSpawnMarkersForced: (forced: boolean) => {
        sceneBuilder.setSpawnMarkerOverride(forced ? true : null);
      },
      suspendCameraGestures: (suspended: boolean) => {
        tacticalCamera.setGesturesSuspended(suspended);
      },
    };
    window.addEventListener("keydown", (event) => {
      if (event.key !== "F10" || event.repeat) return;
      event.preventDefault();
      void Promise.all([
        import("./editor/EditorShell.js"),
        import("./editor/ModuleEditor.js"),
        import("./editor/ShipManagerModules.js"),
      ]).then(([{ EditorShell }, { ModuleEditor }, { ShipManagerModules }]) => {
        if (!editorShell) {
          editorShell = new EditorShell(editorHost);
          editorShell.registerPanel("Modules", (host, report) => new ModuleEditor(host, report));
          editorShell.registerPanel("Ships", (host, report) => new ShipManagerModules(host, report));
        }
        editorShell.toggle();
      });
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
      startMatch,
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
    // Orientation drives the chase camera's default distance (the authored
    // landscapeRadiusScale) — same width>height rule the HUD layout uses.
    tacticalCamera.setLandscapeOrientation(canvas.clientWidth > canvas.clientHeight);
    if (mvpStaged) applyMvpStageOffset();
  });
  resizeObserver.observe(canvas);
  engine.resize();
  tacticalCamera.setLandscapeOrientation(canvas.clientWidth > canvas.clientHeight);

  window.addEventListener("beforeunload", () => {
    runtime?.dispose();
    audio.dispose();
    settingsScreen.dispose();
    userSettings.dispose();
    hangar.dispose();
    matchmakingScreen.dispose();
    matchLoading.dispose();
    sceneBuilder.dispose();
    tacticalCamera.dispose();
    quality.dispose();
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
