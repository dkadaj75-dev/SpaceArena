import { Color4, ParticleSystem, Vector3, type Scene } from "@babylonjs/core";
import type { QualityConfig } from "@space-arena/shared";
import { getParticleTexture } from "../game/particleTexture.js";

/** The authored `quality.scene.dust` block, or `undefined` on an older pack. */
export type DustQuality = QualityConfig["scene"]["dust"];

/**
 * Fully-resolved dust parameters. Everything the Babylon system needs, with the
 * derived numbers (lifetime band, emit rate, half-extent) computed ONCE here
 * rather than inline at build time — that is what makes the whole policy
 * testable without a scene.
 */
export interface DustParams {
  count: number;
  size: number;
  alpha: number;
  driftSpeed: number;
  /** Half the recycling box's edge length; the emit box is ±this on each axis. */
  halfExtent: number;
  minLifeTime: number;
  maxLifeTime: number;
  /** Particles spawned per second to hold `count` alive in steady state. */
  emitRate: number;
}

/**
 * Applied when a pack predates `quality.scene.dust`. Mirrors the shipped med
 * tier: visible, cheap, and never the reason a device drops a frame.
 */
export const DEFAULT_DUST: NonNullable<DustQuality> = {
  count: 180,
  size: 0.35,
  alpha: 0.3,
  driftSpeed: 0.8,
  boxSize: 120,
};

/**
 * Particle lifetime is DERIVED from the box, not authored: a mote must live
 * roughly as long as it takes the player to cross the box, or the field either
 * churns visibly (too short — motes winking out in front of the nose) or leaves
 * a wake of particles the recycling box has long since left behind (too long).
 * At the shipped 120-unit box and ~30 u/s nominal speed this is a 3-6 s band,
 * which is one box-crossing either side.
 */
const LIFETIME_MIN_DIVISOR = 40;
const LIFETIME_MAX_DIVISOR = 20;

/**
 * Resolve an authored tier's dust block into renderer parameters, or `null` when
 * the tier disables dust (`count: 0`, which is the shipped low tier — see the
 * schema for why the cheapest tier pays nothing for pure overdraw).
 */
export function resolveDustParams(dust: DustQuality): DustParams | null {
  const authored = dust ?? DEFAULT_DUST;
  const count = Math.floor(authored.count);
  if (!Number.isFinite(count) || count <= 0) return null;
  const boxSize = authored.boxSize > 0 ? authored.boxSize : DEFAULT_DUST.boxSize;
  const minLifeTime = boxSize / LIFETIME_MIN_DIVISOR;
  const maxLifeTime = boxSize / LIFETIME_MAX_DIVISOR;
  return {
    count,
    size: authored.size,
    alpha: Math.min(1, Math.max(0, authored.alpha)),
    driftSpeed: Math.max(0, authored.driftSpeed),
    halfExtent: boxSize / 2,
    minLifeTime,
    maxLifeTime,
    // Steady-state population = emitRate × mean lifetime, so invert that for the
    // authored count instead of asking content to reason about it.
    emitRate: count / ((minLifeTime + maxLifeTime) / 2),
  };
}

/**
 * Ambient dust motes filling the arena volume so a 300-radius bubble does not
 * read as an empty black room, and so the ship's own speed is legible against
 * something that moves past it.
 *
 * The whole volume is never filled. One `ParticleSystem` emits inside a box that
 * FOLLOWS THE PLAYER ({@link setCenter}, driven from the same per-frame hook the
 * boundary shield uses): particles are emitted in WORLD space — `isLocal` stays
 * false deliberately — so they stay put while the ship flies past them, which is
 * where the sense of speed comes from, and they expire naturally about one
 * box-crossing after the box has moved on. Cost is therefore a function of the
 * box, not of the arena: `count` particles and one draw call whatever the radius.
 */
