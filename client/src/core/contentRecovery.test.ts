import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverFromStaleContentPack } from "./contentRecovery.js";

/**
 * A minimal ServiceWorkerRegistration stand-in. `update()` optionally spawns
 * an installing worker that walks to "activated", the way a real skipWaiting
 * worker does.
 */
function fakeRegistration({ updateFinds }: { updateFinds: boolean }) {
  const listeners = new Map<string, Array<() => void>>();
  const on = (target: { addEventListener: unknown }, type: string, fn: () => void): void => {
    (listeners.get(type) ?? listeners.set(type, []).get(type)!).push(fn);
    void target;
  };
  const worker = {
    state: "installing",
    addEventListener: (type: string, fn: () => void) => on(worker, `worker:${type}`, fn),
  };
  const registration = {
    installing: null as typeof worker | null,
    waiting: null,
    addEventListener: (type: string, fn: () => void) => on(registration, type, fn),
    update: vi.fn(async () => {
      if (!updateFinds) return;
      registration.installing = worker;
      for (const fn of listeners.get("updatefound") ?? []) fn();
      worker.state = "activated";
      for (const fn of listeners.get("worker:statechange") ?? []) fn();
    }),
  };
  return registration;
}

const reload = vi.fn();
let registration: ReturnType<typeof fakeRegistration> | null;

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal("location", { reload });
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration: async () => registration },
  });
  vi.stubGlobal("caches", { delete: vi.fn(async () => true), keys: async () => [] });
});

afterEach(() => vi.unstubAllGlobals());

describe("recoverFromStaleContentPack", () => {
  it("reloads once a newer worker activates, and purges the content cache first", async () => {
    registration = fakeRegistration({ updateFinds: true });
    await expect(recoverFromStaleContentPack()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(caches.delete)).toHaveBeenCalledWith("space-arena-content-json");
  });

  it("does NOT reload when the update check finds nothing — same client would just loop", async () => {
    registration = fakeRegistration({ updateFinds: false });
    vi.useFakeTimers();
    const result = recoverFromStaleContentPack();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toBe(false);
    vi.useRealTimers();
    expect(reload).not.toHaveBeenCalled();
  });

  it("attempts recovery at most once per session — the flag survives its own reload", async () => {
    registration = fakeRegistration({ updateFinds: true });
    await recoverFromStaleContentPack();
    reload.mockClear();
    await expect(recoverFromStaleContentPack()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("stays inert with no service worker registration at all (dev server)", async () => {
    registration = null;
    await expect(recoverFromStaleContentPack()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
