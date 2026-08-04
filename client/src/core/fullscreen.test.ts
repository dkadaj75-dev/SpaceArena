import { describe, expect, it, vi } from "vitest";
import {
  fullscreenSupported,
  isFullscreen,
  lockLandscapeOrientation,
  onFullscreenChange,
  toggleFullscreen,
  type FullscreenDocument,
} from "./fullscreen.js";

/**
 * A controllable fake document. The standard/webkit split is the whole point of
 * these tests: each browser implements exactly one flavour, and the helpers
 * must work against either without the UI knowing which.
 */
function fakeDoc(flavour: "standard" | "webkit" | "none"): {
  doc: FullscreenDocument;
  setFullscreen: (on: boolean) => void;
  requests: number[];
  exits: number[];
  fire: (type: string) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  const requests: number[] = [];
  const exits: number[] = [];
  let element: Element | null = null;
  const root = {} as FullscreenDocument["documentElement"];

  const doc: FullscreenDocument = {
    documentElement: root,
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };

  if (flavour === "standard") {
    doc.fullscreenEnabled = true;
    Object.defineProperty(doc, "fullscreenElement", { get: () => element });
    root.requestFullscreen = () => {
      requests.push(1);
      element = root;
      return Promise.resolve();
    };
    doc.exitFullscreen = () => {
      exits.push(1);
      element = null;
      return Promise.resolve();
    };
  } else if (flavour === "webkit") {
    doc.webkitFullscreenEnabled = true;
    Object.defineProperty(doc, "webkitFullscreenElement", { get: () => element });
    root.webkitRequestFullscreen = () => {
      requests.push(1);
      element = root;
    };
    doc.webkitExitFullscreen = () => {
      exits.push(1);
      element = null;
    };
  }

  return {
    doc,
    setFullscreen: (on) => {
      element = on ? root : null;
    },
    requests,
    exits,
    fire: (type) => {
      for (const l of listeners.get(type) ?? []) l();
    },
  };
}

describe("fullscreenSupported", () => {
  it("reports the standard and webkit flags, and false with neither (iPhone Safari)", () => {
    expect(fullscreenSupported(fakeDoc("standard").doc)).toBe(true);
    expect(fullscreenSupported(fakeDoc("webkit").doc)).toBe(true);
    expect(fullscreenSupported(fakeDoc("none").doc)).toBe(false);
  });

  it("honours an explicit fullscreenEnabled=false (iframe without allowfullscreen)", () => {
    const { doc } = fakeDoc("standard");
    doc.fullscreenEnabled = false;
    expect(fullscreenSupported(doc)).toBe(false);
  });
});

describe("isFullscreen / toggleFullscreen", () => {
  it("round-trips through the STANDARD API: request when out, exit when in", async () => {
    const fake = fakeDoc("standard");
    expect(isFullscreen(fake.doc)).toBe(false);
    await expect(toggleFullscreen(fake.doc)).resolves.toBe(true);
    expect(fake.requests.length).toBe(1);
    expect(isFullscreen(fake.doc)).toBe(true);
    await expect(toggleFullscreen(fake.doc)).resolves.toBe(false);
    expect(fake.exits.length).toBe(1);
  });

  it("round-trips through the WEBKIT-prefixed API the same way", async () => {
    const fake = fakeDoc("webkit");
    await expect(toggleFullscreen(fake.doc)).resolves.toBe(true);
    expect(fake.requests.length).toBe(1);
    await expect(toggleFullscreen(fake.doc)).resolves.toBe(false);
    expect(fake.exits.length).toBe(1);
  });

  it("resolves to the unchanged state on a DENIED request instead of throwing", async () => {
    // Denied = no user gesture, or an iframe policy; the toggle must not
    // reject, because the Settings control repaints from the change event.
    const fake = fakeDoc("standard");
    fake.doc.documentElement.requestFullscreen = () => Promise.reject(new Error("denied"));
    await expect(toggleFullscreen(fake.doc)).resolves.toBe(false);
  });

  it("is a silent no-op on a browser with no fullscreen at all", async () => {
    await expect(toggleFullscreen(fakeDoc("none").doc)).resolves.toBe(false);
  });
});

describe("lockLandscapeOrientation", () => {
  it("asks a supporting screen to lock landscape and silently ignores rejection", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);
    await lockLandscapeOrientation({ orientation: { lock } });
    expect(lock).toHaveBeenCalledWith("landscape");

    lock.mockRejectedValueOnce(new Error("iOS Safari rejects this"));
    await expect(lockLandscapeOrientation({ orientation: { lock } })).resolves.toBeUndefined();
  });
});

describe("onFullscreenChange", () => {
  it("hears both the standard and the webkit event names, and unsubscribes both", () => {
    const fake = fakeDoc("standard");
    const listener = vi.fn();
    const off = onFullscreenChange(listener, fake.doc);
    fake.fire("fullscreenchange");
    fake.fire("webkitfullscreenchange");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    fake.fire("fullscreenchange");
    fake.fire("webkitfullscreenchange");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is how an EXTERNAL exit (Esc) reaches the UI: state flips without a toggle call", () => {
    const fake = fakeDoc("standard");
    fake.setFullscreen(true);
    expect(isFullscreen(fake.doc)).toBe(true);
    let seen: boolean | null = null;
    onFullscreenChange(() => {
      seen = isFullscreen(fake.doc);
    }, fake.doc);
    fake.setFullscreen(false); // the browser left fullscreen on its own
    fake.fire("fullscreenchange");
    expect(seen).toBe(false);
  });
});
