import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  ParticleSystem,
  TransformNode,
  Vector3,
  type InstancedMesh,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import {
  createLogger,
  emittersOf,
  evalCurve,
  evalSignal,
  hardpointsOf,
  type ConfigService,
  type EffectConfig,
  type ModuleConfig,
  type ModuleSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type SocketTransform,
} from "@space-arena/shared";
import type { AssetRegistry } from "../core/AssetRegistry.js";
import { applyParticleParam } from "./particleParams.js";

const log = createLogger("ShipSocketRig");

/** Emitter param updates are throttled to this rate per ship — cheap signal-eval,
 * but no reason to run it every render frame (ROADMAP §9 4.6 socket rendering). */
const EMITTER_UPDATE_HZ = 15;
const EMITTER_UPDATE_INTERVAL_MS = 1000 / EMITTER_UPDATE_HZ;

/**
 * Per-emitter particle budget ceiling. Content `effect.base.capacity` values
 * (120-200) are authored per-effect in isolation; a live match can have many
 * ships × several emitter sockets each, so each system's *actual* Babylon
 * capacity is capped here regardless of what the config asks for. At the
 * default cap, a worst-case 8-ship match with 4 emitters/ship tops out at
 * 8 × 4 × 80 = 2560 resident CPU particles, and `emitRate` is usually 0 or
 * near-0 (idle throttle) so live counts stay far below that in practice.
 */
const MAX_EMITTER_CAPACITY = 80;

function applySocketTransform(node: TransformNode, t: SocketTransform): void {
  node.position.set(t.pos[0], t.pos[1], t.pos[2]);
  if (t.rot) node.rotation.set(t.rot[0], t.rot[1], t.rot[2]);
  if (t.scale) node.scaling.setAll(t.scale);
}

function hexToColor4(hex: string): Color4 {
  try {
    const c = Color3.FromHexString(hex);
    return new Color4(c.r, c.g, c.b, 1);
  } catch {
    return new Color4(1, 1, 1, 1);
  }
}

// One soft radial-gradient texture shared by every particle system in the app
// (no external asset — generated once, reused for the life of the scene).
let sharedParticleTexture: Texture | null = null;
function getParticleTexture(scene: Scene): Texture {
  if (sharedParticleTexture) return sharedParticleTexture;
  const size = 32;
  const tex = new DynamicTexture("tex.particle.soft", size, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.5)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  tex.update(false);
  tex.hasAlpha = true;
  sharedParticleTexture = tex;
  return tex;
}

interface HardpointAttachment {
  hardpointIndex: number;
  node: TransformNode;
  instance: InstancedMesh | null;
  lastState: string | null;
  curScale: number;
}

interface EmitterAttachment {
  system: ParticleSystem;
  effect: EffectConfig;
  bindings: ReturnType<typeof emittersOf>[number]["bindings"];
}

/**
 * ROADMAP §9 4.6 — attaches a ship's socket graph (hardpoint module meshes +
 * emitter particle systems) to a Babylon node, and keeps both in sync with a
 * running sim (module deploy/retract tween, signal-driven particle params).
 *
 * One instance per ship view. Shared between {@link import("./EntityView.js").ViewManager}
 * (live combat ships) and the Hangar preview (a single staged ship) so the two
 * never duplicate socket-attachment logic. Callers cache the instance per
 * entity/preview on first sight — this class does no caching of its own.
 */
