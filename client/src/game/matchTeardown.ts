import { createLogger } from "@space-arena/shared";

const log = createLogger("MatchTeardown");

/** One named unit of match teardown — see {@link runTeardown}. */
export interface TeardownStep {
  readonly label: string;
  readonly run: () => void;
}

export type TeardownLogger = Pick<ReturnType<typeof createLogger>, "error">;

/**
 * Run every teardown step, in order, **even when one throws**.
 *
 * The page outlives the match: one Engine, one Scene, one render loop, and a
 * `MatchRuntime` that comes and goes inside them (main.ts). That makes a
 * half-finished teardown the worst failure mode in the client — an exception
 * partway through `dispose()` used to leave the session still ticking, the
 * Colyseus room still joined (audible, still simulating) and the previous
 * match's ship nodes still parented into the shared Scene, where they showed up
 * as "remnant ships" in the NEXT match.
 *
 * So no step is allowed to cancel the ones behind it: each is isolated, a throw
 * is logged and the sequence continues. Returns the labels that failed, which
 * lets callers assert (and tests prove) the belt-and-braces path ran.
 */
export function runTeardown(steps: readonly TeardownStep[], logger: TeardownLogger = log): string[] {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      step.run();
    } catch (err) {
      failed.push(step.label);
      logger.error(`teardown step "${step.label}" failed — continuing`, err);
    }
  }
  return failed;
}
