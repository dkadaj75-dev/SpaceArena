import { Color3, Color4, ParticleSystem, Vector3, type Scene } from "@babylonjs/core";
import { createLogger, type EffectConfig, type QualityConfig } from "@space-arena/shared";
import { getParticleTexture } from "../particleTexture.js";
import type { ExplosionSettings } from "./juiceSettings.js";

const log = createLogger("ExplosionFx");

/** The quality tier's particle budget — the same block `ShipSocketRig` reads. */
export type ParticleQuality = QualityConfig["particles"];

interface EffectPool {
  systems: ParticleSystem[];
  emitters: Vector3[];
  /** Round-robin cursor across the pool. */
  next: number;
}

/**
 * ROADMAP §10 5.7 — one-shot explosion bursts on `entityDestroyed`, with the
 * variant chosen from content (`theme.juice.explosions` → an `fx.*` effect
 * config per ship class / asteroid) and the particle count taken from the
 * active quality tier (§10 5.6).
 *
 * Budget discipline, identical in spirit to the emitter sockets:
 *  - capacity = `min(effect.capacity, tier.maxEmitterCapacity) × tier.budgetMultiplier`
 *  - burst count = `theme burstCount × tier.budgetMultiplier`, capped by capacity
 *  - `particles.enabled: false` (or a zero multiplier) means no systems are
 *    ever built and `burst()` is a no-op — the sound still plays.
 *
 * Systems are pooled per effect id (`poolPerEffect`, round-robin) and reused via
 * `manualEmitCount`, so a busy fight never allocates a particle system per kill.
 */
export class ExplosionFx {
  private readonly pools = new Map<string, EffectPool>();
  private settings: ExplosionSettings;
  private quality: ParticleQuality;

  constructor(
    private readonly scene: Scene,
    settings: ExplosionSettings,
    quality: ParticleQuality,
  ) {
    this.settings = settings;
    this.quality = quality;
  }

  /** Theme hot-reload. Existing pools keep their (effect-derived) shape. */
  setSettings(settings: ExplosionSettings): void {
    this.settings = settings;
  }

  /** Quality-tier change: drop the pools so the next burst rebuilds at the new budget. */
  setQuality(quality: ParticleQuality): void {
    if (
      quality.enabled === this.quality.enabled &&
      quality.budgetMultiplier === this.quality.budgetMultiplier &&
      quality.maxEmitterCapacity === this.quality.maxEmitterCapacity
    ) {
      this.quality = quality;
      return;
    }
    this.quality = quality;
    this.disposePools();
  }

  /** True when the active tier allows any explosion particles at all. */
  get particlesEnabled(): boolean {
    return this.quality.enabled && this.quality.budgetMultiplier > 0;
  }

  /** Particles one burst emits under the active tier (0 when particles are off). */
  burstCountFor(effect: EffectConfig): number {
    if (!this.particlesEnabled) return 0;
    return Math.min(this.capacityFor(effect), Math.max(1, Math.round(this.settings.burstCount * this.quality.budgetMultiplier)));
  }

  /**
   * Fire one burst of `effect` at the arena position (`x`, `z`). Returns true
   * when particles were emitted; false when the tier suppresses them (callers
   * still play the effect's sound — audio is not a quality-tier concern).
   */
  burst(effect: EffectConfig, x: number, z: number, y = 0.3): boolean {
    if (!this.particlesEnabled) return false;
    const pool = this.ensurePool(effect);
    if (pool.systems.length === 0) return false;
    const index = pool.next % pool.systems.length;
    pool.next = (pool.next + 1) % pool.systems.length;
    const system = pool.systems[index]!;
    pool.emitters[index]!.set(x, y, z);
    system.manualEmitCount = this.burstCountFor(effect);
    if (!system.isStarted()) system.start();
    return true;
  }

  dispose(): void {
    this.disposePools();
  }

  private capacityFor(effect: EffectConfig): number {
    return Math.max(
      1,
      Math.round(
        Math.min(effect.base.capacity, this.quality.maxEmitterCapacity) * this.quality.budgetMultiplier,
      ),
    );
  }

  private ensurePool(effect: EffectConfig): EffectPool {
    const existing = this.pools.get(effect.id);
    if (existing) return existing;

    const capacity = this.capacityFor(effect);
    const size = Math.max(1, Math.floor(this.settings.poolPerEffect));
    const pool: EffectPool = { systems: [], emitters: [], next: 0 };
    for (let i = 0; i < size; i++) {
      const emitter = new Vector3(0, 0.3, 0);
      const system = new ParticleSystem(`fx.explosion.${effect.id}.${i}`, capacity, this.scene);
      system.particleTexture = getParticleTexture(this.scene);
      system.emitter = emitter;
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
      // A burst emits through `manualEmitCount`, never a rate — and stops itself
      // once the last particle's lifetime has elapsed, so an idle pool costs nothing.
      system.emitRate = 0;
      system.manualEmitCount = 0;
      system.targetStopDuration = effect.base.lifeMax + 0.05;
      system.disposeOnStop = false;
      system.gravity = new Vector3(0, effect.base.gravity ?? 0, 0);
      // Explosions blow outward in every direction, unlike the directional
      // engine/vent emitters — a symmetric direction band gives the sphere.
      const spread = effect.base.direction ?? [0, 0.3, 0];
      system.direction1 = new Vector3(-1, spread[1] - 1, -1);
      system.direction2 = new Vector3(1, spread[1] + 1, 1);
      system.blendMode = ParticleSystem.BLENDMODE_ADD;
      pool.systems.push(system);
      pool.emitters.push(emitter);
    }
    log.info(`explosion pool built for ${effect.id}`, { capacity, size });
    this.pools.set(effect.id, pool);
    return pool;
  }

  private disposePools(): void {
    for (const pool of this.pools.values()) for (const system of pool.systems) system.dispose();
    this.pools.clear();
  }
}

function hexToColor4(hex: string): Color4 {
  try {
    const c = Color3.FromHexString(hex);
    return new Color4(c.r, c.g, c.b, 1);
  } catch {
    return new Color4(1, 1, 1, 1);
  }
}
