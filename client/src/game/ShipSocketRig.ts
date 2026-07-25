import {
  Color3,
  Color4,
  Mesh,
  ParticleSystem,
  TransformNode,
  Vector3,
  type InstancedMesh,
  type Scene,
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
  type QualityConfig,
  type ShipSnapshot,
  type SocketTransform,
} from "@space-arena/shared";
import type { AssetRegistry } from "../core/AssetRegistry.js";
import { applyParticleParam } from "./particleParams.js";
import { getParticleTexture } from "./particleTexture.js";
import { deployProgressFor, hardpointPose } from "./juice/deployAnim.js";
import { DEFAULT_JUICE_SETTINGS, type JuiceSettings } from "./juice/juiceSettings.js";
import { ShieldBubble } from "./juice/ShieldBubble.js";

const log = createLogger("ShipSocketRig");

/** Emitter param updates are throttled to this rate per ship — cheap signal-eval,
 * but no reason to run it every render frame (ROADMAP §9 4.6 socket rendering). */
const EMITTER_UPDATE_HZ = 15;
const EMITTER_UPDATE_INTERVAL_MS = 1000 / EMITTER_UPDATE_HZ;

/**
 * Per-emitter particle budget, from the active quality tier (§10 5.6).
 *
 * Content `effect.base.capacity` values (120-200) are authored per-effect in
 * isolation; a live match can have many ships × several emitter sockets each,
 * so each system's *actual* Babylon capacity is capped here regardless of what
 * the config asks for. At the high-tier cap, a worst-case 8-ship match with 4
 * emitters/ship tops out at 8 × 4 × 80 = 2560 resident CPU particles, and
 * `emitRate` is usually 0 or near-0 (idle throttle) so live counts stay far
 * below that in practice. Lower tiers scale both the cap and the emit rate.
 *
 * Measured: particle systems accounted for ~6 of 47 draw calls on the practice
 * arena, plus a per-frame `defines.join()` inside Babylon's
 * `ParticleSystem._getWrapper` for every system every frame — fewer/smaller
 * systems is both a draw-call and an allocation win.
 */
export type ParticleQuality = QualityConfig["particles"];

const DEFAULT_PARTICLE_QUALITY: ParticleQuality = {
  enabled: true,
  budgetMultiplier: 1,
  maxEmitterCapacity: 80,
};

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

