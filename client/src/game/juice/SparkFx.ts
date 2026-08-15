import { Color4, ParticleSystem, Vector3, type Scene } from "@babylonjs/core";
import { type EffectConfig } from "@space-arena/shared";
import { getParticleTexture } from "../particleTexture.js";
import type { ParticleQuality } from "./ExplosionFx.js";

/**
 * Weapon IMPACT SPARKS (owner request 2026-08-14): the short spray thrown where
 * a shot touches something — a hull, a shield, a rock, a prop, the regolith.
 *
 * Why this is not an {@link import("./ExplosionFx.js").ExplosionFx} slot, given
 * that class is the pooled one-shot machinery for everything else: an explosion
 * slot is a whole *destruction presentation* (flash sphere, shockwave torus,
 * eight drifting hull chunks) that holds its slot for eight seconds so the
 * debris can drift. A cannon landing five rounds a second would evict every
 * ship death in the arena within a second and draw shockwaves off bullet
 * strikes while doing it. So sparks get their own ring of slots — but they are
 * the SAME machinery in every way that matters: same `EffectConfig` content
 * contract, same {@link ParticleQuality} budget, same scene-shared radial
 * sprite, preallocated once and never allocating per hit.
 *
 * Everything that distinguishes an energy spark from a kinetic one — colour,
 * size, speed, lifetime and the cone width (`base.direction`, read here as the
 * spray's half-width rather than a fixed heading, since the heading is the
 * physical one the shot arrived on) — is authored in the effect config. This
 * class only aims and fires it.
 */

/**
 * Slots in the ring. Sized for the worst honest case rather than the average:
 * a few autocannons (a round every 150 ms) landing on the same target while a
 * beam sizzles. Each slot is one small `ParticleSystem` and no meshes.
 */
const POOL_SIZE = 12;

/**
 * Ceiling on one spark system's Babylon capacity, before the tier multiplier.
 * The shipped effects author 26-34; this stops a content pack from turning a
 * bullet strike into a 120-particle firework on twelve slots at once.
 */
const MAX_SPARK_CAPACITY = 36;

/** Slack after the longest particle life before a slot is considered free. */
const TAIL_MS = 60;

interface SparkSlot {
  /** Null only while the quality tier has particles switched off entirely. */
  system: ParticleSystem | null;
  /** World-space emit point; mutated in place, never reallocated. */
  emitter: Vector3;
  /** Milliseconds of burst left, or -1 when the slot is free. */
  remainingMs: number;
}

export class SparkFx {
  private readonly slots: SparkSlot[] = [];
  private quality: ParticleQuality;

  /**
   * A spark emits from a WORLD-space point (Babylon's `emitter` vector), not
   * from a node, so unlike the explosion pool there is nothing here to parent.
   */
  constructor(
    private readonly scene: Scene,
    quality: ParticleQuality,
  ) {
    this.quality = quality;
    for (let i = 0; i < POOL_SIZE; i++) {
      this.slots.push({ system: null, emitter: new Vector3(), remainingMs: -1 });
    }
    this.rebuildParticles();
  }

  get particlesEnabled(): boolean {
    return this.quality.enabled && this.quality.budgetMultiplier > 0;
  }

  /** Fixed allocation count, for lifecycle tests and diagnostics. */
  get poolSize(): number {
    return this.slots.length;
  }

  get activeCount(): number {
    let active = 0;
    for (const slot of this.slots) if (slot.remainingMs >= 0) active++;
    return active;
  }

  /** A quality change rebuilds the systems at the new budget; sparks are too short-lived to pop. */
  setQuality(quality: ParticleQuality): void {
    if (sameQuality(quality, this.quality)) return;
    this.quality = quality;
    this.rebuildParticles();
  }

  /**
   * Throw one spark burst at a world point, spraying along `axis` — which the
   * caller sets to the REVERSE of the shot's travel, so the spray comes back
   * off the surface the way a strike actually throws material.
   *
   * Returns whether particles were emitted (false when the tier has them off).
   * Saturation recycles the burst closest to finishing, so a firefight degrades
   * into fewer visible sprays rather than into allocation.
   */
  burst(
    effect: EffectConfig,
    x: number,
    y: number,
    z: number,
    axisX: number,
    axisY: number,
    axisZ: number,
  ): boolean {
    if (!this.particlesEnabled) return false;
    const slot = this.nextSlot();
    const system = slot.system;
    if (!system) return false;
    system.stop();
    system.reset();
    slot.emitter.set(x, y, z);

    const base = effect.base;
    // Aim: a unit spray axis, defaulting straight up when the caller has no
    // direction to give (a shot with no measured travel yet).
    const axisLength = Math.hypot(axisX, axisY, axisZ);
    const ax = axisLength > 1e-6 ? axisX / axisLength : 0;
    const ay = axisLength > 1e-6 ? axisY / axisLength : 1;
    const az = axisLength > 1e-6 ? axisZ / axisLength : 0;
    // Cone half-width from the effect's authored `direction`: a tight energy
    // flash and a wide kinetic shower differ here and nowhere in code.
    const spreadX = Math.abs(base.direction?.[0] ?? 0.5);
    const spreadY = Math.abs(base.direction?.[1] ?? 0.5);
    const spreadZ = Math.abs(base.direction?.[2] ?? 0.5);
    system.direction1.set(ax - spreadX, ay - spreadY, az - spreadZ);
    system.direction2.set(ax + spreadX, ay + spreadY, az + spreadZ);

    writeHexColor(base.color1, system.color1, 1, 0.85, 0.5);
    writeHexColor(base.color2, system.color2, 1, 0.35, 0.08);
    // Fade to the second colour's own hue rather than to grey: a blue laser
    // spark that died brown would read as a different weapon.
    system.colorDead.set(system.color2.r * 0.35, system.color2.g * 0.25, system.color2.b * 0.3, 0);
    system.minLifeTime = base.lifeMin;
    system.maxLifeTime = base.lifeMax;
    system.minSize = base.sizeMin;
    system.maxSize = base.sizeMax;
    system.minEmitPower = base.speedMin;
    system.maxEmitPower = base.speedMax;
    system.gravity.set(0, -(base.gravity ?? 0), 0);
    system.targetStopDuration = base.lifeMax + 0.05;
    system.manualEmitCount = this.burstCountFor(effect);
    slot.remainingMs = base.lifeMax * 1000 + TAIL_MS;
    system.start();
    return true;
  }

