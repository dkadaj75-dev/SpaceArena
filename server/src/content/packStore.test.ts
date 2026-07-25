import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBundle, setGlobalLogLevel, type ContentBundle } from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { ContentPackStore, describeSwapError, exportBundleFrom, hashDirectory, renameWithRetry } from "./packStore.js";

setGlobalLogLevel("error");

/**
 * Minimal but fully valid pack: one asteroid, one arena that references it.
 * `radius` is the knob every test twists — it is the cheapest observable
 * difference between "old pack" and "new pack".
 */
function pack(radius: number, extraArena?: { id: string; radius: number }): { manifest: unknown; files: Record<string, unknown> } {
  const files: Record<string, unknown> = {
    "asteroids/rock.json": {
      id: "asteroid.rock",
      type: "asteroid",
      version: 1,
      name: "Rock",
      radius: 4,
      hp: 100,
      destructible: true,
      impactDamage: 5,
      render: { recipe: "procedural.rock-small" },
    },
    "arenas/base.json": arena("arena.base", "Base Arena", radius),
  };
  const list = ["asteroids/rock.json", "arenas/base.json"];
  if (extraArena) {
    files[`arenas/${extraArena.id.split(".")[1]}.json`] = arena(extraArena.id, "Extra", extraArena.radius);
    list.push(`arenas/${extraArena.id.split(".")[1]}.json`);
  }
  return {
    manifest: { id: "manifest.test", type: "manifest", version: radius, name: "Test Pack", files: list },
    files,
  };
}

function arena(id: string, name: string, radius: number): unknown {
  return {
    id,
    type: "arena",
    version: 1,
    name,
    bounds: { shape: "circle", radius },
    asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 0, z: 0 } }],
    spawnPoints: [
      { id: "sp-a", team: 0, position: { x: -20, z: -20 }, heading: 0 },
      { id: "sp-b", team: 1, position: { x: 20, z: 20 }, heading: 3.14 },
    ],
  };
}

async function bundleOf(radius: number, extraArena?: { id: string; radius: number }): Promise<ContentBundle> {
  const { manifest, files } = pack(radius, extraArena);
  return buildBundle(manifest, files);
}

/** Materialize a pack directly on disk, bypassing the store (the "before" state). */
async function seedDir(dir: string, radius: number): Promise<void> {
  const { manifest, files } = pack(radius);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [rel, json] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, JSON.stringify(json, null, 2), "utf8");
  }
}

let root: string;
let contentDir: string;
let store: ContentPackStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sa-pack-"));
  contentDir = path.join(root, "content");
  await seedDir(contentDir, 50);
  store = new ContentPackStore(contentDir);
  await store.reload();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ContentPackStore — export", () => {
  it("exports exactly what the manifest lists", async () => {
    const bundle = await store.exportBundle();
    expect(bundle.packId).toBe("manifest.test");
    expect(Object.keys(bundle.files).sort()).toEqual(["arenas/base.json", "asteroids/rock.json"]);
    expect(bundle.sourceHash).toMatch(/^sha256:/);
  });

  it("ignores stray files that the manifest does not list", async () => {
    await writeFile(path.join(contentDir, "arenas", "stray.json"), '{"id":"nope"}', "utf8");
    const bundle = await exportBundleFrom(contentDir);
    expect(Object.keys(bundle.files)).not.toContain("arenas/stray.json");
  });

  it("round-trips: export → import → export produces the same source hash", async () => {
    const before = await store.exportBundle();
    const result = await store.importBundle(before);
    expect(result.ok).toBe(true);
    const after = await store.exportBundle();
    expect(after.sourceHash).toBe(before.sourceHash);
  });
});

describe("ContentPackStore — import + atomic swap", () => {
  it("replaces the live directory and reloads the ConfigService", async () => {
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });

    const result = await store.importBundle(await bundleOf(120, { id: "arena.proof", radius: 33 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toBe(3);
    expect(result.counts).toEqual({ asteroid: 1, arena: 2 });

    // On disk…
    const onDisk = JSON.parse(await readFile(path.join(contentDir, "arenas", "base.json"), "utf8")) as {
      bounds: { radius: number };
    };
    expect(onDisk.bounds.radius).toBe(120);
    // …and in the running server's registry, with no restart.
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 120 } });
    expect(getConfigService().get("arena", "arena.proof")).toMatchObject({ bounds: { radius: 33 } });
  });

  it("keeps the replaced pack as content.previous for one-step rollback", async () => {
    await store.importBundle(await bundleOf(120));
    expect(await store.hasPrevious()).toBe(true);
    const previous = JSON.parse(await readFile(path.join(store.previousDir, "arenas", "base.json"), "utf8")) as {
      bounds: { radius: number };
    };
    expect(previous.bounds.radius).toBe(50);
  });

  it("leaves no staging directories behind", async () => {
    await store.importBundle(await bundleOf(120));
    const entries = await readdir(root);
    expect(entries.filter((e) => e.includes(".staging-"))).toEqual([]);
    expect(entries.sort()).toEqual(["content", "content.previous"]);
  });

  it("prunes files the new manifest drops", async () => {
    await store.importBundle(await bundleOf(120, { id: "arena.proof", radius: 33 }));
    expect(await exists(path.join(contentDir, "arenas", "proof.json"))).toBe(true);
    // Re-import without the extra arena: the swap replaces the whole tree, so the
    // dropped file is gone rather than lingering as an orphan.
    await store.importBundle(await bundleOf(130));
    expect(await exists(path.join(contentDir, "arenas", "proof.json"))).toBe(false);
  });

  it("writes nothing when validation fails", async () => {
    const before = await hashDirectory(contentDir);

    const broken = await bundleOf(120);
    (broken.files["arenas/base.json"] as { bounds: { radius: number } }).bounds.radius = -1;

    const result = await store.importBundle(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("validation");
    expect(result.errors[0]?.file).toBe("arenas/base.json");

    expect(await hashDirectory(contentDir)).toBe(before);
    expect(await store.hasPrevious()).toBe(false);
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });
  });

  it("refuses a dangling reference without touching disk", async () => {
    const before = await hashDirectory(contentDir);
    const broken = await bundleOf(120);
    (broken.files["arenas/base.json"] as { asteroidPlacements: unknown[] }).asteroidPlacements = [
      { asteroidId: "asteroid.ghost", position: { x: 0, z: 0 } },
    ];
    const result = await store.importBundle(broken);
    expect(result.ok).toBe(false);
    expect(await hashDirectory(contentDir)).toBe(before);
  });

  it("serializes concurrent imports instead of racing on the same paths", async () => {
    const [a, b] = await Promise.all([store.importBundle(await bundleOf(111)), store.importBundle(await bundleOf(222))]);
    expect(a.ok && b.ok).toBe(true);
    // Whichever landed second is what is live — but the directory is coherent
    // either way, and no staging leftovers exist.
    const live = (await exportBundleFrom(contentDir)).files["arenas/base.json"] as { bounds: { radius: number } };
    expect([111, 222]).toContain(live.bounds.radius);
    expect((await readdir(root)).filter((e) => e.includes(".staging-"))).toEqual([]);
  });
});

