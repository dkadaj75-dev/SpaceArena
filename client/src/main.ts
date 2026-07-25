import { Engine, EngineFactory, Scene, Color4, TransformNode } from "@babylonjs/core";
import {
  createLogger,
  ConfigService,
  GameLoop,
  EventBus,
  type ArenaConfig,
  type ConfigEvents,
  type GamemodeConfig,
  type ShipConfig,
  type TuningConfig,
  type ShipSnapshot,
  type EntityId,
} from "@space-arena/shared";
import { wireContentHotReload } from "./core/contentHotReload.js";
import { AssetRegistry } from "./core/AssetRegistry.js";
import { SceneBuilder } from "./core/SceneBuilder.js";
import { AuthService } from "./core/AuthService.js";
import { TacticalCamera } from "./game/TacticalCamera.js";
import { GameSession } from "./game/GameSession.js";
import { ViewManager } from "./game/EntityView.js";
import { OrderInput } from "./game/OrderInput.js";
import { OrderMarkers } from "./game/OrderMarkers.js";
import { Hud } from "./game/hud/Hud.js";
import { Lobby, type LobbyChoice } from "./game/screens/Lobby.js";
import { AuthScreen } from "./game/screens/AuthScreen.js";
import { Hangar, loadHangarSelection } from "./game/screens/Hangar.js";
import { NetGameSession } from "./net/NetGameSession.js";
import { NetDebugOverlay } from "./net/NetDebugOverlay.js";
import { BotDebugOverlay } from "./game/BotDebugOverlay.js";

const log = createLogger("Client");

/** Dev content is served by the Vite plugin at /content/* (see vite.config.ts). */
async function fetchLoader(relPath: string): Promise<unknown> {
  const res = await fetch(`/content/${relPath}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
  return res.json();
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
  orderInput: OrderInput;
  orderMarkers: OrderMarkers;
  hud: Hud;
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

  // Cap device pixel ratio at 2 — perf guardrail from day 1 (Phase 0 constraint).
  engine.adaptToDeviceRatio = true;
  const cappedDpr = Math.min(window.devicePixelRatio || 1, 2);
  engine.setHardwareScalingLevel(1 / cappedDpr);

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);

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
  const sceneBuilder = new SceneBuilder(scene, configService, bus);
  sceneBuilder.buildArena("arena.ring-nebula");

  const tacticalCamera = new TacticalCamera(scene, canvas, configService, bus);

  // Pan clamp follows the arena's playable bounds (re-applied on arena rebuild).
  const applyArenaPanBounds = (): void => {
    const bounds = configService.get<ArenaConfig>("arena", "arena.ring-nebula")?.bounds;
    tacticalCamera.setPanBounds(
      bounds?.shape === "circle" ? bounds.radius : bounds ? Math.hypot(bounds.width, bounds.height) / 2 : 90,
    );
  };
  applyArenaPanBounds();

  // Camera follows a lightweight node tracking the (moving) player ship
  // position. Persists across "Play again" resets — only its target position
  // is re-snapped.
  const playerFollow = new TransformNode("playerFollow", scene);
  tacticalCamera.follow(playerFollow);

  function createMatchRuntime(session: GameSession): MatchRuntime {
    const viewManager = new ViewManager(scene, configService, (id) => session.shipConfigIdFor(id));
    const orderInput = new OrderInput(scene, configService, session);
    const orderMarkers = new OrderMarkers(scene, session.playerId);
    const hud = new Hud(hudRoot, configService, bus, session, session.playerId, () => {
      log.info("match over — returning to lobby");
      runtime?.dispose();
      runtime = null;
      // Credits/xp/level may have changed server-side (matchRewards) — refresh
      // the profile so the Lobby header reflects it. Fire-and-forget: the
      // header updates via AuthService.onChange whenever this resolves.
      void authService.refreshProfile();
      lobby.show();
    });

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
    tacticalCamera.camera.target.copyFrom(playerFollow.position);
    tacticalCamera.camera.setTarget(tacticalCamera.camera.target);

    return {
      session,
      viewManager,
      orderInput,
      orderMarkers,
      hud,
      netOverlay,
      botOverlay,
      dispose(): void {
        orderInput.dispose();
        orderMarkers.dispose();
        viewManager.dispose();
        hud.dispose();
        netOverlay?.dispose();
        botOverlay?.dispose();
        if (session instanceof NetGameSession) session.dispose();
      },
    };
  }

  let runtime: MatchRuntime | null = null;
  let simPaused = false;

  const lobby = new Lobby(
    document.body,
    configService,
    authService,
    (choice: LobbyChoice) => {
      void startMatch(choice);
    },
    () => {
      // Log out: drop the session and fall back to the auth gate.
      authService.logout();
      lobby.hide();
      authScreen.show();
    },
    (tab) => {
      lobby.hide();
      authScreen.show();
      if (tab === "register") authScreen.showRegisterTab();
      else authScreen.showLoginTab();
    },
    () => {
      lobby.hide();
      hangar.show();
    },
  );
  lobby.hide();

  const hangar = new Hangar(document.body, scene, configService, authService, tacticalCamera, () => {
    hangar.hide();
    lobby.show();
  });

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
      const session =
        choice.kind === "practice"
          ? new GameSession(
              configService,
              practiceArena(choice.gamemode) ?? "arena.ring-nebula",
              choice.gamemode ?? "gamemode.practice",
            )
          : await NetGameSession.join(configService, {
              gamemode: choice.gamemode,
              ...hangarJoinOptions(),
              ...choice.options,
              token: authService.getAccessToken() ?? undefined,
            });
      runtime = createMatchRuntime(session);
      lobby.hide();
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
      }

      // Consume this frame's sim events, then render dynamic views + markers + HUD.
      const events = runtime.session.drainFrameEvents();
      runtime.viewManager.consumeEvents(events, cur);
      runtime.orderMarkers.consumeEvents(events);
      runtime.hud.consumeEvents(events);
      runtime.session.clearFrameEvents();

      runtime.viewManager.render(prev, cur, alpha, dtMs);
      runtime.orderMarkers.render(cur, dtMs);
      runtime.hud.update(cur, prev, dtMs, engine.getFps());
      runtime.netOverlay?.update();
      runtime.botOverlay?.update();
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
        simPaused = true;
        tacticalCamera.setEditorMode(true);
      },
      resumeSim: () => {
        simPaused = false;
        tacticalCamera.setEditorMode(false);
        tacticalCamera.follow(playerFollow);
      },
      rebuildArena: () => {
        sceneBuilder.buildArena("arena.ring-nebula");
        applyArenaPanBounds();
      },
      // The editor takes over the canvas: the live match (HUD, entity views,
      // order markers) is hidden and gameplay taps are gated off, so nothing of
      // the running game shows through or reacts behind the editor's own stage.
      // `runtime` is null on the menu screens — nothing to hide then.
      setGameVisible: (visible: boolean) => {
        hudRoot.style.display = visible ? "" : "none";
        // Menu/auth/hangar screens are body-level overlays — hide them too or
        // they float over the editor viewport (editor.css targets this class).
        document.body.classList.toggle("sa-editor-open", !visible);
        runtime?.viewManager.setVisible(visible);
        runtime?.orderMarkers.setVisible(visible);
        runtime?.botOverlay?.setSuppressed(!visible);
        runtime?.orderInput.setEnabled(visible);
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
    engine.resize();
  });
  resizeObserver.observe(canvas);
  engine.resize();

  window.addEventListener("beforeunload", () => {
    runtime?.dispose();
    hangar.dispose();
    sceneBuilder.dispose();
    tacticalCamera.dispose();
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
