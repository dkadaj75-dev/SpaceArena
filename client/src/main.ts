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
} from "@space-arena/shared";
import { wireContentHotReload } from "./core/contentHotReload.js";
import { AssetRegistry } from "./core/AssetRegistry.js";
import { QualityManager } from "./core/QualityManager.js";
import { SceneBuilder } from "./core/SceneBuilder.js";
import { AuthService } from "./core/AuthService.js";
import { TelemetryClient } from "./core/TelemetryClient.js";
import { TacticalCamera } from "./game/TacticalCamera.js";
import { GameSession } from "./game/GameSession.js";
import { ViewManager } from "./game/EntityView.js";
import { Hud } from "./game/hud/Hud.js";
import { Lobby, type LobbyChoice } from "./game/screens/Lobby.js";
import { AuthScreen } from "./game/screens/AuthScreen.js";
import { Hangar, loadHangarSelection } from "./game/screens/Hangar.js";
import { SettingsScreen } from "./game/screens/SettingsScreen.js";
import { UserSettingsStore, type UserSettings } from "./core/userSettings.js";
import { NetGameSession } from "./net/NetGameSession.js";
import { NetDebugOverlay } from "./net/NetDebugOverlay.js";
import { BotDebugOverlay } from "./game/BotDebugOverlay.js";
import { AudioManager } from "./audio/AudioManager.js";
import { AudioFeedback } from "./audio/AudioFeedback.js";
import { audioSettingsOf } from "./audio/soundIds.js";
import { ScreenShake } from "./game/juice/ScreenShake.js";
import { angleDeltaTo } from "./game/chaseCamera.js";
import type { FlightHudBinding } from "./game/hud/FlightControls.js";
import type { CameraView } from "./game/hud/flightHudLayout.js";

const log = createLogger("Client");

/**
 * Arena rendered before any match resolves one (boot/menu backdrop) and for a
 * gamemode that declares no `defaultArena`. The ONLY arena id literal in the
 * client — every in-match consumer routes through the session's resolved id.
 */
const FALLBACK_ARENA_ID = "arena.ring-nebula";

/**
 * Content lives at `/content/*` in both worlds: the Vite plugin serves it in dev
 * (client/vite.config.ts), Express serves it in production
 * (server/src/staticSite.ts), and the service worker puts a network-first cache
 * in front of it so a new pack goes live without a redeploy (ROADMAP §11 6.5).
 */
