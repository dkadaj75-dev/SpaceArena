import {
  Color3,
  Color4,
  Mesh,
  ParticleSystem,
  TransformNode,
  Vector3,
  type InstancedMesh,
  type Scene,
  type AbstractMesh,
} from "@babylonjs/core";
import {
  createLogger,
  emittersOf,
  evalCurve,
  evalSignal,
  hardpointsOf,
  shieldShellUp,
  type ConfigService,
  type CosmeticConfig,
  type EffectConfig,
  type ModuleConfig,
  type ModuleSnapshot,
  type ShipConfig,
  type QualityConfig,
  type ShipSnapshot,
  type SocketTransform,
} from "@space-arena/shared";
import type { AssetRegistry } from "../core/AssetRegistry.js";
import { propulsionEffectFor } from "./shipPaint.js";
import { applyParticleParam } from "./particleParams.js";
import { getParticleTexture } from "./particleTexture.js";
import { deployProgressFor, hardpointPose } from "./juice/deployAnim.js";
import { DEFAULT_JUICE_SETTINGS, type JuiceSettings, type ViewRelation } from "./juice/juiceSettings.js";
import { ShieldBubble } from "./juice/ShieldBubble.js";
import { shieldBrokenBy } from "./juice/shieldAnim.js";

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
  /** Last applied sweep position (0..1) — the write-on-change guard. */
  curProgress: number;
}

interface EmitterAttachment {
  system: ParticleSystem;
  effect: EffectConfig;
  bindings: ReturnType<typeof emittersOf>[number]["bindings"];
  running: boolean;
}

export interface ShipEffectPolicyInput {
  isLocal: boolean;
  emitterIndex: number;
  primaryEmitterIndex: number;
  maxRemoteShipSystems?: number;
  distance: number;
  cullDistance?: number;
  inFrustum: boolean;
}

