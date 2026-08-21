import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyConfig } from "@space-arena/shared";
import { contentPathFor, saveConfig } from "./saveConfig.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contentPathFor", () => {
  it("maps a config type to its content subfolder and strips the id's type prefix", () => {
    expect(contentPathFor({ id: "arena.ring-nebula", type: "arena" })).toBe("arenas/ring-nebula.json");
    expect(contentPathFor({ id: "tuning.default", type: "tuning" })).toBe("tuning/default.json");
    expect(contentPathFor({ id: "action.notify-boundary", type: "action" })).toBe("actions/notify-boundary.json");
    expect(contentPathFor({ id: "notification.boundary-warning", type: "notification" })).toBe(
      "notifications/boundary-warning.json",
    );
    expect(contentPathFor({ id: "asteroid.rock-a", type: "asteroid" })).toBe("asteroids/rock-a.json");
    expect(contentPathFor({ id: "camera.default", type: "camera" })).toBe("camera/default.json");
  });
});

describe("saveConfig", () => {
  it("POSTs to /__editor/save with the mapped path and config json, matching MapEditor's existing save call", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const config = { id: "tuning.default", type: "tuning", version: 1 } as unknown as AnyConfig;
    const error = await saveConfig(config);

    expect(error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/__editor/save");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ path: "tuning/default.json", json: config });
  });

  it("returns an error string when the save request fails", async () => {
    const fetchMock = vi.fn(async () => new Response("bad path", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const config = { id: "camera.default", type: "camera", version: 1 } as unknown as AnyConfig;
    const error = await saveConfig(config);

    expect(error).toContain("bad path");
  });

  it("returns a UI-safe error string when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("dev server disconnected"))));

    const config = { id: "camera.default", type: "camera", version: 1 } as unknown as AnyConfig;

    await expect(saveConfig(config)).resolves.toContain("dev server disconnected");
  });
});