async function fetchLoader(relPath: string): Promise<unknown> {
  const res = await fetch(`/content/${relPath}`);
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
  if (navigator.onLine || import.meta.env.DEV || location.pathname === "/offline.html") return false;
  log.warn("offline with no cached content pack — showing the offline page");
  location.replace("/offline.html");
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

async function bootstrap(): Promise<void> {
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
  const loadResult = await configService.load("manifest.json");
  if (loadResult.ok) {
    log.info("content loaded", loadResult.counts);
  } else {
    log.error(`content load failed (${loadResult.errors.length} problem(s)):`);
    for (const e of loadResult.errors) {
      log.error(`  ${e.file} → ${e.path}: ${e.message}`);
    }
    if (redirectToOfflinePageIfNeeded()) return;
  }
  wireContentHotReload(configService);

  // --- Auth (§8 3.3): restore any existing session before the first screen shows. ---
  const authService = new AuthService();
  await authService.restore();

  // DEV convenience: skip the login screen with an instant admin session
  // (server-side dev-login route; hard-absent in production). Escape hatches
  // for testing the real auth flow: `?login=1` for one boot, or
  // `localStorage["sa.devLogin"] = "off"` until cleared.
  if (
    import.meta.env.DEV &&
    authService.getState().status !== "authed" &&
    !new URLSearchParams(window.location.search).has("login") &&
    localStorage.getItem("sa.devLogin") !== "off"
  ) {
    const ok = await authService.devLogin();
    if (ok) log.info("dev-login: authenticated as admin (use ?login=1 to test the auth screen)");
  }

  // Default renderer is WebGL2: WebGPU can black-screen with no error on some
  // GPUs (seen 2026-07: Intel UHD 630 + Chrome — device alive, frames render,
  // nothing ever presents to the canvas). Re-test WebGPU with ?renderer=webgpu.
  const rendererPref =
    new URLSearchParams(window.location.search).get("renderer") ??
    localStorage.getItem("spacearena.renderer") ??
    "webgl";
  const engine =
    rendererPref === "webgpu"
      ? ((await EngineFactory.CreateAsync(canvas, {})) as Engine)
      : new Engine(canvas, true);
  log.info("engine created", { renderer: rendererPref, cls: engine.getClassName() });

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
  // Fire-and-forget with per-model fallback to the procedural recipe.
  const preloadAssets = new AssetRegistry(scene);
  for (const ship of configService.getAll<ShipConfig>("ship")) {
    if (ship.render.model) void preloadAssets.ensureModel(ship.render);
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
    project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= 0 || height <= 0) return false;
      projectWorld.set(x, y, z);
      // Behind-camera check first: `Project` divides by w, so a point behind the
      // near plane comes back mirrored onto the screen instead of absent. Babylon
      // is left-handed by default, so view-space +z is in front of the camera.
      Vector3.TransformCoordinatesToRef(projectWorld, scene.getViewMatrix(), projectResult);
      if (projectResult.z <= 0.01) return false;
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
          const again = lastChoice ?? { kind: "practice" as const };
          endMatch();
          void startMatch(again);
        },
        onHangar: () => {
          endMatch();
          hangar.show();
        },
        onMenu: () => {
          log.info("match over — returning to lobby");
          endMatch();
          lobby.show();
        },
        onSettings: () => openSettings("match"),
      },
      { offline, flight: flightBinding },
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
    if (initial) playerFollow.position.set(initial.pos.x, 0.3, initial.pos.z);
    // Re-arm the follow rig: the Hangar's orbit mode (and the editor's) drop the
    // follow target, and 5.8 lets a player reach the Hangar straight from the
    // results screen — without this a post-Hangar match left the camera parked.
    tacticalCamera.follow(playerFollow);
    tacticalCamera.camera.target.copyFrom(playerFollow.position);
    tacticalCamera.camera.setTarget(tacticalCamera.camera.target);
    // In-match view IS the chase rig (FLIGHT.md §3). Enabled AFTER the setTarget
    // above, which recomputes alpha/beta/radius from the camera position and
    // would otherwise be undone by (and undo) the chase clamps. Seed its yaw from
    // the spawn heading so the first frame is already behind the ship.
    tacticalCamera.setChaseHeading(initial ? initial.heading : 0);
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
    runtime?.screenShake.setUserEnabled(values.cameraShake);
    runtime?.hud.setHapticsEnabled(values.haptics);
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
    tacticalCamera.setChaseMode(false);
    void authService.refreshProfile();
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
    {
      onChoose: (choice: LobbyChoice) => {
        void startMatch(choice);
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
      // The settings overlay stacks ON TOP of the lobby (z-index 40 vs 20), so
      // there is nothing to restore when it closes.
      onSettingsRequested: () => openSettings("menu"),
    },
    bus,
  );
  lobby.hide();

  const settingsScreen = new SettingsScreen(document.body, {
    configs: configService,
    audio,
    settings: userSettings,
  });

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
  );
  authScreen.hide();

  if (authService.getState().status === "authed") {
    lobby.show();
  } else {
    authScreen.show();
  }

  /** The Hangar's last-saved ship/fitting choice (ROADMAP §9 4.5), as additive NetGameSession join options. */
  function hangarJoinOptions(): { shipId?: string; fittingId?: string } {
    const sel = loadHangarSelection();
    const opts: { shipId?: string; fittingId?: string } = {};
    if (sel.shipId) opts.shipId = sel.shipId;
    if (sel.fittingId) opts.fittingId = sel.fittingId;
    return opts;
  }

  /** Arena a practice gamemode wants (its `defaultArena`), if it names one. */
  function practiceArena(gamemodeId?: string): string | undefined {
    if (!gamemodeId) return undefined;
    return configService.get<GamemodeConfig>("gamemode", gamemodeId)?.defaultArena;
  }

  async function startMatch(choice: LobbyChoice): Promise<void> {
    try {
      // Resolve the gamemode FIRST so the arena lookup sees the same id the
      // session runs — a choice without an explicit gamemode must still land
      // on gamemode.practice's defaultArena, not the fallback arena.
      const practiceMode = choice.gamemode ?? "gamemode.practice";
      const session =
        choice.kind === "practice"
          ? new GameSession(configService, practiceArena(practiceMode) ?? FALLBACK_ARENA_ID, practiceMode)
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
      // Render the arena the SESSION resolved, before the runtime (and its HUD
      // minimap) is built around it.
      setArena(session.arenaId);
      runtime = createMatchRuntime(session);
      lastChoice = choice;
      // The new runtime's shake/haptics consumers start from their own defaults —
      // push the player's settings onto them (5.8).
      applyUserSettings();
      // Fresh auto-tier sampling window: one demote/promote per match, measured
      // from here (see QualityManager.sampleFrame in the render loop).
      quality.beginMatch();
      telemetry.beginMatch();
      lobby.hide();
      hangar.hide();
    } catch (err) {
      log.error("failed to start match", err);
      lobby.showError(err instanceof Error ? err.message : "Connection failed");
    }
  }

  // --- Fixed-timestep sim loop (30 Hz), driven by render delta ---
  const tuning = configService.getAll<TuningConfig>("tuning")[0];
  const loop = new GameLoop((fixedDt) => runtime?.session.tick(fixedDt), {
    maxTicksPerStep: tuning?.maxTicksPerFrame ?? 5,
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
        const bz = pp ? pp.pos.z : pc.pos.z;
        playerFollow.position.set(bx + (pc.pos.x - bx) * alpha, 0.3, bz + (pc.pos.z - bz) * alpha);
        // Chase yaw follows the same interpolated ship the view draws. Lerped
        // the SHORT way round so a wrap past ±π never spins the camera a full
        // turn; `chase.yawLag` inside the rig does the actual smoothing.
        const base = pp ? pp.heading : pc.heading;
        tacticalCamera.setChaseHeading(base + angleDeltaTo(base, pc.heading) * alpha);
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
      runtime.viewManager.render(prev, cur, alpha, dtMs);
      runtime.hud.update(cur, prev, dtMs, engine.getFps(), alpha);
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
      suspendCameraGestures: (suspended: boolean) => {
        tacticalCamera.setGesturesSuspended(suspended);
      },
    };
    window.addEventListener("keydown", (event) => {
      if (event.key !== "F10" || event.repeat) return;
      event.preventDefault();
      void import("./editor/EditorShell.js").then(({ EditorShell }) => {
        if (!editorShell) editorShell = new EditorShell(editorHost);
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
  });
  resizeObserver.observe(canvas);
  engine.resize();

  window.addEventListener("beforeunload", () => {
    runtime?.dispose();
    audio.dispose();
    settingsScreen.dispose();
    userSettings.dispose();
    hangar.dispose();
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

bootstrap().catch((err) => {
  log.error("bootstrap failed", err);
});
