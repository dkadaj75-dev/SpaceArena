import { beforeEach, describe, expect, it } from "vitest";
import type { ContentBundle } from "@space-arena/shared";
import { DraftPackStore } from "./DraftPackStore.js";

function bundle(): ContentBundle {
  return {
    packId: "pack.test",
    packVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "hash-test",
    manifest: { id: "manifest.test", type: "manifest", version: 1, files: ["camera/default.json"] },
    files: { "camera/default.json": { id: "camera.default", type: "camera", version: 1 } },
  } as unknown as ContentBundle;
}

beforeEach(() => {
  localStorage.clear();
});

describe("DraftPackStore dirty tracking", () => {
  it("reports edits, additions and deletions as the paths Save to repo must write", () => {
    const store = new DraftPackStore(bundle());
    expect(store.dirtyPaths()).toEqual([]);

    store.setFile("camera/default.json", { id: "camera.default", type: "camera", version: 2 });
    store.addFile("notifications/new.json", { id: "notification.new", type: "notification", version: 1 });

    expect(store.dirtyPaths()).toEqual(["camera/default.json", "notifications/new.json"]);
    expect(store.deletedPaths()).toEqual([]);
    expect(store.dirtyCount()).toBe(2);
  });

  it("keeps a deleted base file dirty and separates it out as a deletion", () => {
    const store = new DraftPackStore(bundle());

    store.deleteFile("camera/default.json");

    expect(store.dirtyPaths()).toEqual(["camera/default.json"]);
    expect(store.deletedPaths()).toEqual(["camera/default.json"]);
    expect(store.snapshot().files["camera/default.json"]).toBeUndefined();
    expect((store.snapshot().manifest as { files: string[] }).files).toEqual([]);
  });

  it("does not propagate a deletion for a config that only ever existed in the draft", () => {
    const store = new DraftPackStore(bundle());

    store.addFile("notifications/new.json", { id: "notification.new", type: "notification", version: 1 });
    store.deleteFile("notifications/new.json");

    // Adding then deleting returns the pack to its base state — nothing on disk
    // to remove, so the path must not be handed to the delete endpoint.
    expect(store.dirtyPaths()).toEqual([]);
    expect(store.deletedPaths()).toEqual([]);
    expect(store.isDirty()).toBe(false);
  });

  it("clears the dirty flag when an edit is reverted by hand", () => {
    const store = new DraftPackStore(bundle());

    store.setFile("camera/default.json", { id: "camera.default", type: "camera", version: 2 });
    store.setFile("camera/default.json", { id: "camera.default", type: "camera", version: 1 });

    expect(store.isDirty()).toBe(false);
  });

  it("restores deletions through undo and discard", () => {
    const store = new DraftPackStore(bundle());

    store.deleteFile("camera/default.json");
    store.undo();
    expect(store.snapshot().files["camera/default.json"]).toBeDefined();
    expect(store.dirtyPaths()).toEqual([]);

    store.deleteFile("camera/default.json");
    store.discard();
    expect(store.dirtyPaths()).toEqual([]);
  });
});
