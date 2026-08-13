import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@space-arena/shared";
import type { AssetRegistry } from "../core/AssetRegistry.js";
import { ModelLoadQueue } from "../core/modelLoadQueue.js";
import { allHangarShipJobs, hangarPriorityJobs } from "./hangarAssetPreload.js";

describe("hangar priority loading", () => {
  it("requests an owned hull before revealing/enqueueing locked hulls", async () => {
    const ships = [
      { id: "ship.owned", render: { recipe: "ship", model: "owned.glb" }, defaultFitting: [] },
      { id: "ship.locked", render: { recipe: "ship", model: "locked.glb" }, defaultFitting: [] },
    ];
    const configs = {
      get: vi.fn((_type: string, id: string) => ships.find((ship) => ship.id === id)),
      getAll: vi.fn(() => ships),
    } as unknown as ConfigService;
    const calls: string[] = [];
    const assets = { ensureModel: vi.fn(async (render: { model?: string }) => {
      calls.push(render.model!); return null;
    }) } as unknown as AssetRegistry;
    const queue = new ModelLoadQueue(assets, { gapMs: 250 });

    await queue.loadBlocking(hangarPriorityJobs(configs, new Set(["ship.owned"]), {}));
    for (const background of allHangarShipJobs(configs)) void queue.enqueue(background);
    await Promise.resolve();

    expect(calls[0]).toBe("owned.glb");
    expect(calls.indexOf("locked.glb")).toBeGreaterThan(calls.indexOf("owned.glb"));
    queue.dispose();
  });
});