interface HardpointAttachment {
  hardpointIndex: number;
  node: TransformNode;
  instance: InstancedMesh | null;
  lastState: string | null;
  /** Socket-authored rest pose, kept so the deploy sweep offsets from it. */
  baseY: number;
  baseRotY: number;
  baseScale: number;
  /** Last applied sweep position (0..1) — the write-on-change guard. */
  curProgress: number;
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
  private readonly particleQuality: ParticleQuality;
  private juice: JuiceSettings;
  private readonly shieldBubble: ShieldBubble;
  private nextEmitterUpdateMs = 0;

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly assets: AssetRegistry,
    private readonly ship: ShipConfig,
    parent: TransformNode | InstancedMesh,
    fittedModuleIds: readonly (string | null | undefined)[],
    particleQuality: ParticleQuality | undefined = DEFAULT_PARTICLE_QUALITY,
    /** Deploy-sweep + shield-ripple knobs (theme `juice` block, §10 5.7). */
    juice: JuiceSettings = DEFAULT_JUICE_SETTINGS,
  ) {
    this.particleQuality = particleQuality ?? DEFAULT_PARTICLE_QUALITY;
    this.juice = juice;
    this.root = new TransformNode(`socketRig.${ship.id}`, scene);
    this.root.parent = parent;
    this.buildHardpoints(fittedModuleIds);
    if (this.particleQuality.enabled && this.particleQuality.budgetMultiplier > 0) this.buildEmitters();
    // Lazy inside: no mesh exists until this ship actually raises a shield.
    this.shieldBubble = new ShieldBubble(
      scene,
      this.root,
      ship.collider.radius,
      juice.shieldRipple,
      ship.id,
    );
  }

  /** Re-apply juice knobs after a theme hot-reload. */
  setJuice(juice: JuiceSettings): void {
    this.juice = juice;
    this.shieldBubble.setSettings(juice.shieldRipple);
  }

  private buildHardpoints(fittedModuleIds: readonly (string | null | undefined)[]): void {
    const accent = this.ship.render.palette?.accent ?? this.ship.render.palette?.primary;
    const palette: Record<string, string> = accent ? { primary: accent } : {};

    hardpointsOf(this.ship).forEach((socket, i) => {
      const node = new TransformNode(`hp.${this.ship.id}.${socket.id}`, this.scene);
      node.parent = this.root;
      applySocketTransform(node, socket.transform);
      const baseScale = socket.transform.scale ?? 1;
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

      this.hardpoints.push({
        hardpointIndex: i,
        node,
        instance,
        lastState: null,
        baseY: node.position.y,
        baseRotY: node.rotation.y,
        baseScale,
        curProgress: -1, // forces the first pose write
      });
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

      // Tier budget: cap first (absolute ceiling), then scale. At least one
      // particle so a live emitter never becomes a zero-capacity no-op.
      const budget = this.particleQuality;
      const capacity = Math.max(
        1,
        Math.round(Math.min(effect.base.capacity, budget.maxEmitterCapacity) * budget.budgetMultiplier),
      );
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
      system.emitRate = effect.base.emitRate * budget.budgetMultiplier;
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
   * Hardpoint deploy/retract animation (§10 5.7), driven by module state +
   * `stateTimer`: the turret rises out of the hull along its socket's local +Y,
   * scales up with a back-ease overshoot and unwinds a settle-spin — the visible
   * cost of the §2.3 deploy/retract tradeoff. Fully mounted (progress 1) while
   * `active`/`overheated` (still there, just can't fire), gone while `retracted`.
   *
   * Cheap — runs every render frame, but only touches Babylon transforms when
   * the sweep position actually changed. All shaping comes from the theme's
   * `juice.deploy` block; all timing from the module config.
   */
  updateModules(modules: readonly ModuleSnapshot[]): void {
    for (const hp of this.hardpoints) {
      if (!hp.instance) continue;
      // Keyed by hardpointIndex, not array position — `modules` is sparse-safe
      // (see spawn.ts): a fitting like {0: laser, 2: shield} only has 2 array
      // entries whose own hardpointIndex fields are 0 and 2, so `modules[2]`
      // would be undefined even though hardpoint 2 IS fitted.
      const m = moduleAt(modules, hp.hardpointIndex);
      if (!m) continue;

      const cfg = this.configs.get<ModuleConfig>("module", m.moduleId);
      const progress = deployProgressFor(m, cfg);
      if (progress === hp.curProgress) continue;
      hp.curProgress = progress;
      const pose = hardpointPose(progress, this.juice.deploy);
      hp.node.scaling.setAll(pose.scale * hp.baseScale);
      hp.node.position.y = hp.baseY + pose.extend;
      hp.node.rotation.y = hp.baseRotY + pose.spinRad;
    }
  }

  /**
   * Shield-bubble ripple (§10 5.7). Shown while ANY fitted shield module holds
   * an absorb reservoir — the same `shieldActive` condition emitter bindings
   * use, read straight off the snapshot so it works identically offline and
   * online. `dtMs` is the render-frame delta driving the ripple phase.
   */
  updateShield(ship: ShipSnapshot, dtMs: number): void {
    let shieldUp = false;
    for (let i = 0; i < ship.modules.length; i++) {
      if (ship.modules[i]!.shieldPool > 0) {
        shieldUp = true;
        break;
      }
    }
    this.shieldBubble.update(shieldUp, dtMs);
  }

  /** Whether this ship's shield bubble is currently drawn (dev probe / tests). */
  get shieldVisible(): boolean {
    return this.shieldBubble.isVisible;
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
        // The tier budget also throttles *live* signal-driven emit rates, or a
        // low-tier ship would ramp straight back to full rate under boost.
        const scaled =
          binding.param === "emitRate" ? mapped * this.particleQuality.budgetMultiplier : mapped;
        applyParticleParam(em.system, em.effect.base, binding.param, scaled, (msg) =>
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
    this.shieldBubble.dispose();
    this.root.dispose();
  }
}

/**
 * Module snapshot for a hardpoint index. An indexed scan, not `Array.find` —
 * this runs once per hardpoint per ship per render frame, and the callback
 * would be a fresh closure every time.
 */
function moduleAt(modules: readonly ModuleSnapshot[], hardpointIndex: number): ModuleSnapshot | undefined {
  for (let i = 0; i < modules.length; i++) {
    if (modules[i]!.hardpointIndex === hardpointIndex) return modules[i];
  }
  return undefined;
}
