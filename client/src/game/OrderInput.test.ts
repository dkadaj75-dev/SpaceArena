import { describe, expect, it, vi } from "vitest";
import { Observable, PointerEventTypes, type PointerInfo, type Scene } from "@babylonjs/core";
import type { ConfigService, Order, TuningConfig } from "@space-arena/shared";
import type { GameSession } from "./GameSession.js";
import { OrderInput } from "./OrderInput.js";
import { HUD_CONTROL_ATTR } from "./inputGuards.js";

const CANVAS_RECT = { left: 0, top: 0, width: 375, height: 812 };

interface Harness {
  input: OrderInput;
  orders: Order[];
  down(id: number, x: number, y: number, opts?: { pointerType?: string; target?: unknown }): void;
  up(id: number, x: number, y: number, opts?: { pointerType?: string; target?: unknown }): void;
}

function harness(tuning: Partial<TuningConfig> = {}): Harness {
  const observable = new Observable<PointerInfo>();
  const scene = {
    onPointerObservable: observable,
    pointerX: 0,
    pointerY: 0,
    getEngine: () => ({ getRenderingCanvasClientRect: () => CANVAS_RECT }),
    // Every pick lands on the ground plane → each accepted tap is a move order.
    pick: () => ({ hit: true, pickedMesh: { name: "groundPlane", metadata: undefined }, pickedPoint: { x: 5, y: 0, z: 7 } }),
  } as unknown as Scene;

  const configs = {
    getAll: () => [{ doubleTapWindowMs: 250, tapSlopPx: 12, edgeRejectMarginPx: 24, ...tuning }],
  } as unknown as ConfigService;

  const orders: Order[] = [];
  const session = { playerId: 1, order: (o: Order) => orders.push(o) } as unknown as GameSession;

  const input = new OrderInput(scene, configs, session);
  const fire = (type: number, id: number, x: number, y: number, opts?: { pointerType?: string; target?: unknown }): void => {
    scene.pointerX = x;
    scene.pointerY = y;
    observable.notifyObservers({
      type,
      event: {
        pointerId: id,
        clientX: x,
        clientY: y,
        pointerType: opts?.pointerType ?? "touch",
        target: opts?.target ?? null,
      },
    } as unknown as PointerInfo);
  };

  return {
    input,
    orders,
    down: (id, x, y, opts) => fire(PointerEventTypes.POINTERDOWN, id, x, y, opts),
    up: (id, x, y, opts) => fire(PointerEventTypes.POINTERUP, id, x, y, opts),
  };
}

describe("OrderInput — tap state machine (§2.2)", () => {
  it("turns a single clean tap into a move order", () => {
    const h = harness();
    h.down(1, 180, 400);
    h.up(1, 182, 402);
    expect(h.orders).toEqual([{ kind: "move", target: { x: 5, z: 7 }, boost: false }]);
  });

  it("drops a tap that dragged further than tapSlopPx", () => {
    const h = harness();
    h.down(1, 180, 400);
    h.up(1, 240, 400);
    expect(h.orders).toHaveLength(0);
  });

  it("upgrades a second tap inside the double-tap window to a boost order", () => {
    const h = harness();
    h.down(1, 180, 400);
    h.up(1, 180, 400);
    h.down(2, 182, 401);
    h.up(2, 182, 401);
    expect(h.orders).toHaveLength(2);
    expect(h.orders[0]).toMatchObject({ boost: false });
    expect(h.orders[1]).toMatchObject({ boost: true });
  });
});

/**
 * ROADMAP 5.4 regression: TacticalCamera owns the two-finger pan/pinch path on
 * the SAME `scene.onPointerObservable`. A pointer that took part in any
 * multi-touch gesture must never also produce a tap order, or every pinch/pan
 * would fire a stray move order at the release point.
 */
