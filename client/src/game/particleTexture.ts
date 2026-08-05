import { DynamicTexture, type Scene, type Texture } from "@babylonjs/core";

/**
 * One soft radial-gradient particle sprite, generated once and shared by every
 * particle system in the app (emitter sockets AND one-shot explosion bursts) —
 * no external asset, and no second texture upload per effect.
 *
 * Cached per scene: the dev editor and the Hangar build their own registries on
 * the same scene, and a disposed scene must not leave a dangling texture behind.
 */
const cache = new WeakMap<Scene, Texture>();

export function getParticleTexture(scene: Scene): Texture {
  const cached = cache.get(scene);
  if (cached) return cached;

  const size = 32;
  const tex = new DynamicTexture("tex.particle.soft", size, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D | null;
  // NullEngine (and a few headless browser harnesses) has no 2D canvas. The
  // texture still provides a valid particle handle there; skip its cosmetic
  // radial paint so pooled effect lifecycle tests can exercise real systems.
  if (!ctx) {
    tex.hasAlpha = true;
    cache.set(scene, tex);
    return tex;
  }
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.5)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  tex.update(false);
  tex.hasAlpha = true;
  cache.set(scene, tex);
  return tex;
}
