import type { EffectBase } from "@space-arena/shared";

/**
 * Subset of Babylon `ParticleSystem`'s settable numeric fields our dispatch
 * table writes to. Deliberately structural (not `import type { ParticleSystem }`)
 * so this module stays Babylon-free and unit-testable with a plain object —
 * {@link import("./ShipSocketRig.js").ShipSocketRig} passes a real
 * `ParticleSystem` at runtime, which satisfies this shape.
 */
export interface ParticleParamTarget {
  emitRate: number;
  minLifeTime: number;
  maxLifeTime: number;
  minSize: number;
  maxSize: number;
  minEmitPower: number;
  maxEmitPower: number;
}

const warnedParams = new Set<string>();

/** Test hook: clears the warn-once dedupe so a fresh test can observe the warning again. */
export function resetParticleParamWarnings(): void {
  warnedParams.clear();
}

/**
 * ROADMAP §9 4.6 socket rendering — the ONE dispatch table mapping an
 * emitter binding's `param` (a name drawn from the effect config's `params[]`,
 * see `content/effects/*.json`) to the Babylon `ParticleSystem` field(s) it
 * drives. Pure and side-effect-free beyond mutating `target`, so it is testable
 * without a Babylon scene/canvas.
 *
 * `power` is the one ROADMAP-example param with no 1:1 field: it scales the
 * effect's baseline `speedMin`/`speedMax` band multiplicatively (curve output
 * is a multiplier, e.g. `boostActive: [[0,1],[1,2.2]]`) rather than setting an
 * absolute value, so a binding can intensify an already-tuned effect instead of
 * overwriting it outright.
 *
 * An unknown `param` (typo in content, or a future param not yet wired here)
 * warns exactly once per param name via `warn` and is otherwise a no-op —
 * content authors get one loud signal, not a per-frame log flood.
 */
export function applyParticleParam(
  target: ParticleParamTarget,
  base: EffectBase,
  param: string,
  value: number,
  warn: (message: string) => void = () => {},
): void {
  switch (param) {
    case "emitRate":
      target.emitRate = Math.max(0, value);
      return;
    case "lifeMin":
      target.minLifeTime = Math.max(0, value);
      return;
    case "lifeMax":
      target.maxLifeTime = Math.max(0, value);
      return;
    case "sizeMin":
      target.minSize = Math.max(0, value);
      return;
    case "sizeMax":
      target.maxSize = Math.max(0, value);
      return;
    case "speedMin":
      target.minEmitPower = Math.max(0, value);
      return;
    case "speedMax":
      target.maxEmitPower = Math.max(0, value);
      return;
    case "power":
      target.minEmitPower = Math.max(0, base.speedMin * value);
      target.maxEmitPower = Math.max(0, base.speedMax * value);
      return;
    default:
      if (!warnedParams.has(param)) {
        warnedParams.add(param);
        warn(`unknown emitter param "${param}" — ignoring (add a case to particleParams.ts)`);
      }
  }
}
