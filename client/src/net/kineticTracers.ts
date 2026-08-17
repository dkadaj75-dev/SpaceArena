import type { ProjectileSnapshot } from "@space-arena/shared";

/**
 * Client-side kinetic tracer rounds for ONLINE matches.
 *
 * Kinetic rounds are deliberately not replicated: an autocannon holds a
 * 24-round clip on a 0.15 s cycle, and per-round schema entities at that rate
 * across ten ships is exactly the patch-stream churn the wire protocol avoids
 * ("Missiles are the only schema-replicated projectile; beams/kinetics are
 * events"). The half that was never built is this one: the client received the
 * `kinetic` fire event — and used it for sound — while the ROUND ITSELF was
 * drawn only offline, where it exists as a real sim entity in the snapshot. On
 * every online match the autocannon fired invisible bullets.
 *
 * These tracers are display-only ballistics reconstructed from what the client
 * knows at the moment the fire event arrives: the shooter's interpolated pose,
 * the target's interpolated position (the sim aims a kinetic at the target's
 * CURRENT position and leads nothing — CombatSystem — so aiming the tracer the
 * same way reproduces the real trajectory up to interpolation error), and the
 * module's authored `projectile.speed`/`lifetime`. Damage remains entirely the
 * sim's: when a relayed kinetic damage event names a shooter, that shooter's
 * oldest tracer is retired on the spot, so hits LOOK like hits at the moment
 * they land instead of the tracer flying on through the hull.
 *
 * Sampled rounds are appended to the interpolated snapshot's `projectiles`, so
 * the existing pool renderer and despawn resolution draw them with no renderer
 * changes. `EntityView.resolveDespawn` is evidence-first — a disappearance
 * draws an impact only when the sim's damage report or a geometry probe backs
 * it — so a tracer expiring mid-air stays silent rather than flashing a
 * phantom impact.
 *
 * Ids are NEGATIVE and descending: `projectileTracks` in the view is keyed by
 * id, and a synthetic id must never collide with a real replicated entity
 * (missiles ride the same array with sim-issued non-negative ids).
 */

export interface KineticTracerBallistics {
  /** World units per second (`fire.projectile.speed`). */
  speed: number;
  /** Seconds the round flies before expiring, already capped by range/speed. */
  ttlSec: number;
}

interface KineticTracer {
  id: number;
  shooterId: number;
  bornMs: number;
  ttlMs: number;
  origin: { x: number; y: number; z: number };
  dir: { x: number; y: number; z: number };
  speed: number;
}

export class KineticTracerField {
  private readonly tracers: KineticTracer[] = [];
  private nextId = -2;

  /**
   * Register one fired round. `dir` need not be normalized; a degenerate
   * direction (shooter and target interpolated onto the same point) drops the
   * round rather than dividing by zero — one invisible tracer out of a clip is
   * better than a NaN position reaching the renderer.
   */
  spawn(
    shooterId: number,
    nowMs: number,
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    ballistics: KineticTracerBallistics,
  ): void {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 1e-6) || !(ballistics.speed > 0) || !(ballistics.ttlSec > 0)) return;
    this.tracers.push({
      id: this.nextId--,
      shooterId,
      bornMs: nowMs,
      ttlMs: ballistics.ttlSec * 1000,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
      speed: ballistics.speed,
    });
  }

  /**
   * A kinetic damage event named this shooter: its OLDEST live round is the one
   * that landed (rounds are fired and travel in order), so retire it now. The
   * same-frame despawn lets the view's evidence-first impact draw place the
   * spark where the sim said the damage happened.
   */
  onKineticDamage(shooterId: number): void {
    for (let i = 0; i < this.tracers.length; i++) {
      if (this.tracers[i]!.shooterId === shooterId) {
        this.tracers.splice(i, 1);
        return;
      }
    }
  }

  /** Drop every round (match teardown / rejoin). */
  clear(): void {
    this.tracers.length = 0;
  }

  /**
   * Advance to `nowMs`, cull the expired, and append the live rounds to `out`
   * as snapshot projectiles for the pool renderer.
   */
  sample(nowMs: number, out: ProjectileSnapshot[]): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i]!;
      const ageMs = nowMs - tr.bornMs;
      if (ageMs >= tr.ttlMs) {
        this.tracers.splice(i, 1);
        continue;
      }
      const dist = (ageMs / 1000) * tr.speed;
      out.push({
        id: tr.id,
        kind: "kinetic",
        pos: {
          x: tr.origin.x + tr.dir.x * dist,
          y: tr.origin.y + tr.dir.y * dist,
          z: tr.origin.z + tr.dir.z * dist,
        },
        heading: Math.atan2(tr.dir.z, tr.dir.x),
      });
    }
  }

  /** Live round count (tests / dev probe). */
  get size(): number {
    return this.tracers.length;
  }
}
