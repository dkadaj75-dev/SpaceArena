import { Engine, EngineFactory, Scene, Color4, TransformNode } from "@babylonjs/core";
import {
  createLogger,
  ConfigService,
  GameLoop,
  EventBus,
  type ConfigEvents,
  type TuningConfig,
  type ShipSnapshot,
  type EntityId,
} from "@space-arena/shared";
import { wireContentHotReload } from "./core/contentHotReload.js";
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

  // WebGPU with automatic WebGL2 fallback (Phase 0 renderer note).
  const engine = (await EngineFactory.CreateAsync(canvas, {})) as Engine;
  log.info("engine created", { webgpu: engine.getClassName() === "WebGPUEngine" });

  // Cap device pixel ratio at 2 — perf guardrail from day 1 (Phase 0 constraint).
  engine.adaptToDeviceRatio = true;
  const cappedDpr = Math.min(window.devicePixelRatio || 1, 2);
  engine.setHardwareScalingLevel(1 / cappedDpr);

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);

  // --- Static arena (0.6/0.7/0.8): bounds/skybox/ground/lighting/spawns only ---
  const sceneBuilder = new SceneBuilder(scene, configService, bus);
  sceneBuilder.buildArena("arena.ring-nebula");

  const tacticalCamera = new TacticalCamera(scene, canvas, configService, bus);

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
      dispose(): void {
        orderInput.dispose();
        orderMarkers.dispose();
        viewManager.dispose();
        hud.dispose();
        netOverlay?.dispose();
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

  async function startMatch(choice: LobbyChoice): Promise<void> {
    try {
      const session =
        choice.kind === "practice"
          ? new GameSession(configService, "arena.ring-nebula", "gamemode.practice")
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

  window.addEventListener("resize", () => {
    engine.resize();
  });

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
