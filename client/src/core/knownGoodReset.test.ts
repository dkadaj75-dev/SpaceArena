import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanReloadUrl, displayOverridesInEffect, NUKED_KEY, nukeToKnownGood } from "./knownGoodReset.js";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

function fakeLocation(href: string) {
  return { href, replace: vi.fn() };
}

const PLAYER_STATE = {
  accessToken: "at",
  refreshToken: "rt",
  guestToken: "gt",
  "hangar.loadout.talon": "{}",
  "hangar.lastShip": "talon",
};

describe("cleanReloadUrl", () => {
  it("strips the params that would re-pin the state being cleared", () => {
    // `?renderer=webgpu` OUTRANKS localStorage at boot, so a plain reload would
    // restore the exact setting the reset just removed — an infinite loop that
    // also made the later escalation rungs unreachable.
    const out = cleanReloadUrl("https://x/y?renderer=webgpu&editor=1&server=z&keepme=9", 1234);
    const url = new URL(out);
    expect(url.searchParams.get("renderer")).toBeNull();
    expect(url.searchParams.get("editor")).toBeNull();
    expect(url.searchParams.get("server")).toBeNull();
    expect(url.searchParams.get("keepme")).toBe("9");
    expect(url.searchParams.get("nuked")).toBe("1234");
  });
});

describe("displayOverridesInEffect", () => {
  it("lists exactly the display state, so the settings button can name it", () => {
    const storage = memoryStorage({
      "sa.quality": "low",
      "spacearena.qualityAutoSafe": "armed-and-fired",
      "sa.quality.learned.nvidia-rtx": "high",
      ...PLAYER_STATE,
    });
    const found = displayOverridesInEffect(storage);
    expect(found).toContain("sa.quality");
    expect(found).toContain("spacearena.qualityAutoSafe");
    expect(found).toContain("sa.quality.learned.nvidia-rtx");
    expect(found).not.toContain("accessToken");
  });

  it("reports nothing on a clean browser", () => {
    expect(displayOverridesInEffect(memoryStorage(PLAYER_STATE))).toEqual([]);
  });
});

describe("nukeToKnownGood", () => {
  let sw: ServiceWorkerContainer;
  let unregister: ReturnType<typeof vi.fn>;
  let cacheDelete: ReturnType<typeof vi.fn>;
  let cacheStore: CacheStorage;

  beforeEach(() => {
    unregister = vi.fn().mockResolvedValue(true);
    sw = { getRegistrations: vi.fn().mockResolvedValue([{ unregister }, { unregister }]) } as unknown as ServiceWorkerContainer;
    cacheDelete = vi.fn().mockResolvedValue(true);
    cacheStore = { keys: vi.fn().mockResolvedValue(["a", "b"]), delete: cacheDelete } as unknown as CacheStorage;
  });

  it("clears display state, evicts workers and caches, and reloads clean", async () => {
    const storage = memoryStorage({
      "spacearena.renderer": "webgpu",
      "sa.quality": "low",
      "spacearena.rendererAutoFallback": "armed-and-fired",
      "spacearena.qualityAutoSafe": "armed-and-fired",
      "sa.quality.learned.swiftshader": "low",
      ...PLAYER_STATE,
    });
    const location = fakeLocation("https://x/?renderer=webgpu");

    await expect(nukeToKnownGood({ storage, location, serviceWorker: sw, caches: cacheStore })).resolves.toBe(true);

    expect(storage.getItem("spacearena.renderer")).toBeNull();
    expect(storage.getItem("sa.quality")).toBeNull();
    expect(storage.getItem("spacearena.rendererAutoFallback")).toBeNull();
    expect(storage.getItem("spacearena.qualityAutoSafe")).toBeNull();
    expect(storage.getItem("sa.quality.learned.swiftshader")).toBeNull();
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(cacheDelete).toHaveBeenCalledTimes(2);
    expect(location.replace).toHaveBeenCalledOnce();
    expect(String(location.replace.mock.calls[0]?.[0])).not.toContain("renderer=webgpu");
  });

  it("NEVER touches the player's session or loadout", async () => {
    // A self-heal that logs you out or eats your fitting is not a self-heal.
    const storage = memoryStorage({ "sa.quality": "low", ...PLAYER_STATE });
    await nukeToKnownGood({ storage, location: fakeLocation("https://x/"), serviceWorker: sw, caches: cacheStore });
    for (const [key, value] of Object.entries(PLAYER_STATE)) {
      expect(storage.getItem(key)).toBe(value);
    }
  });

  it("is one shot per browser, so it can never become a reload loop", async () => {
    const storage = memoryStorage({ [NUKED_KEY]: "1", "sa.quality": "low" });
    const location = fakeLocation("https://x/");
    await expect(nukeToKnownGood({ storage, location, serviceWorker: sw, caches: cacheStore })).resolves.toBe(false);
    expect(location.replace).not.toHaveBeenCalled();
    expect(storage.getItem("sa.quality")).toBe("low");
  });

  it("still evicts workers and reloads when storage is unavailable", async () => {
    // Private mode / blocked storage: `setItem` throws, and the throw used to
    // be the end of the whole remedy.
    const hostile = {
      get length() {
        return 0;
      },
      key: () => null,
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    } as unknown as Storage;
    const location = fakeLocation("https://x/");
    await expect(
      nukeToKnownGood({ storage: hostile, location, serviceWorker: sw, caches: cacheStore }),
    ).resolves.toBe(true);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(location.replace).toHaveBeenCalledOnce();
  });
});
