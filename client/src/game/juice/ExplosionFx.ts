import {
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import { type EffectConfig, type QualityConfig } from "@space-arena/shared";
import { getParticleTexture } from "../particleTexture.js";
import type { ExplosionSettings } from "./juiceSettings.js";

/** The quality tier's particle budget — the same block `ShipSocketRig` reads. */
export type ParticleQuality = QualityConfig["particles"];

const POOL_SIZE = 6;
const FULL_VISIBILITY_MS = 5_000;
const FADE_MS = 3_000;
const TOTAL_LIFE_MS = FULL_VISIBILITY_MS + FADE_MS;
const MAX_CHUNKS = 8;

interface Chunk {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
}

interface ExplosionSlot {
  root: TransformNode;
  emitter: Vector3;
  flash: Mesh;
  flashMaterial: StandardMaterial;
  shockwave: Mesh;
  shockwaveMaterial: StandardMaterial;
  chunks: Chunk[];
  fire: ParticleSystem | null;
  sparks: ParticleSystem | null;
  ageMs: number;
  chunkCount: number;
}

/**
 * A fixed, reusable ship-destruction presentation. The short particle burst is
 * deliberately separate from the long-lived physical-looking hull pieces: in
 * space the latter provide the expanding, drifting read after the fire is gone.
 * No slot owns assets at burst time; saturation recycles the oldest slot.
 */
export class ExplosionFx {
  private readonly slots: ExplosionSlot[] = [];
  private readonly chunkMaterial: StandardMaterial;
  private settings: ExplosionSettings;
  private quality: ParticleQuality;

  constructor(
    private readonly scene: Scene,
    settings: ExplosionSettings,
    quality: ParticleQuality,
    private readonly parent: TransformNode | null = null,
  ) {
    this.settings = settings;
    this.quality = quality;
    this.chunkMaterial = new StandardMaterial("mat.explosion.chunk", scene);
    this.chunkMaterial.diffuseColor = new Color3(0.12, 0.08, 0.055);
    this.chunkMaterial.emissiveColor = new Color3(0.11, 0.025, 0.006);
    this.chunkMaterial.specularColor = Color3.Black();
    for (let i = 0; i < POOL_SIZE; i++) this.slots.push(this.createSlot(i));
    this.rebuildParticles();
  }

  /** Theme hot reload only changes the authored burst budget; the fixed pool stays intact. */
  setSettings(settings: ExplosionSettings): void { this.settings = settings; }

  setQuality(quality: ParticleQuality): void {
    if (sameQuality(quality, this.quality)) return;
    this.quality = quality;
    this.rebuildParticles();
  }

  get particlesEnabled(): boolean {
    return this.quality.enabled && this.quality.budgetMultiplier > 0;
  }

  burstCountFor(effect: EffectConfig): number {
    if (!this.particlesEnabled) return 0;
    return Math.min(this.capacityFor(effect), Math.max(1, Math.round(this.settings.burstCount * this.quality.budgetMultiplier)));
  }

  /** Start (or immediately recycle) an effect. Velocity is inherited by shards only. */
  burst(effect: EffectConfig, x: number, z: number, y = 0.3, velocity?: { x: number; y: number; z: number }): boolean {
    const slot = this.nextSlot();
    this.stopSlot(slot);
    slot.root.position.set(x, y, z);
    slot.emitter.set(x, y, z);
    slot.root.setEnabled(true);
    slot.ageMs = 0;
    slot.chunkCount = chunkCountFor(this.quality);
    this.configureFlash(slot, effect);
    this.configureChunks(slot, effect, velocity);
    if (!this.particlesEnabled || !slot.fire || !slot.sparks) return false;
    this.configureParticles(slot, effect);
    return true;
  }

  /** Advance visual motion; called by ViewManager's render loop. */
  update(dtMs: number): void {
    const dt = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
    // Do not let a background-tab frame leave an effect alive past its deadline;
    // only cap physical displacement, where a giant jump would look wrong.
    const seconds = Math.min(100, dt) / 1000;
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s]!;
      if (slot.ageMs < 0) continue;
      slot.ageMs += dt;
      if (slot.ageMs >= TOTAL_LIFE_MS) {
        this.stopSlot(slot);
        continue;
      }
      const fade = slot.ageMs <= FULL_VISIBILITY_MS ? 1 : 1 - (slot.ageMs - FULL_VISIBILITY_MS) / FADE_MS;
      const flashT = Math.min(1, slot.ageMs / 150);
      slot.flashMaterial.alpha = Math.max(0, (1 - flashT) * 0.95);
      slot.flash.scaling.setAll(0.45 + flashT * 3.2);
      const waveT = Math.min(1, slot.ageMs / 600);
      slot.shockwaveMaterial.alpha = Math.max(0, (1 - waveT) * 0.32);
      slot.shockwave.scaling.setAll(0.6 + waveT * 7);
      for (let i = 0; i < slot.chunkCount; i++) {
        const chunk = slot.chunks[i]!;
        chunk.mesh.position.x += chunk.velocity.x * seconds;
        chunk.mesh.position.y += chunk.velocity.y * seconds;
        chunk.mesh.position.z += chunk.velocity.z * seconds;
        // A tiny drag keeps a burst compact without a gravity/updraft fiction.
        const drag = Math.max(0, 1 - seconds * 0.17);
        chunk.velocity.scaleInPlace(drag);
        chunk.mesh.rotation.x += chunk.spin.x * seconds;
        chunk.mesh.rotation.y += chunk.spin.y * seconds;
        chunk.mesh.rotation.z += chunk.spin.z * seconds;
        chunk.mesh.visibility = fade;
      }
    }
  }

  get activeCount(): number {
    let active = 0;
    for (const slot of this.slots) if (slot.ageMs >= 0) active++;
    return active;
  }

  /** Fixed allocation count, useful for lifecycle tests and diagnostics. */
  get poolSize(): number { return this.slots.length; }

  dispose(): void {
    for (const slot of this.slots) {
      slot.fire?.dispose(false);
      slot.sparks?.dispose(false);
      slot.flashMaterial.dispose();
      slot.shockwaveMaterial.dispose();
      slot.root.dispose(false, true);
    }
    this.slots.length = 0;
    this.chunkMaterial.dispose();
  }

  private createSlot(index: number): ExplosionSlot {
    const root = new TransformNode(`fx.explosion.slot.${index}`, this.scene);
    root.parent = this.parent;
    root.setEnabled(false);
    const flashMaterial = emissiveMaterial(`mat.explosion.flash.${index}`, this.scene, new Color3(1, 0.42, 0.08));
    const flash = MeshBuilder.CreateSphere(`fx.explosion.flash.${index}`, { diameter: 1, segments: 8 }, this.scene);
    flash.material = flashMaterial;
    flash.parent = root;
    flash.isPickable = false;
    const shockwaveMaterial = emissiveMaterial(`mat.explosion.wave.${index}`, this.scene, new Color3(1, 0.28, 0.045));
    const shockwave = MeshBuilder.CreateTorus(`fx.explosion.wave.${index}`, { diameter: 1, thickness: 0.035, tessellation: 20 }, this.scene);
    shockwave.material = shockwaveMaterial;
    shockwave.parent = root;
    shockwave.rotation.x = Math.PI / 2;
    shockwave.isPickable = false;
    const chunks: Chunk[] = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const mesh = MeshBuilder.CreateCylinder(`fx.explosion.chunk.${index}.${i}`, { height: 0.7, diameterTop: 0.12, diameterBottom: 0.55, tessellation: 4 }, this.scene);
      mesh.material = this.chunkMaterial;
      mesh.parent = root;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      chunks.push({ mesh, velocity: new Vector3(), spin: new Vector3() });
    }
    return { root, emitter: new Vector3(), flash, flashMaterial, shockwave, shockwaveMaterial, chunks, fire: null, sparks: null, ageMs: -1, chunkCount: 0 };
  }

  private rebuildParticles(): void {
    for (const slot of this.slots) {
      // Particle systems borrow the scene-shared radial sprite. The default
      // `dispose(true)` would invalidate ship thrusters whenever a quality
      // change rebuilds this pool (notably the automatic Ultra -> High step).
      slot.fire?.dispose(false); slot.sparks?.dispose(false); slot.fire = null; slot.sparks = null;
      if (!this.particlesEnabled) continue;
      const capacity = Math.max(1, Math.round(this.quality.maxEmitterCapacity * this.quality.budgetMultiplier));
      slot.fire = this.particleSystem(`fx.explosion.fire`, capacity, slot.emitter);
      slot.sparks = this.particleSystem(`fx.explosion.sparks`, Math.max(1, Math.round(capacity * 0.45)), slot.emitter);
      slot.sparks.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      slot.sparks.minSize = 0.035;
      slot.sparks.maxSize = 0.12;
      slot.sparks.minLifeTime = 0.18;
      slot.sparks.maxLifeTime = 0.55;
      slot.sparks.minEmitPower = 15;
      slot.sparks.maxEmitPower = 30;
      slot.sparks.color1 = new Color4(1, 0.75, 0.22, 1);
      slot.sparks.color2 = new Color4(1, 0.18, 0.025, 1);
      slot.sparks.colorDead = new Color4(0.28, 0.1, 0.04, 0);
    }
  }

  private particleSystem(name: string, capacity: number, emitter: Vector3): ParticleSystem {
    const system = new ParticleSystem(name, capacity, this.scene);
    system.particleTexture = getParticleTexture(this.scene);
    system.emitter = emitter;
    system.minEmitBox = Vector3.Zero();
    system.maxEmitBox = Vector3.Zero();
    system.emitRate = 0;
    system.manualEmitCount = 0;
    system.disposeOnStop = false;
    system.gravity = Vector3.Zero();
    system.direction1 = new Vector3(-1, -1, -1);
    system.direction2 = new Vector3(1, 1, 1);
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    return system;
  }

  private configureParticles(slot: ExplosionSlot, effect: EffectConfig): void {
    const fire = slot.fire!;
    fire.reset();
    fire.color1 = color4(effect.base.color1, new Color4(1, 0.9, 0.55, 1));
    fire.color2 = color4(effect.base.color2, new Color4(1, 0.18, 0.04, 1));
    // Ash-grey transparent tail makes the fire read as cooling gas, while the
    // initial additive core gets the scene GlowLayer's short spike for free.
    fire.colorDead = new Color4(0.22, 0.22, 0.22, 0);
    fire.minLifeTime = effect.base.lifeMin;
    fire.maxLifeTime = effect.base.lifeMax;
    fire.minSize = effect.base.sizeMin;
    fire.maxSize = effect.base.sizeMax;
    fire.minEmitPower = effect.base.speedMin;
    fire.maxEmitPower = effect.base.speedMax;
    fire.targetStopDuration = effect.base.lifeMax + 0.06;
    fire.manualEmitCount = this.burstCountFor(effect);
    fire.start();
    const sparks = slot.sparks!;
    sparks.reset();
    sparks.targetStopDuration = 0.6;
    sparks.manualEmitCount = Math.max(2, Math.round(this.burstCountFor(effect) * 0.35));
    sparks.start();
  }

  private configureFlash(slot: ExplosionSlot, effect: EffectConfig): void {
    slot.flashMaterial.emissiveColor = color3(effect.base.color1, new Color3(1, 0.45, 0.08));
    slot.flashMaterial.alpha = 0.95;
    slot.flash.scaling.setAll(0.45);
    slot.shockwaveMaterial.emissiveColor = color3(effect.base.color2, new Color3(1, 0.25, 0.04));
    slot.shockwaveMaterial.alpha = 0.32;
    slot.shockwave.scaling.setAll(0.6);
  }

  private configureChunks(slot: ExplosionSlot, effect: EffectConfig, inherited?: { x: number; y: number; z: number }): void {
    const hot = color3(effect.base.color2, new Color3(0.8, 0.08, 0.02));
    this.chunkMaterial.emissiveColor.copyFromFloats(hot.r * 0.22, hot.g * 0.1, hot.b * 0.05);
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const chunk = slot.chunks[i]!;
      if (i >= slot.chunkCount) { chunk.mesh.setEnabled(false); continue; }
      const dx = randomSigned(), dy = randomSigned(), dz = randomSigned();
      const length = Math.max(0.2, Math.hypot(dx, dy, dz));
      const speed = 3.5 + Math.random() * 7;
      chunk.mesh.position.set(dx / length * 0.25, dy / length * 0.25, dz / length * 0.25);
      chunk.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const scale = 0.45 + Math.random() * 0.65;
      chunk.mesh.scaling.set(scale * (0.55 + Math.random()), scale, scale * (0.55 + Math.random()));
      chunk.mesh.visibility = 1;
      chunk.mesh.setEnabled(true);
      chunk.velocity.set(dx / length * speed + (inherited?.x ?? 0), dy / length * speed + (inherited?.y ?? 0), dz / length * speed + (inherited?.z ?? 0));
      chunk.spin.set(randomSigned() * 7, randomSigned() * 7, randomSigned() * 7);
    }
  }

  private nextSlot(): ExplosionSlot {
    for (const slot of this.slots) if (slot.ageMs < 0) return slot;
    let oldest = this.slots[0]!;
    for (let i = 1; i < this.slots.length; i++) if (this.slots[i]!.ageMs > oldest.ageMs) oldest = this.slots[i]!;
    return oldest;
  }

  private stopSlot(slot: ExplosionSlot): void {
    slot.fire?.stop(); slot.sparks?.stop();
    slot.root.setEnabled(false);
    slot.ageMs = -1;
    slot.chunkCount = 0;
  }

  private capacityFor(effect: EffectConfig): number {
    return Math.max(1, Math.round(Math.min(effect.base.capacity, this.quality.maxEmitterCapacity) * this.quality.budgetMultiplier));
  }
}

function chunkCountFor(quality: ParticleQuality): number {
  return quality.enabled ? Math.max(4, Math.min(MAX_CHUNKS, Math.round(4 + quality.budgetMultiplier * 4))) : 4;
}
function randomSigned(): number { return Math.random() * 2 - 1; }
function sameQuality(a: ParticleQuality, b: ParticleQuality): boolean { return a.enabled === b.enabled && a.budgetMultiplier === b.budgetMultiplier && a.maxEmitterCapacity === b.maxEmitterCapacity; }
function emissiveMaterial(name: string, scene: Scene, color: Color3): StandardMaterial { const m = new StandardMaterial(name, scene); m.diffuseColor = Color3.Black(); m.specularColor = Color3.Black(); m.emissiveColor = color; m.disableLighting = true; m.backFaceCulling = false; return m; }
function color3(hex: string, fallback: Color3): Color3 { try { return Color3.FromHexString(hex); } catch { return fallback; } }
function color4(hex: string, fallback: Color4): Color4 { const c = color3(hex, new Color3(fallback.r, fallback.g, fallback.b)); return new Color4(c.r, c.g, c.b, 1); }