  /** Particles in one burst at the active tier — bounded by the effect and the budget. */
  burstCountFor(effect: EffectConfig): number {
    if (!this.particlesEnabled) return 0;
    const capacity = Math.min(effect.base.capacity, this.quality.maxEmitterCapacity, MAX_SPARK_CAPACITY);
    return Math.max(2, Math.round(capacity * this.quality.budgetMultiplier));
  }

  /** Age the ring; called by ViewManager's render loop. */
  update(dtMs: number): void {
    const dt = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.remainingMs < 0) continue;
      slot.remainingMs -= dt;
      if (slot.remainingMs <= 0) this.stopSlot(slot);
    }
  }

  dispose(): void {
    for (const slot of this.slots) {
      // `dispose(false)`: the radial sprite is scene-shared with ship emitters
      // and the explosion pool, and Babylon would otherwise take it with us.
      slot.system?.dispose(false);
      slot.system = null;
      slot.remainingMs = -1;
    }
    this.slots.length = 0;
  }

  private nextSlot(): SparkSlot {
    let oldest = this.slots[0]!;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.remainingMs < 0) return slot;
      if (slot.remainingMs < oldest.remainingMs) oldest = slot;
    }
    return oldest;
  }

  private stopSlot(slot: SparkSlot): void {
    slot.system?.stop();
    slot.remainingMs = -1;
  }

  private rebuildParticles(): void {
    const capacity = Math.max(
      2,
      Math.round(
        Math.min(this.quality.maxEmitterCapacity, MAX_SPARK_CAPACITY) * this.quality.budgetMultiplier,
      ),
    );
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      slot.system?.dispose(false);
      slot.system = null;
      slot.remainingMs = -1;
      if (!this.particlesEnabled) continue;
      const system = new ParticleSystem(`fx.spark.${i}`, capacity, this.scene);
      system.particleTexture = getParticleTexture(this.scene);
      system.emitter = slot.emitter;
      system.minEmitBox = Vector3.Zero();
      system.maxEmitBox = Vector3.Zero();
      system.emitRate = 0;
      system.manualEmitCount = 0;
      system.disposeOnStop = false;
      system.gravity = new Vector3();
      system.direction1 = new Vector3();
      system.direction2 = new Vector3();
      system.color1 = new Color4();
      system.color2 = new Color4();
      system.colorDead = new Color4();
      system.blendMode = ParticleSystem.BLENDMODE_ADD;
      // Stretched billboards are what make a spark a streak instead of a dot —
      // the same treatment the explosion pool gives its own spark system.
      system.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      slot.system = system;
    }
  }
}

function sameQuality(a: ParticleQuality, b: ParticleQuality): boolean {
  return (
    a.enabled === b.enabled &&
    a.budgetMultiplier === b.budgetMultiplier &&
    a.maxEmitterCapacity === b.maxEmitterCapacity
  );
}

/**
 * Write `#rrggbb` (or `#rgb`) into an existing `Color4`, falling back to the
 * given channels when the content is malformed. Character math rather than
 * `Color3.FromHexString` so a burst allocates nothing at all.
 */
function writeHexColor(hex: string, out: Color4, r: number, g: number, b: number): void {
  if (hex.length === 7 && hex.charCodeAt(0) === 35 /* # */) {
    const r0 = hexDigit(hex.charCodeAt(1));
    const r1 = hexDigit(hex.charCodeAt(2));
    const g0 = hexDigit(hex.charCodeAt(3));
    const g1 = hexDigit(hex.charCodeAt(4));
    const b0 = hexDigit(hex.charCodeAt(5));
    const b1 = hexDigit(hex.charCodeAt(6));
    if (r0 >= 0 && r1 >= 0 && g0 >= 0 && g1 >= 0 && b0 >= 0 && b1 >= 0) {
      out.set((r0 * 16 + r1) / 255, (g0 * 16 + g1) / 255, (b0 * 16 + b1) / 255, 1);
      return;
    }
  }
  if (hex.length === 4 && hex.charCodeAt(0) === 35) {
    const rd = hexDigit(hex.charCodeAt(1));
    const gd = hexDigit(hex.charCodeAt(2));
    const bd = hexDigit(hex.charCodeAt(3));
    if (rd >= 0 && gd >= 0 && bd >= 0) {
      out.set((rd * 17) / 255, (gd * 17) / 255, (bd * 17) / 255, 1);
      return;
    }
  }
  out.set(r, g, b, 1);
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}
