import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "@space-arena/shared";
import { fireMinIntervalMs, FlightOrderSender, type FlightOrderPolicy } from "./flightOrders.js";
import { FLIGHT_ORDER_BUDGET_SHARE } from "./flightHudLayout.js";
import type { FlightInputState } from "./flightInput.js";

const POLICY: FlightOrderPolicy = {
  throttleEpsilon: 0.02,
  turnEpsilon: 0.05,
  pitchEpsilon: 0.05,
  heartbeatMs: 250,
  minIntervalMs: 120,
  maxOrdersPerSec: 20,
  budgetShare: FLIGHT_ORDER_BUDGET_SHARE,
};

/** A centred-stick flight order — the payload every assertion below starts from. */
const NEUTRAL = { kind: "flight", throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: false, triggers: 0 } as const;

interface Harness {
  sender: FlightOrderSender;
  orders: Order[];
  /** Feed the sender the current input state at the current (fake) wall clock. */
  feed(input: Partial<FlightInputState>): void;
  /** Advance the fake clock. */
  tick(ms: number): void;
}

function harness(policy: FlightOrderPolicy = POLICY): Harness {
  const orders: Order[] = [];
  const sender = new FlightOrderSender((o) => orders.push(o), policy);
  const state: FlightInputState = { throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: false, triggers: 0 };
  return {
    sender,
    orders,
    feed(input) {
      Object.assign(state, input);
      sender.update(state, Date.now());
    },
    tick(ms) {
      vi.advanceTimersByTime(ms);
    },
  };
}

/**
 * FLIGHT.md §4 order debounce. Fake timers drive `Date.now()` so elapsed-time
 * behaviour (heartbeat, rate floor) is exercised for real but deterministically.
 */