/** Pure policy shared by runtime and unit tests: local ships retain every socket. */
export function shouldBuildShipEmitter(input: ShipEffectPolicyInput): boolean {
  if (!input.inFrustum) return false;
  if (input.cullDistance && input.distance > input.cullDistance) return false;
  if (input.isLocal || !input.maxRemoteShipSystems) return true;
  return input.maxRemoteShipSystems > 0 && input.emitterIndex === input.primaryEmitterIndex;
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
  private emittersBuilt = false;
  private effectsVisible = false;
  private disposed = false;

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
    private readonly effectOptions: { isLocal?: boolean } = {},
    /**
     * The equipped skin, for its PROPULSION element. Propulsion is the one part
     * of a livery that is not a surface: it replaces the particle effect on the
     * emitter sockets `ship.skin.propulsion` wires, and leaves every other
     * emitter (damage smoke, boost plume if unwired) as authored.
     */
    private readonly cosmetic: Pick<CosmeticConfig, "elements"> | undefined = undefined,
  ) {
    this.particleQuality = particleQuality ?? DEFAULT_PARTICLE_QUALITY;
    this.juice = juice;
    this.root = new TransformNode(`socketRig.${ship.id}`, scene);
    this.root.parent = parent;
    this.buildHardpoints(fittedModuleIds);
    // Lazy inside: no mesh exists until this ship actually raises a shield.
    this.shieldBubble = new ShieldBubble(
      scene,
      this.root,
      ship.collider.radius,
      juice.shieldRipple,
      ship.id,
      // The shell's panel count rides the tier's particle budget — one dial for
      // how much decoration this machine is willing to draw.
      this.particleQuality.budgetMultiplier,
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
    // Theme kill-switch for the hardpoint meshes (placeholder-era hulls fly
    // clean). Attachments are still built — the deploy tween simply has no
    // instance to pose — so the state machine and HUD stay identical.
    const showMeshes = this.juice.deploy.showMeshes;

    hardpointsOf(this.ship).forEach((socket, i) => {
      const node = new TransformNode(`hp.${this.ship.id}.${socket.id}`, this.scene);
      node.parent = this.root;
      applySocketTransform(node, socket.transform);
      const baseScale = socket.transform.scale ?? 1;
      const moduleId = fittedModuleIds[i];
      node.scaling.setAll(baseScale);
      const mod = moduleId ? this.configs.get<ModuleConfig>("module", moduleId) : undefined;
      let instance: InstancedMesh | null = null;
      let sourceMaster: Mesh | null = null;
      if (mod && showMeshes) {
        const master = this.assets.getModuleMaster(mod, palette);
        sourceMaster = master;
        instance = master.createInstance(`hpmesh.${this.ship.id}.${socket.id}`);
        instance.isPickable = false;
        instance.parent = node;
      }

      const attachment: HardpointAttachment = {
        hardpointIndex: i,
        node,
        instance,
        lastState: null,
        curProgress: -1, // forces the first pose write
      };
      this.hardpoints.push(attachment);

      if (mod?.render?.model && showMeshes) {
        const fallback = instance;
        void this.assets.ensureModel(mod.render).then((modelMaster) => {
          if (!modelMaster || modelMaster === sourceMaster || this.disposed || attachment.instance !== fallback) return;
          const replacement = modelMaster.createInstance(`hpmesh.${this.ship.id}.${socket.id}`);
          replacement.isPickable = false;
          replacement.parent = node;
          if (fallback) {
            replacement.position.copyFrom(fallback.position);
            replacement.rotation.copyFrom(fallback.rotation);
            replacement.scaling.copyFrom(fallback.scaling);
            fallback.dispose();
          }
          attachment.instance = replacement;
        });
      }
    });
  }

  private buildEmitters(): void {
    const sockets = emittersOf(this.ship);
    let primaryEmitterIndex = sockets.findIndex((socket) => /engine|thruster/i.test(`${socket.id} ${socket.effect}`));
    if (primaryEmitterIndex < 0) primaryEmitterIndex = 0;
    for (let socketIndex = 0; socketIndex < sockets.length; socketIndex++) {
      const socket = sockets[socketIndex]!;
      if (!shouldBuildShipEmitter({
        isLocal: this.effectOptions.isLocal === true,
        emitterIndex: socketIndex,
        primaryEmitterIndex,
        maxRemoteShipSystems: this.particleQuality.maxRemoteShipSystems,
        distance: 0,
        inFrustum: true,
      })) continue;
      // A skin may swap this socket's effect for any effect in the project. An
      // override that names something unknown falls back to the authored one
      // rather than killing the emitter — a bad skin must not delete a thruster.
      const override = propulsionEffectFor(this.ship, this.cosmetic, socket.id);
      const effectId = (override && this.configs.get<EffectConfig>("effect", override)) ? override : socket.effect;
      const effect = this.configs.get<EffectConfig>("effect", effectId);
      if (!effect) {
        log.warn(`emitter socket "${socket.id}" on ${this.ship.id} references unknown effect ${effectId}`);
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

      // Dormant by construction. A live signal starts it on the first 15 Hz
      // update; zero-rate systems never enter Babylon's per-frame animation.
      this.emitters.push({ system, effect, bindings: socket.bindings, running: false });
    }
    this.emittersBuilt = true;
  }

  /**
   * Hardpoint deploy/retract animation (§10 5.7), driven by module state +
   * `stateTimer`: the turret rises out of the hull along its socket's local +Y,
   * scales up with a back-ease overshoot and unwinds a settle-spin — the visible
   * cost of the §2.3 deploy/retract tradeoff. Fully mounted (progress 1) while
   * `active` (mounted, whether or not it is between shots), gone while `retracted`.
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
      // Preserve the exact socket transform on the mount node. Deploy motion
      // is child-local visual juice and never rewrites authored socket space.
      hp.instance.scaling.setAll(pose.scale);
      hp.instance.position.y = pose.extend;
      hp.instance.rotation.y = pose.spinRad;
    }
  }

  /**
   * Shield-bubble ripple (§10 5.7). Shown while a DEPLOYED shield module holds
   * an absorb reservoir — {@link shieldShellUp}, the same condition the
   * `shieldActive` signal drives emitter bindings from, read straight off the
   * snapshot so it works identically offline and online. `dtMs` is the
   * render-frame delta driving the ripple phase.
   *
   * The state test is the point (owner 2026-08-16): a shield's reservoir is its
   * energy tank, which charges from the moment the ship spawns, so testing the
   * pool alone put a bubble around every hull that merely *carried* a shield.
   */
  updateShield(ship: ShipSnapshot, dtMs: number): void {
    // `broken` is only ever READ on the frame the shell goes down, and it is
    // what tells a flameout from a stand-down: a reservoir shot flat leaves the
    // module deployed, a pilot retracting it does not. See `shieldBrokenBy`.
    this.shieldBubble.update(
      shieldShellUp(ship) && this.effectsVisible,
      dtMs,
      shieldBrokenBy(ship.modules),
    );
  }

  /**
   * Paint this ship's shield bubble for the side it flies for (enemy = the
   * board's danger red). The rig has no view of the local player, so the
   * relation is resolved by the caller that does — see
   * {@link import("./EntityView.js").ViewManager}.
   */
  setShieldRelation(relation: ViewRelation): void {
    this.shieldBubble.setRelation(relation);
  }

  /**
   * A shield absorb landed on this ship — flash and bounce its bubble (§10 5.7).
   * The world point rides along when the event carried one, so the wobble is
   * strongest where the shot came in.
   */
  shieldImpact(worldX?: number, worldY?: number, worldZ?: number): void {
    this.shieldBubble.impact(worldX, worldY, worldZ);
  }

  /** Whether this ship's shield bubble is currently drawn (dev probe / tests). */
  get shieldVisible(): boolean {
    return this.shieldBubble.isVisible;
  }

  /** Which side this ship's bubble is painted for (dev probe / tests). */
  get shieldRelation(): ViewRelation {
    return this.shieldBubble.shownRelation;
  }

  /** Throttled (~15 Hz) signal → curve → particle-param update for every emitter socket. */
  updateEmitters(cur: ShipSnapshot, prev: ShipSnapshot | undefined, nowMs: number): void {
    if (nowMs < this.nextEmitterUpdateMs) return;
    this.nextEmitterUpdateMs = nowMs + EMITTER_UPDATE_INTERVAL_MS;

    const visible = this.effectVisibility();
    this.effectsVisible = visible;
    if (!visible) {
      for (const em of this.emitters) this.setEmitterRunning(em, false);
      return;
    }
    if (!this.emittersBuilt && this.particleQuality.enabled && this.particleQuality.budgetMultiplier > 0) {
      this.buildEmitters();
    }

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
      this.setEmitterRunning(em, em.system.emitRate > 0);
    }
  }

  private effectVisibility(): boolean {
    const camera = this.scene.activeCamera;
    if (!camera) return true;
    const parent = this.root.parent as AbstractMesh | null;
    if (!parent || typeof parent.isInFrustum !== "function") return true;
    parent.computeWorldMatrix(true);
    camera.computeWorldMatrix();
    const distance = Vector3.Distance(camera.globalPosition, parent.getAbsolutePosition());
    return shouldBuildShipEmitter({
      isLocal: this.effectOptions.isLocal === true,
      emitterIndex: 0,
      primaryEmitterIndex: 0,
      maxRemoteShipSystems: undefined,
      distance,
      cullDistance: this.particleQuality.shipEffectCullDistance,
      inFrustum: camera.isInFrustum(parent),
    });
  }

  private setEmitterRunning(em: EmitterAttachment, running: boolean): void {
    if (em.running === running) return;
    em.running = running;
    if (running) em.system.start();
    else em.system.stop();
  }

  dispose(): void {
    this.disposed = true;
    for (const hp of this.hardpoints) hp.instance?.dispose();
    this.hardpoints.length = 0;
    // The radial sprite is scene-shared (ships, dust and explosion pools all
    // receive the same DynamicTexture). Babylon disposes a ParticleSystem's
    // texture by default; disposing one rig would therefore poison every live
    // system and the WeakMap cache with a permanently unready texture.
    for (const em of this.emitters) em.system.dispose(false);
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
