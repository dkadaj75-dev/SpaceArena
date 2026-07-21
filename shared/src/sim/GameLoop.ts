import { SIM_TICK_RATE } from "../constants.js";

/** Called once per fixed simulation step. */
export type TickFn = (fixedDtSeconds: number, tickNumber: number) => void;

export interface GameLoopOptions {
  /** Fixed steps per second. Defaults to SIM_TICK_RATE (30 Hz). */
  tickRate?: number;
  /**
   * Max fixed ticks processed in a single `step()` call (spiral-of-death clamp).
   * Excess accumulated time is dropped. Defaults to 5.
   */
  maxTicksPerStep?: number;
}

/**
 * Host-agnostic fixed-timestep accumulator. The caller passes wall-clock deltas
 * (from `engine.getDeltaTime()` on the client, or a server timer in Phase 2);
 * the loop invokes `tick(fixedDt, n)` zero or more times per call and exposes an
 * `alpha` interpolation fraction for rendering between the last two sim states.
 *
 * No wall-clock is read inside, so a given dt sequence is fully deterministic
 * and the class is reusable verbatim server-side.
 */
export class GameLoop {
  readonly tickRate: number;
  readonly fixedDtMs: number;
  readonly fixedDtSeconds: number;
  private readonly maxTicksPerStep: number;

  private accumulatorMs = 0;
  private tickCount = 0;

  constructor(
    private readonly tick: TickFn,
    options: GameLoopOptions = {},
  ) {
    this.tickRate = options.tickRate ?? SIM_TICK_RATE;
    if (this.tickRate <= 0) throw new Error("tickRate must be > 0");
    this.fixedDtMs = 1000 / this.tickRate;
    this.fixedDtSeconds = this.fixedDtMs / 1000;
    this.maxTicksPerStep = options.maxTicksPerStep ?? 5;
  }

  /** Total number of ticks executed so far. */
  get totalTicks(): number {
    return this.tickCount;
  }

  /**
   * Interpolation fraction in [0, 1): how far the render time is between the
   * last completed tick and the next one. Multiply by fixedDt for smoothing.
   */
  get alpha(): number {
    return this.accumulatorMs / this.fixedDtMs;
  }

  /**
   * Advance the loop by `dtMs` wall-clock milliseconds. Runs as many fixed ticks
   * as have accumulated, clamped to `maxTicksPerStep`. Returns how many ticks ran.
   */
  step(dtMs: number): number {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return 0;
    this.accumulatorMs += dtMs;

    let ran = 0;
    while (this.accumulatorMs >= this.fixedDtMs) {
      if (ran >= this.maxTicksPerStep) {
        // Spiral-of-death guard: drop the backlog we can't catch up on.
        this.accumulatorMs = this.accumulatorMs % this.fixedDtMs;
        break;
      }
      this.accumulatorMs -= this.fixedDtMs;
      this.tick(this.fixedDtSeconds, this.tickCount);
      this.tickCount += 1;
      ran += 1;
    }
    return ran;
  }

  /** Reset accumulator and tick counter (e.g. on match restart). */
  reset(): void {
    this.accumulatorMs = 0;
    this.tickCount = 0;
  }
}
