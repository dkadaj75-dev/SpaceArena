import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBundle } from "@space-arena/shared";
import { repoSaveAvailable, saveDraftToRepo } from "./saveToRepo.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const notification = { id: "notification.overheat", type: "notification", version: 1, text: "Hot", style: "info", durationMs: 500 };
const camera = { id: "camera.default", type: "camera", version: 1 };

/** A draft whose dirty set includes one edited config and one deleted one. */
function draft(files: Record<string, unknown>, dirty: string[]): { dirtyPaths(): string[]; snapshot(): ContentBundle } {
  return {
    dirtyPaths: () => dirty,
    snapshot: () => ({ files, manifest: { files: Object.keys(files) } }) as unknown as ContentBundle,
  };
}

describe("saveDraftToRepo", () => {
  it("saves present files and deletes absent ones, one request per dirty path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await saveDraftToRepo(draft(
      { "notifications/overheat.json": notification },
      ["camera/default.json", "notifications/overheat.json"],
    ));

    expect(summary).toMatchObject({ saved: 2, failed: 0 });
    expect(summary.results.map((r) => [r.kind, r.path])).toEqual([
      ["delete", "camera/default.json"],
      ["save", "notifications/overheat.json"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [deleteCall, saveCall] = fetchMock.mock.calls as unknown as [[string, RequestInit], [string, RequestInit]];
    expect(deleteCall[0]).toBe("/__editor/delete");
    expect(JSON.parse(deleteCall[1].body as string)).toEqual({ path: "camera/default.json" });
    expect(saveCall[0]).toBe("/__editor/save");
    expect(JSON.parse(saveCall[1].body as string)).toEqual({ path: "notifications/overheat.json", json: notification });
  });

  it("addresses a saved config by the path its own id implies, not the draft key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // The draft still keys the file by its pre-rename path.
    await saveDraftToRepo(draft({ "cameras/old-name.json": camera }, ["cameras/old-name.json"]));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).path).toBe("camera/default.json");
  });

  it("reports each failure separately and keeps the successes", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/__editor/save" ? new Response("id must look like `type.slug`", { status: 400 }) : new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await saveDraftToRepo(draft(
      { "notifications/overheat.json": notification },
      ["camera/default.json", "notifications/overheat.json"],
    ));

    expect(summary).toMatchObject({ saved: 1, failed: 1 });
    expect(summary.results.find((r) => !r.ok)).toMatchObject({
      path: "notifications/overheat.json",
      kind: "save",
      error: expect.stringContaining("type.slug"),
    });
  });

  it("turns a rejected fetch into a per-file error rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("dev server disconnected"))));

    const summary = await saveDraftToRepo(draft({ "camera/default.json": camera }, ["camera/default.json"]));

    expect(summary).toMatchObject({ saved: 0, failed: 1 });
    expect(summary.results[0]!.error).toContain("dev server disconnected");
  });

  it("does nothing when the draft is clean", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await saveDraftToRepo(draft({ "camera/default.json": camera }, []))).toEqual({ results: [], saved: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("repoSaveAvailable", () => {
  it("is true only when the dev editor middleware answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));
    await expect(repoSaveAvailable()).resolves.toBe(true);

    // A production build has no /__editor route: the SPA fallback answers with HTML.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { status: 200 })));
    await expect(repoSaveAvailable()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(repoSaveAvailable()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    await expect(repoSaveAvailable()).resolves.toBe(false);
  });
});