describe("FlightOrderSender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the very first order immediately — until it lands the ship is inert", () => {
    const h = harness();
    h.feed({});
    expect(h.orders).toEqual([NEUTRAL]);
  });

  it("stays silent while nothing changes, however many frames go by", () => {
    const h = harness();
    h.feed({});
    for (let i = 0; i < 120; i++) {
      h.tick(16);
      h.feed({});
    }
    expect(h.orders).toHaveLength(1);
  });

  it("sends on a throttle change past the epsilon, not on sub-epsilon drift", () => {
    const h = harness();
    h.feed({});
    h.tick(200);
    h.feed({ throttle: 0.01 }); // under throttleEpsilon
    expect(h.orders).toHaveLength(1);
    h.tick(200);
    h.feed({ throttle: 0.4 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toEqual({ ...NEUTRAL, throttle: 0.4 });
  });

  it("sends on a turn change past the epsilon", () => {
    const h = harness();
    h.feed({});
    h.tick(200);
    h.feed({ turn: 0.04 });
    expect(h.orders).toHaveLength(1);
    h.tick(200);
    h.feed({ turn: -0.6 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ turn: -0.6 });
  });

  it("carries the pitch axis on every order, centred or not (BUBBLE.md §C)", () => {
    const h = harness();
    h.feed({});
    // Always present: an omitted axis and a centred one mean the same thing to
    // the sim, but a client that HAS the axis states it rather than letting a
    // zero look like an old client.
    expect(h.orders[0]).toHaveProperty("pitchStick", 0);
    h.tick(200);
    h.feed({ pitchStick: -0.8 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toEqual({ ...NEUTRAL, pitchStick: -0.8 });
  });

  it("sends on a pitch change past the epsilon, not on sub-epsilon drift", () => {
    const h = harness();
    h.feed({});
    h.tick(200);
    h.feed({ pitchStick: 0.04 }); // under pitchEpsilon
    expect(h.orders).toHaveLength(1);
    h.tick(200);
    h.feed({ pitchStick: 0.5 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ pitchStick: 0.5 });
  });

  it("lands a trailing pitch send: a slow stick return reaches the sim too", () => {
    const h = harness();
    h.feed({ pitchStick: 0.6 });
    h.tick(200);
    // Settling by 0.01 never crosses the epsilon...
    h.feed({ pitchStick: 0.59 });
    expect(h.orders).toHaveLength(1);
    // ...but the heartbeat guarantees the nose stops where the player let go,
    // which for HELD pitch state is the difference between level and a slow roll
    // into the boundary.
    h.tick(60);
    h.feed({ pitchStick: 0.59 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ pitchStick: 0.59 });
  });

  it("keeps the two stick axes independent", () => {
    const h = harness();
    h.feed({});
    h.tick(200);
    h.feed({ turn: 0.9 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ turn: 0.9, pitchStick: 0 });
    h.tick(200);
    h.feed({ pitchStick: -0.7 });
    expect(h.orders).toHaveLength(3);
    // The turn is still whatever the player is holding — a pitch order does not
    // silently re-centre the other axis.
    expect(h.orders[2]).toMatchObject({ turn: 0.9, pitchStick: -0.7 });
  });

  it("takes a re-resolved pitch epsilon (a theme that decouples the axes)", () => {
    const h = harness();
    h.feed({});
    h.sender.setPolicy({ ...POLICY, pitchEpsilon: 0.5 });
    h.tick(200);
    h.feed({ pitchStick: 0.2 }); // significant under the old epsilon, not the new one
    expect(h.orders).toHaveLength(1);
    h.tick(200);
    h.feed({ pitchStick: 0.8 });
    expect(h.orders).toHaveLength(2);
  });

  it("sends on either boost edge with no epsilon at all", () => {
    const h = harness();
    h.feed({});
    h.tick(200);
    h.feed({ boost: true });
    expect(h.orders).toHaveLength(2);
    h.tick(200);
    h.feed({ boost: false });
    expect(h.orders).toHaveLength(3);
    expect(h.orders[2]).toMatchObject({ boost: false });
  });

  it("uses a sub-tick budget floor for fire edges instead of the ordinary floor", () => {
    const h = harness();
    h.feed({});
    h.tick(1);
    h.feed({ fire: true });
    expect(h.orders).toHaveLength(1);
    h.tick(fireMinIntervalMs(POLICY) - 1);
    h.feed({ fire: true });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ fire: true });
    h.tick(1);
    h.feed({ fire: false });
    expect(h.orders).toHaveLength(2);
    h.tick(fireMinIntervalMs(POLICY) - 1);
    h.feed({ fire: false });
    expect(h.orders).toHaveLength(3);
    expect(h.orders[2]).toMatchObject({ fire: false });
  });

  it("keeps 15 press/release pairs per second under the effective server cap", () => {
    const h = harness();
    h.feed({});
    const pairsPerSecond = 15;
    const edgeIntervalMs = 1000 / (pairsPerSecond * 2);
    for (let edge = 0; edge < pairsPerSecond * 2; edge++) {
      h.tick(edgeIntervalMs);
      h.feed({ fire: edge % 2 === 0 });
    }
    // Exclude the free initial state: sustained outbound traffic stays within
    // the cap even though the input source produces 30 edges per second.
    expect(h.orders.length - 1).toBeLessThanOrEqual(POLICY.maxOrdersPerSec);
    expect(h.orders.some((order) => order.kind === "flight" && order.fire)).toBe(true);
  });

  it("lands a trailing send: sub-epsilon drift still reaches the sim after the heartbeat", () => {
    const h = harness();
    h.feed({});
    // A stick settling by 0.01 never crosses an epsilon...
    h.tick(200);
    h.feed({ turn: 0.01 });
    expect(h.orders).toHaveLength(1);
    // ...but the heartbeat guarantees it is not lost.
    h.tick(60);
    h.feed({ turn: 0.01 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ turn: 0.01 });
    // And once it has landed, the sender goes quiet again.
    h.tick(2000);
    h.feed({ turn: 0.01 });
    expect(h.orders).toHaveLength(2);
  });

  it("delays a significant change caught by the rate floor instead of dropping it", () => {
    const h = harness();
    h.feed({});
    h.tick(20);
    h.feed({ throttle: 1 }); // significant, but only 20 ms since the last send
    expect(h.orders).toHaveLength(1);
    h.tick(50); // still inside minIntervalMs (120)
    h.feed({ throttle: 1 });
    expect(h.orders).toHaveLength(1);
    h.tick(60); // 130 ms total — the floor has expired
    h.feed({ throttle: 1 });
    expect(h.orders).toHaveLength(2);
    expect(h.orders[1]).toMatchObject({ throttle: 1 });
  });

  it("stays inside the rate floor under a continuously swept stick", () => {
    const h = harness();
    // ~2 s of a 60 Hz frame loop with the stick moving every single frame.
    const FRAMES = 120;
    const FRAME_MS = 17;
    for (let frame = 0; frame < FRAMES; frame++) {
      h.feed({ turn: Math.sin(frame / 10) });
      h.tick(FRAME_MS);
    }
    // The floor caps the rate no matter how fast the thumb moves; the first send
    // is free, hence the +1. Well under tuning.maxOrdersPerSec by construction.
    const cap = Math.ceil((FRAMES * FRAME_MS) / POLICY.minIntervalMs) + 1;
    expect(h.sender.sentCount).toBeLessThanOrEqual(cap);
    expect(h.sender.sentCount).toBeGreaterThan(1);
  });

  it("adopts a re-resolved policy (theme hot-reload / rotation)", () => {
    const h = harness();
    h.feed({});
    h.sender.setPolicy({ ...POLICY, turnEpsilon: 0.5 });
    h.tick(200);
    h.feed({ turn: 0.2 }); // would have been significant under the old epsilon
    expect(h.orders).toHaveLength(1);
    h.tick(200);
    h.feed({ turn: 0.8 });
    expect(h.orders).toHaveLength(2);
  });

  it("reports the last state it handed to the sim", () => {
    const h = harness();
    h.feed({ throttle: 0.7, turn: -0.3, pitchStick: 0.45, boost: true });
    expect(h.sender.lastSent).toEqual({
      throttle: 0.7,
      turn: -0.3,
      pitchStick: 0.45,
      boost: true,
      fire: false,
      triggers: 0,
    });
  });
});
