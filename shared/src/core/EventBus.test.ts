import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./EventBus.js";

type TestEvents = {
  ping: { value: number };
  greet: { name: string };
};

describe("EventBus", () => {
  it("calls subscribed handlers with the emitted payload", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on("ping", handler);

    bus.emit("ping", { value: 42 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it("does not call handlers for other events", () => {
    const bus = new EventBus<TestEvents>();
    const pingHandler = vi.fn();
    const greetHandler = vi.fn();
    bus.on("ping", pingHandler);
    bus.on("greet", greetHandler);

    bus.emit("ping", { value: 1 });

    expect(pingHandler).toHaveBeenCalledTimes(1);
    expect(greetHandler).not.toHaveBeenCalled();
  });

  it("supports multiple handlers for the same event", () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("ping", a);
    bus.on("ping", b);

    bus.emit("ping", { value: 7 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("off() removes a handler so it stops receiving events", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on("ping", handler);
    bus.off("ping", handler);

    bus.emit("ping", { value: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("on() returns an unsubscribe function", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    const unsubscribe = bus.on("ping", handler);
    unsubscribe();

    bus.emit("ping", { value: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("once() fires exactly one time", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.once("ping", handler);

    bus.emit("ping", { value: 1 });
    bus.emit("ping", { value: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 1 });
  });

  it("clear(event) removes only that event's handlers", () => {
    const bus = new EventBus<TestEvents>();
    const pingHandler = vi.fn();
    const greetHandler = vi.fn();
    bus.on("ping", pingHandler);
    bus.on("greet", greetHandler);

    bus.clear("ping");
    bus.emit("ping", { value: 1 });
    bus.emit("greet", { name: "x" });

    expect(pingHandler).not.toHaveBeenCalled();
    expect(greetHandler).toHaveBeenCalledTimes(1);
  });

  it("clear() with no args removes all handlers", () => {
    const bus = new EventBus<TestEvents>();
    const pingHandler = vi.fn();
    const greetHandler = vi.fn();
    bus.on("ping", pingHandler);
    bus.on("greet", greetHandler);

    bus.clear();
    bus.emit("ping", { value: 1 });
    bus.emit("greet", { name: "x" });

    expect(pingHandler).not.toHaveBeenCalled();
    expect(greetHandler).not.toHaveBeenCalled();
  });

  it("listenerCount reflects subscriptions", () => {
    const bus = new EventBus<TestEvents>();
    expect(bus.listenerCount("ping")).toBe(0);
    bus.on("ping", vi.fn());
    bus.on("ping", vi.fn());
    expect(bus.listenerCount("ping")).toBe(2);
  });

  it("a handler unsubscribing itself during emit does not break other handlers", () => {
    const bus = new EventBus<TestEvents>();
    const other = vi.fn();
    const selfUnsub = vi.fn(() => {
      bus.off("ping", selfUnsub);
    });
    bus.on("ping", selfUnsub);
    bus.on("ping", other);

    bus.emit("ping", { value: 1 });
    bus.emit("ping", { value: 2 });

    expect(selfUnsub).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });
});
