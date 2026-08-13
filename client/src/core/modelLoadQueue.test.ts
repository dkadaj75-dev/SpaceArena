import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetRegistry } from "./AssetRegistry.js";
import { ModelLoadQueue } from "./modelLoadQueue.js";

const job = (id: string) => ({ id, render: { recipe: "model.test", model: `${id}.glb` } });

describe("ModelLoadQueue", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("spaces loads, jumps a selected model to the front, and pauses during a match", async () => {
    vi.useFakeTimers();
    let paused = false;
    const starts: Array<{ id: string; at: number }> = [];
    const assets = { ensureModel: vi.fn(async (render: { model?: string }) => {
      starts.push({ id: render.model!, at: Date.now() }); return null;
    }) } as unknown as AssetRegistry;
    const queue = new ModelLoadQueue(assets, { gapMs: 250, isPaused: () => paused });

    void queue.enqueue(job("a"));
    void queue.enqueue(job("b"));
    void queue.enqueue(job("c"));
    void queue.prioritize(job("c"));
    await vi.advanceTimersByTimeAsync(249);
    expect(starts.map((entry) => entry.id)).toEqual(["a.glb"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts.map((entry) => entry.id)).toEqual(["a.glb", "c.glb"]);
    expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(250);

    paused = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(starts).toHaveLength(2);
    paused = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(starts.map((entry) => entry.id)).toEqual(["a.glb", "c.glb", "b.glb"]);
    queue.dispose();
  });
});