describe("OrderInput — multi-touch gestures never produce taps", () => {
  it("suppresses both pointers of a two-finger pinch/pan (camera gesture)", () => {
    const h = harness();
    h.down(1, 150, 400);
    h.down(2, 250, 400);
    // Pinch/pan, then release in either order.
    h.up(2, 300, 380);
    h.up(1, 100, 420);
    expect(h.orders).toHaveLength(0);
  });

  it("suppresses the first finger even when the second one only grazes the screen", () => {
    const h = harness();
    h.down(1, 150, 400);
    h.down(2, 250, 400);
    h.up(2, 250, 400); // second finger lifts immediately
    h.up(1, 150, 400); // first finger releases exactly where it landed
    expect(h.orders).toHaveLength(0);
  });

  it("re-arms cleanly: the tap after a two-finger gesture still works", () => {
    const h = harness();
    h.down(1, 150, 400);
    h.down(2, 250, 400);
    h.up(2, 250, 400);
    h.up(1, 150, 400);
    expect(h.orders).toHaveLength(0);

    h.down(3, 180, 400);
    h.up(3, 180, 400);
    expect(h.orders).toHaveLength(1);
  });
});

describe("OrderInput — palm rejection (5.4)", () => {
  it("ignores a touch that lands inside the edge margin", () => {
    const h = harness();
    h.down(1, 8, 400); // 8px from the left bezel, margin is 24
    h.up(1, 8, 400);
    expect(h.orders).toHaveLength(0);
  });

  it("rejects every bezel: left, right, top and bottom", () => {
    const h = harness();
    const edges: [number, number][] = [
      [5, 400],
      [CANVAS_RECT.width - 5, 400],
      [180, 5],
      [180, CANVAS_RECT.height - 5],
    ];
    for (const [i, [x, y]] of edges.entries()) {
      h.down(i + 1, x, y);
      h.up(i + 1, x, y);
    }
    expect(h.orders).toHaveLength(0);
  });

  it("does not let a rejected palm suppress the thumb tap that follows it", () => {
    const h = harness();
    h.down(1, 4, 700); // palm on the bezel — never tracked
    h.down(2, 180, 400); // thumb taps the middle
    h.up(2, 180, 400);
    h.up(1, 4, 700);
    // The palm must not have counted toward the multi-touch tally.
    expect(h.orders).toEqual([{ kind: "move", target: { x: 5, z: 7 }, boost: false }]);
  });

  it("exempts presses that land on a HUD control", () => {
    const button = document.createElement("div");
    button.setAttribute(HUD_CONTROL_ATTR, "module");
    document.body.append(button);
    const h = harness();
    h.down(1, 4, 700, { target: button });
    h.up(1, 4, 700, { target: button });
    expect(h.orders).toHaveLength(1);
    button.remove();
  });

  it("exempts mouse and pen pointers — only touch contacts can be palms", () => {
    const h = harness();
    h.down(1, 4, 700, { pointerType: "mouse" });
    h.up(1, 4, 700, { pointerType: "mouse" });
    expect(h.orders).toHaveLength(1);
  });

  it("is disabled when the tuning margin is 0", () => {
    const h = harness({ edgeRejectMarginPx: 0 });
    h.down(1, 2, 2);
    h.up(1, 2, 2);
    expect(h.orders).toHaveLength(1);
  });

  it("stops issuing orders once disabled by the editor", () => {
    const h = harness();
    h.input.setEnabled(false);
    h.down(1, 180, 400);
    h.up(1, 180, 400);
    expect(h.orders).toHaveLength(0);
  });
});

describe("inputGuards wiring", () => {
  it("never rejects when no canvas rect is available (headless / pre-layout)", () => {
    const observable = new Observable<PointerInfo>();
    const scene = {
      onPointerObservable: observable,
      pointerX: 0,
      pointerY: 0,
      getEngine: () => ({ getRenderingCanvasClientRect: () => null }),
      pick: () => ({ hit: true, pickedMesh: { name: "groundPlane" }, pickedPoint: { x: 1, y: 0, z: 2 } }),
    } as unknown as Scene;
    const orderSpy = vi.fn();
    new OrderInput(
      scene,
      { getAll: () => [{ doubleTapWindowMs: 250, tapSlopPx: 12, edgeRejectMarginPx: 24 }] } as unknown as ConfigService,
      { playerId: 1, order: orderSpy } as unknown as GameSession,
    );
    const fire = (type: number, x: number, y: number): void => {
      observable.notifyObservers({
        type,
        event: { pointerId: 1, clientX: x, clientY: y, pointerType: "touch", target: null },
      } as unknown as PointerInfo);
    };
    fire(PointerEventTypes.POINTERDOWN, 1, 1);
    fire(PointerEventTypes.POINTERUP, 1, 1);
    expect(orderSpy).toHaveBeenCalledTimes(1);
  });
});
