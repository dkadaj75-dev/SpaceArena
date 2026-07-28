import type { Order } from "@space-arena/shared";
import type { FlightInputState } from "./flightInput.js";

/** Thresholds/timings driving {@link FlightOrderSender} (resolved theme values). */
export interface FlightOrderPolicy {
  throttleEpsilon: number;
  turnEpsilon: number;
  /** |ΔpitchStick| threshold; resolved from `turnEpsilon` when content omits it. */
  pitchEpsilon: number;
  heartbeatMs: number;
  /** Hard floor between two sends — the server rate-limit guard. */
  minIntervalMs: number;
  /** Effective server order cap, including the server fallback when tuning omits it. */
  maxOrdersPerSec: number;
  /** Fraction of the server order budget reserved for flight orders. */
  budgetShare: number;
}

/** Fire edges stay below one sim tick of latency while still bounding click spam. */
const MAX_FIRE_MIN_INTERVAL_MS = 30;

export function fireMinIntervalMs(policy: FlightOrderPolicy): number {
  const budgetFloor = 1000 / (policy.maxOrdersPerSec * policy.budgetShare);
  return Math.min(policy.minIntervalMs, budgetFloor, MAX_FIRE_MIN_INTERVAL_MS);
}

/**
 * FLIGHT.md §4 order sender. The sim's `FlightState` is LEVEL-triggered: the last
 * flight order keeps being integrated until another replaces it, so the client's
 * job is to send one order per *meaningful* input change and nothing else.
 *
 * A send happens when, and only when:
 *  - `|Δthrottle| > throttleEpsilon`, or
 *  - `|Δturn| > turnEpsilon`, or
 *  - `|ΔpitchStick| > pitchEpsilon` (BUBBLE.md §C — the third axis is treated
 *    exactly like turn: same −1..1 scale, same trailing-send guarantee), or
 *  - the boost flag flipped (edge-triggered, no epsilon), or
 *  - the fire flag flipped (edge-triggered, no epsilon and subject to a small
 *    sub-tick floor derived from the server order budget), or
 *  - `heartbeatMs` elapsed while the input keeps drifting inside the epsilons —
 *    which is also the TRAILING send: a slow stick return that never crosses an
 *    epsilon still lands, so the ship can never be left flying a stale state.
 *
 * `minIntervalMs` is a hard floor on top of all of that (see
 * `orderMinIntervalMs` — derived from `tuning.maxOrdersPerSec`); a change
 * suppressed by the floor is remembered as pending and sent as soon as the floor
 * expires, so throttling delays an order but never drops one.
 *
 * The clock is injected (`nowMs` per call) rather than read from
 * `performance.now()` inside: the caller already has the frame time, and it makes
 * the debounce trivially testable.
 */
export class FlightOrderSender {
  /** Last state actually sent — the baseline every epsilon is measured against. */
  private readonly sent: FlightInputState = { throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: false };
  private lastSentMs = 0;
  /** False until the first order lands, which is never delayed. */
  private started = false;
  private ordersSent = 0;
  private rateWindowStartMs = 0;
  private rateWindowCount = 0;

  constructor(
    private readonly send: (order: Order) => void,
    private policy: FlightOrderPolicy,
  ) {}

  /** Adopt re-resolved thresholds (theme hot-reload / rotation). */
  setPolicy(policy: FlightOrderPolicy): void {
    this.policy = policy;
  }

  /** Flight orders emitted so far (debug overlays / tests). */
  get sentCount(): number {
    return this.ordersSent;
  }

  /** The last state handed to the sim. */
  get lastSent(): Readonly<FlightInputState> {
    return this.sent;
  }

  /**
   * Feed this frame's input state. Sends at most one order per call.
   * `nowMs` must be a monotonic clock in milliseconds.
   */
  update(input: FlightInputState, nowMs: number): void {
    const dThrottle = Math.abs(input.throttle - this.sent.throttle);
    const dTurn = Math.abs(input.turn - this.sent.turn);
    const dPitch = Math.abs(input.pitchStick - this.sent.pitchStick);
    const boostEdge = input.boost !== this.sent.boost;
    const fireEdge = input.fire !== this.sent.fire;
    // "Differs at all" is the pending flag: `sent` IS the baseline, so nothing is
    // dropped by the floor below — an order suppressed this frame still differs
    // next frame and goes out then.
    const differs = dThrottle > 0 || dTurn > 0 || dPitch > 0 || boostEdge || fireEdge;
    const significant =
      dThrottle > this.policy.throttleEpsilon ||
      dTurn > this.policy.turnEpsilon ||
      dPitch > this.policy.pitchEpsilon ||
      boostEdge ||
      fireEdge;

    // The first order of a match is never delayed: until one arrives the sim has
    // no FlightState at all and the ship sits inert.
    if (this.started) {
      if (!differs) return;
      const sinceSend = nowMs - this.lastSentMs;
      // Trigger edges use a smaller, budget-derived floor. It stays below one
      // 30 Hz sim tick, so a shot is not lost, while a jitter-clicker cannot
      // stream press/release edges above the flight sender's budget share.
      const floor = fireEdge ? fireMinIntervalMs(this.policy) : this.policy.minIntervalMs;
      if (sinceSend < floor) return;
      // Sub-epsilon drift (and the trailing send after the stick settles) waits
      // for the heartbeat instead of streaming one order per frame.
      if (!significant && sinceSend < this.policy.heartbeatMs) return;
    }

    // Fire's latency floor is intentionally below a sim tick, so it cannot by
    // itself enforce the server's whole-order ceiling. This fixed window is the
    // final guard: a still-held change remains pending against `sent` and can
    // land when the next window opens.
    if (!this.started || nowMs - this.rateWindowStartMs >= 1000) {
      this.rateWindowStartMs = nowMs;
      this.rateWindowCount = 0;
    }
    if (this.rateWindowCount >= this.policy.maxOrdersPerSec) return;

    this.sent.throttle = input.throttle;
    this.sent.turn = input.turn;
    this.sent.pitchStick = input.pitchStick;
    this.sent.boost = input.boost;
    this.sent.fire = input.fire;
    this.lastSentMs = nowMs;
    this.started = true;
    this.ordersSent += 1;
    this.rateWindowCount += 1;
    // `pitchStick` is always present, even centred: the axis is optional on the
    // wire (BUBBLE.md §B) so an old client can omit it, but a client that HAS a
    // pitch axis must state it — dropping the field at zero would make "stick
    // returned to centre" indistinguishable from "no pitch axis at all" only
    // because the value happened to be 0.
    this.send({
      kind: "flight",
      throttle: input.throttle,
      turn: input.turn,
      pitchStick: input.pitchStick,
      boost: input.boost,
      fire: input.fire,
    });
  }
}
