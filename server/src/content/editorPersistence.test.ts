import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "@space-arena/shared";
import { persistEditorConfig, removeEditorConfig } from "@space-arena/shared/editor-persistence";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function contentDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "space-arena-editor-save-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "notifications"));
  await writeFile(
    path.join(dir, "notifications", "existing.json"),
    JSON.stringify({
      id: "notification.existing",
      type: "notification",
      version: 1,
      text: "Existing",
      style: "info",
      durationMs: 500,
    }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "manifest.test",
      type: "manifest",
      version: 1,
      name: "Test",
      files: ["notifications/existing.json"],
    }),
    "utf8",
  );
  return dir;
}

describe("persistEditorConfig", () => {
  it("creates the type directory, writes a new config, and manifests it for reload", async () => {
    const dir = await contentDir();
    const config = {
      id: "notification.custom-1",
      type: "notification",
      version: 1,
      text: "Saved",
      style: "info",
      durationMs: 500,
    };

    const result = await persistEditorConfig(dir, {
      path: "notifications/custom-1.json",
      json: config,
    });

    expect(result).toEqual({ path: "notifications/custom-1.json", addedToManifest: true });
    expect(JSON.parse(await readFile(path.join(dir, result.path), "utf8"))).toEqual(config);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toContain(result.path);

    const reloaded = new ConfigService(async (relative) =>
      JSON.parse(await readFile(path.join(dir, relative), "utf8")) as unknown);
    expect((await reloaded.load("manifest.json")).ok).toBe(true);
    expect(reloaded.get("notification", config.id)).toMatchObject({ text: "Saved" });
  });

  it("does not duplicate an existing manifest entry", async () => {
    const dir = await contentDir();
    await mkdir(path.join(dir, "camera"));
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ id: "manifest.test", type: "manifest", version: 1, files: ["camera/default.json"] }),
      "utf8",
    );
    const config = {
      id: "camera.default",
      type: "camera",
      version: 1,
      alpha: { min: -3, max: 3, default: 0 },
      beta: { min: 0.1, max: 1.5, default: 0.8 },
      radius: { min: 5, max: 100, default: 40 },
      followLag: 0.2,
      pan: { sensitivity: 1, limitRatio: 0.5 },
    };

    const result = await persistEditorConfig(dir, { path: "camera/default.json", json: config });
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { files: string[] };

    expect(result.addedToManifest).toBe(false);
    expect(manifest.files).toEqual(["camera/default.json"]);
  });

  it("rejects a path that does not canonically belong to the config", async () => {
    const dir = await contentDir();
    await expect(
      persistEditorConfig(dir, {
        path: "ships/interceptor.json",
        json: {
          id: "notification.custom-1",
          type: "notification",
          version: 1,
          text: "Wrong target",
          style: "info",
          durationMs: 500,
        },
      }),
    ).rejects.toThrow(/path must be notifications\/custom-1\.json/);
  });
});

describe("removeEditorConfig", () => {
  it("deletes the file and demanifests it so the deletion survives a reload", async () => {
    const dir = await contentDir();
    // A survivor, so the reload below exercises a manifest that still has content.
    const keeper = { id: "notification.keeper", type: "notification", version: 1, text: "Kept", style: "info", durationMs: 500 };
    await persistEditorConfig(dir, { path: "notifications/keeper.json", json: keeper });

    const result = await removeEditorConfig(dir, { path: "notifications/existing.json" });

    expect(result).toEqual({ path: "notifications/existing.json", existed: true, removedFromManifest: true });
    await expect(access(path.join(dir, "notifications", "existing.json"))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toEqual(["notifications/keeper.json"]);

    const reloaded = new ConfigService(async (relative) =>
      JSON.parse(await readFile(path.join(dir, relative), "utf8")) as unknown);
    expect((await reloaded.load("manifest.json")).ok).toBe(true);
    expect(reloaded.get("notification", "notification.existing")).toBeUndefined();
    expect(reloaded.get("notification", "notification.keeper")).toMatchObject({ text: "Kept" });
  });

  it("still reconciles the manifest when the file is already gone", async () => {
    const dir = await contentDir();
    await rm(path.join(dir, "notifications", "existing.json"));

    const result = await removeEditorConfig(dir, { path: "notifications/existing.json" });

    expect(result).toEqual({ path: "notifications/existing.json", existed: false, removedFromManifest: true });
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toEqual([]);
  });

  it("leaves an untracked-but-valid path's manifest alone", async () => {
    const dir = await contentDir();
    await mkdir(path.join(dir, "camera"));
    await writeFile(path.join(dir, "camera", "spare.json"), "{}", "utf8");

    const result = await removeEditorConfig(dir, { path: "camera/spare.json" });

    expect(result).toEqual({ path: "camera/spare.json", existed: true, removedFromManifest: false });
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toEqual(["notifications/existing.json"]);
  });

  it("refuses anything that is not a config file under a known content folder", async () => {
    const dir = await contentDir();
    for (const bad of ["../secrets.json", "manifest.json", "notifications/../../escape.json", "ships/hull.glb", "unknown/thing.json"]) {
      await expect(removeEditorConfig(dir, { path: bad })).rejects.toThrow(/not a content config path|invalid content path/);
    }
    // The one file that existed is untouched by every rejected request.
    await expect(access(path.join(dir, "notifications", "existing.json"))).resolves.toBeUndefined();
  });
});