export class ShipSocketRig {
  private readonly root: TransformNode;
  private readonly hardpoints: HardpointAttachment[] = [];
  private readonly emitters: EmitterAttachment[] = [];
  private nextEmitterUpdateMs = 0;

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly assets: AssetRegistry,
    private readonly ship: ShipConfig,
    parent: TransformNode | InstancedMesh,
    fittedModuleIds: readonly (string | null | undefined)[],
  ) {
    this.root = new TransformNode(`socketRig.${ship.id}`, scene);
    this.root.parent = parent;
    this.buildHardpoints(fittedModuleIds);
    this.buildEmitters();
  }

  private buildHardpoints(fittedModuleIds: readonly (string | null | undefined)[]): void {
    const accent = this.ship.render.palette?.accent ?? this.ship.render.palette?.primary;
    const palette: Record<string, string> = accent ? { primary: accent } : {};

    hardpointsOf(this.ship).forEach((socket, i) => {
      const node = new TransformNode(`hp.${this.ship.id}.${socket.id}`, this.scene);
      node.parent = this.root;
      applySocketTransform(node, socket.transform);
      node.scaling.setAll(0); // starts hidden — modules begin retracted

      const moduleId = fittedModuleIds[i];
      const mod = moduleId ? this.configs.get<ModuleConfig>("module", moduleId) : undefined;
      let instance: InstancedMesh | null = null;
      if (mod) {
        const master = this.assets.getMesh(`procedural.module.${mod.family}`, palette);
        instance = master.createInstance(`hpmesh.${this.ship.id}.${socket.id}`);
        instance.isPickable = false;
        instance.parent = node;
      }

      this.hardpoints.push({ hardpointIndex: i, node, instance, lastState: null, curScale: 0 });
    });
  }

  private buildEmitters(): void {
    for (const socket of emittersOf(this.ship)) {
      const effect = this.configs.get<EffectConfig>("effect", socket.effect);
      if (!effect) {
        log.warn(`emitter socket "${socket.id}" on ${this.ship.id} references unknown effect ${socket.effect}`);
        continue;
      }

      // A geometry-less Mesh (not TransformNode) — Babylon's ParticleSystem.emitter
      // only accepts an AbstractMesh or a Vector3, not a plain TransformNode.
      const anchor = new Mesh(`em.${this.ship.id}.${socket.id}`, this.scene);
      anchor.isPickable = false;
      anchor.isVisible = false;
      anchor.parent = this.root;
      applySocketTransform(anchor, socket.transform);

      const capacity = Math.min(effect.base.capacity, MAX_EMITTER_CAPACITY);
      const system = new ParticleSystem(`fx.${this.ship.id}.${socket.id}`, capacity, this.scene);
      system.particleTexture = getParticleTexture(this.scene);
      system.emitter = anchor;
      system.minEmitBox = Vector3.Zero();
      system.maxEmitBox = Vector3.Zero();
      system.color1 = hexToColor4(effect.base.color1);
      system.color2 = hexToColor4(effect.base.color2);
      system.colorDead = new Color4(0, 0, 0, 0);
      system.minLifeTime = effect.base.lifeMin;
      system.maxLifeTime = effect.base.lifeMax;
      system.minSize = effect.base.sizeMin;
      system.maxSize = effect.base.sizeMax;
      system.minEmitPower = effect.base.speedMin;
      system.maxEmitPower = effect.base.speedMax;
      system.emitRate = effect.base.emitRate;
      system.gravity = new Vector3(0, effect.base.gravity ?? 0, 0);
      const dir = effect.base.direction ?? [0, 0, -1];
      system.direction1 = new Vector3(dir[0], dir[1], dir[2]);
      system.direction2 = new Vector3(dir[0], dir[1], dir[2]);
      system.blendMode = ParticleSystem.BLENDMODE_ADD;
      system.disposeOnStop = false;
      system.start();

      this.emitters.push({ system, effect, bindings: socket.bindings });
    }
  }

  /**
   * Hardpoint scale-in/out tween, driven by module state + `stateTimer`
   * fraction. Visible (scale 1) while `active`/`overheated` (still mounted,
   * just can't fire); scales toward/away from 1 across `deploying`/`retracting`;
   * hidden (scale 0) while `retracted`. Cheap — runs every render frame.
   */
  updateModules(modules: readonly ModuleSnapshot[]): void {
    for (const hp of this.hardpoints) {
      if (!hp.instance) continue;
      // Keyed by hardpointIndex, not array position — `modules` is sparse-safe
      // (see spawn.ts): a fitting like {0: laser, 2: shield} only has 2 array
      // entries whose own hardpointIndex fields are 0 and 2, so `modules[2]`
      // would be undefined even though hardpoint 2 IS fitted.
      const m = modules.find((mm) => mm.hardpointIndex === hp.hardpointIndex);
      if (!m) continue;

      let target: number;
      const cfg = this.configs.get<ModuleConfig>("module", m.moduleId);
      switch (m.state) {
        case "active":
        case "overheated":
          target = 1;
          break;
        case "deploying":
          target =
            cfg && cfg.activation.deployTime > 0
              ? clamp01(1 - m.stateTimer / cfg.activation.deployTime)
              : 1;
          break;
        case "retracting":
          target =
            cfg && cfg.activation.retractTime > 0 ? clamp01(m.stateTimer / cfg.activation.retractTime) : 0;
          break;
        case "retracted":
        default:
          target = 0;
          break;
      }

      if (target !== hp.curScale) {
        hp.curScale = target;
        hp.node.scaling.setAll(target);
      }
    }
  }

  /** Throttled (~15 Hz) signal → curve → particle-param update for every emitter socket. */
  updateEmitters(cur: ShipSnapshot, prev: ShipSnapshot | undefined, nowMs: number): void {
    if (this.emitters.length === 0) return;
    if (nowMs < this.nextEmitterUpdateMs) return;
    this.nextEmitterUpdateMs = nowMs + EMITTER_UPDATE_INTERVAL_MS;

    for (const em of this.emitters) {
      for (const binding of em.bindings) {
        const signalValue = evalSignal(binding.source, cur, prev);
        const mapped = evalCurve(binding.curve, signalValue);
        applyParticleParam(em.system, em.effect.base, binding.param, mapped, (msg) =>
          log.warn(`${em.system.name}: ${msg}`),
        );
      }
    }
  }

  dispose(): void {
    for (const hp of this.hardpoints) hp.instance?.dispose();
    this.hardpoints.length = 0;
    for (const em of this.emitters) em.system.dispose();
    this.emitters.length = 0;
    this.root.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
