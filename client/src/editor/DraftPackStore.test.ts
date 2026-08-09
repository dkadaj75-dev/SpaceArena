import { describe, expect, it } from "vitest";
import type { ContentBundle } from "@space-arena/shared";
import { DraftPackStore } from "./DraftPackStore.js";

function bundle(): ContentBundle {
  return { kind: "space-arena.content-pack", protocolVersion: 1, packId: "pack.test", packVersion: 1, generatedAt: new Date(0).toISOString(), sourceHash: "sha256:base", manifest: { id: "manifest.test", type: "manifest", version: 1, files: ["tuning/a.json"] }, files: { "tuning/a.json": { id: "tuning.a", type: "tuning", version: 1, tickRate: 30 } } };
}

describe("DraftPackStore", () => {
  it("keeps an immutable base and tracks edit/create/delete/discard", () => {
    const store = new DraftPackStore(bundle());
    store.setFile("tuning/a.json", { id: "tuning.a", type: "tuning", version: 1, tickRate: 60 });
    expect(store.dirtyCount()).toBe(1);
    expect((store.base.files["tuning/a.json"] as { tickRate: number }).tickRate).toBe(30);
    store.addFile("tuning/b.json", { id: "tuning.b", type: "tuning", version: 1 });
    expect((store.snapshot().manifest as { files: string[] }).files).toContain("tuning/b.json");
    store.deleteFile("tuning/b.json");
    expect(store.snapshot().files["tuning/b.json"]).toBeUndefined();
    store.discard();
    expect(store.dirtyCount()).toBe(0);
  });

  it("restores a dirty draft without storing credentials", () => {
    const store = new DraftPackStore(bundle());
    store.setFile("tuning/a.json", { id: "tuning.a", type: "tuning", version: 1, tickRate: 55 });
    const raw = localStorage.getItem("sa.constellation.draft.sha256:base")!;
    expect(raw).not.toContain("accessToken");
    expect(DraftPackStore.restore(bundle()).dirtyCount()).toBe(1);
    localStorage.clear();
  });
});