describe("ContentPackStore — rollback", () => {
  it("restores the previous pack and reloads", async () => {
    await store.importBundle(await bundleOf(120, { id: "arena.proof", radius: 33 }));
    expect(getConfigService().get("arena", "arena.proof")).toBeDefined();

    const result = await store.rollback();
    expect(result.ok).toBe(true);

    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });
    expect(getConfigService().get("arena", "arena.proof")).toBeUndefined();
    expect(await exists(path.join(contentDir, "arenas", "proof.json"))).toBe(false);
  });

  it("is itself undoable — rollback twice returns to the imported pack", async () => {
    await store.importBundle(await bundleOf(120));
    await store.rollback();
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });

    const again = await store.rollback();
    expect(again.ok).toBe(true);
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 120 } });
  });

  it("fails cleanly when there is nothing to roll back to", async () => {
    const result = await store.rollback();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toMatch(/no previous content pack/);
    // The live pack is untouched.
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });
  });
});

describe("ContentPackStore — failure handling", () => {
  it("restores the live pack when the second rename fails mid-swap", async () => {
    const before = await hashDirectory(contentDir);

    // Fail the *second* rename — the one that makes the staged pack live. That is
    // the only moment at which no content directory exists, so it is the moment
    // the rollback has to work.
    let calls = 0;
    const flaky = new ContentPackStore(contentDir, {
      rename: async (from, to) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
        await renameWithRetry(from, to);
      },
    });

    const result = await flaky.importBundle(await bundleOf(120));
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("swap");
    expect(result.errors[0]?.message).toMatch(/handle inside the content directory is held open/);

    // The old pack is back, byte for byte, and still loads.
    expect(await hashDirectory(contentDir)).toBe(before);
    expect(await exists(flaky.previousDir)).toBe(false);
    expect((await readdir(root)).filter((e) => e.includes(".staging-"))).toEqual([]);
    await store.reload();
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });
  });

  it("explains the Windows open-handle case for every transient errno", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]) {
      const message = describeSwapError(Object.assign(new Error("rename failed"), { code }));
      expect(message).toContain(code);
      expect(message).toMatch(/previous pack is still live/);
      expect(message).toMatch(/handle inside the content directory is held open/);
    }
    // A non-transient failure gets the plain message, not the Windows advice.
    const other = describeSwapError(Object.assign(new Error("disk on fire"), { code: "EIO" }));
    expect(other).not.toMatch(/held open/);
  });

  it("retries a transient rename failure rather than giving up", async () => {
    const from = path.join(root, "retry-src");
    const to = path.join(root, "retry-dst");
    await mkdir(from, { recursive: true });
    // A pre-existing non-empty directory at the destination makes rename() fail
    // with ENOTEMPTY/EEXIST/EPERM depending on platform — all of which are in the
    // transient set, so this exercises the retry loop end to end and then fails.
    await mkdir(path.join(to, "child"), { recursive: true });
    await writeFile(path.join(to, "child", "f.json"), "{}", "utf8");
    const started = Date.now();
    await expect(renameWithRetry(from, to, 2)).rejects.toThrow();
    // Three attempts with 120 ms + 240 ms of backoff between them.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });
});

describe("ContentPackStore — pack info", () => {
  it("reports the live pack and refreshes after an import", async () => {
    const before = await store.packInfo();
    expect(before.packId).toBe("manifest.test");
    expect(before.files).toBe(2);
    expect(before.rollbackAvailable).toBe(false);

    await store.importBundle(await bundleOf(120, { id: "arena.proof", radius: 33 }));
    const after = await store.packInfo();
    expect(after.files).toBe(3);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.rollbackAvailable).toBe(true);
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