export class DustField {
  /**
   * The recycling box's centre. A bare `Vector3` rather than a `TransformNode`:
   * `ParticleSystem.emitter` accepts either a mesh or a point, and a point is
   * both cheaper (no transform node in the scene graph) and mutable in place,
   * which is what keeps {@link setCenter} allocation-free on the render path.
   */
  private readonly center = new Vector3();
  private readonly system: ParticleSystem;
  private readonly halfExtent: number;
  private readonly floorY: number | undefined;
  private enabled = true;

  constructor(scene: Scene, params: DustParams, floorY?: number) {
    const system = new ParticleSystem("arenaDust", params.count, scene);
    this.system = system;
    this.halfExtent = params.halfExtent;
    this.floorY = floorY;
    // The shared soft sprite is drawn into a `DynamicTexture`, which needs a real
    // 2D canvas context — absent under Babylon's NullEngine (headless tests, any
    // future server-side scene). Dust is decoration: an untextured system is a
    // fine degradation, and losing the whole arena build over it is not.
    try {
      system.particleTexture = getParticleTexture(scene);
    } catch {
      system.particleTexture = null;
    }
    system.emitter = this.center;
    system.minEmitBox = new Vector3(-params.halfExtent, -params.halfExtent, -params.halfExtent);
    system.maxEmitBox = new Vector3(params.halfExtent, params.halfExtent, params.halfExtent);

    // Additive, faintly cool-white: motes catching starlight, never lit geometry.
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    system.color1 = new Color4(0.72, 0.8, 1, params.alpha);
    system.color2 = new Color4(0.9, 0.92, 1, params.alpha * 0.6);
    system.colorDead = new Color4(0.7, 0.78, 1, 0);
    system.minSize = params.size * 0.6;
    system.maxSize = params.size;
    system.minLifeTime = params.minLifeTime;
    system.maxLifeTime = params.maxLifeTime;
    system.emitRate = params.emitRate;

    // Slow isotropic drift. Direction bounds are unit-cube corners scaled by the
    // authored speed, so `driftSpeed: 0` gives motionless motes rather than a
    // degenerate emit power.
    const d = params.driftSpeed;
    system.direction1 = new Vector3(-d, -d, -d);
    system.direction2 = new Vector3(d, d, d);
    system.minEmitPower = 0;
    system.maxEmitPower = 1;
    system.gravity = Vector3.Zero();
    system.updateSpeed = 0.016;

    // Pre-warm so the box is already full on the first frame of a match instead
    // of filling in over a whole particle lifetime while the player watches.
    system.preWarmCycles = Math.ceil(params.maxLifeTime / system.updateSpeed);
    system.preWarmStepOffset = 1;

    system.start();
  }

  /**
   * Re-centre the recycling box, normally on the player/camera follow point.
   * Allocation-free: mutates the emitter point in place.
   */
  setCenter(x: number, y: number, z: number): void {
    this.center.set(x, y, z);
    // Emit-box coordinates are relative to the world-space centre. Keep newly
    // recycled motes on/above visible terrain instead of beneath the floor.
    this.system.minEmitBox.y =
      this.floorY === undefined ? -this.halfExtent : Math.max(-this.halfExtent, this.floorY - y);
  }

  /**
   * Follow the arena's visibility. A `ParticleSystem` renders from
   * `scene.particleSystems`, NOT from its emitter node's enabled flag, so hiding
   * the arena root is not enough — the dev editor would otherwise stage a ship
   * inside a drifting dust cloud.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.system.start();
      return;
    }
    // `stop()` alone only halts EMISSION — already-live motes would keep drifting
    // across the editor's staged ship for a whole particle lifetime.
    this.system.stop();
    this.system.reset();
  }

  dispose(): void {
    // `dispose()` defaults to disposing the particle texture, which here is the
    // app-wide soft sprite shared with every emitter and explosion — pass false
    // so an arena rebuild does not pull it out from under them.
    this.system.dispose(false);
  }
}
