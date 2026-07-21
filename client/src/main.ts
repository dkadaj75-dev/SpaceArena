import { Engine, EngineFactory, Scene, Color4 } from "@babylonjs/core";
import {
  createLogger,
  ConfigService,
  GameLoop,
  SIM_TICK_RATE,
  EventBus,
  type ConfigEvents,
} from "@space-arena/shared";
import { wireContentHotReload } from "./core/contentHotReload.js";
import { SceneBuilder } from "./core/SceneBuilder.js";
import { TacticalCamera } from "./game/TacticalCamera.js";

const log = createLogger("Client");

/** Dev content is served by the Vite plugin at /content/* (see vite.config.ts). */
async function fetchLoader(relPath: string): Promise<unknown> {
  const res = await fetch(`/content/${relPath}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
  return res.json();
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error("#renderCanvas not found");
  }

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

  // WebGPU with automatic WebGL2 fallback (Phase 0 renderer note).
  const engine = (await EngineFactory.CreateAsync(canvas, {})) as Engine;
  log.info("engine created", { webgpu: engine.getClassName() === "WebGPUEngine" });

  // Cap device pixel ratio at 2 — perf guardrail from day 1 (Phase 0 constraint).
  engine.adaptToDeviceRatio = true;
  const cappedDpr = Math.min(window.devicePixelRatio || 1, 2);
  engine.setHardwareScalingLevel(1 / cappedDpr);

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);

  // --- Arena + camera (0.6/0.7/0.8) ---
  const sceneBuilder = new SceneBuilder(scene, configService, bus);
  sceneBuilder.buildArena("arena.ring-nebula");

  const tacticalCamera = new TacticalCamera(scene, canvas, configService, bus);

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>)["__debug"] = { scene, engine, sceneBuilder, tacticalCamera };
  }
  if (sceneBuilder.shipNode) {
    tacticalCamera.follow(sceneBuilder.shipNode);
    tacticalCamera.camera.target.copyFrom(sceneBuilder.shipNode.position);
  }
  tacticalCamera.camera.setTarget(tacticalCamera.camera.target);

  // --- Fixed-timestep sim loop (30 Hz), driven by render delta ---
  let lastLoggedSecond = -1;
  const loop = new GameLoop((_fixedDt, tickNumber) => {
    // Placeholder Phase 0 tick: log once per simulated second.
    const second = Math.floor(tickNumber / SIM_TICK_RATE);
    if (second !== lastLoggedSecond) {
      lastLoggedSecond = second;
      log.debug(`sim tick ${tickNumber} (t=${second}s)`);
    }
  });

  engine.runRenderLoop(() => {
    const dtMs = engine.getDeltaTime();
    loop.step(dtMs);
    tacticalCamera.update(dtMs / 1000);
    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });

  window.addEventListener("beforeunload", () => {
    sceneBuilder.dispose();
    tacticalCamera.dispose();
  });

  setupFpsCounter(engine);
}

function setupFpsCounter(engine: Engine): void {
  const el = document.getElementById("fpsCounter");
  if (!el) return;

  // Update ~2x/sec instead of per frame to avoid needless DOM churn.
  const intervalMs = 500;
  setInterval(() => {
    el.textContent = `FPS: ${engine.getFps().toFixed(0)}`;
  }, intervalMs);
}

bootstrap().catch((err) => {
  log.error("bootstrap failed", err);
});
