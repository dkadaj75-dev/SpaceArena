import { afterEach, describe, expect, it, vi } from "vitest";
import { InstancedMesh, MeshBuilder, NullEngine, Scene } from "@babylonjs/core";
import type { ConfigService, ModuleConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import { ModuleEditor, nextModuleId } from "./ModuleEditor.js";
import { AssetRegistry } from "../core/AssetRegistry.js";

const engines: NullEngine[] = [];

function moduleConfig(over: Partial<ModuleConfig> = {}): ModuleConfig {
  return {
    id: "module.laser-mk1",
    type: "module",
    version: 1,
    name: "Pulse Laser Mk I",
    family: "laser",
    level: 1,
    activation: { deployTime: 1.5, retractTime: 1 },
    fire: {
      mode: "held",
      range: 38,
      cycleTime: 0.4,
      damage: 7,
      damageType: "energy",
      requiresLineOfSight: true,
      projectile: null,
    },
    onFire: ["action.play-sound-laser"],
    ui: { icon: "[ICON: laser]", iconId: "laser", shortName: "Laser Mk1", label: "Laser" },
    price: 0,
    requiresLevel: 1,
    ...over,
  };
}

function fakeHost(modules: ModuleConfig[]): {
  host: EditorHost;
  replace: ReturnType<typeof vi.fn>;
} {
  const replace = vi.fn((config: ModuleConfig) => {
    const index = modules.findIndex((module) => module.id === config.id);
    if (index >= 0) modules[index] = config;
    else modules.push(config);
    return { ok: true as const, errors: [] };
  });
  const configService = {
    getAll: vi.fn((type: string) => type === "module" ? modules : []),
    replace,
  } as unknown as ConfigService;
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  return { host: { configService, scene, setArenaVisible: vi.fn() } as unknown as EditorHost, replace };
}

function click(panel: ModuleEditor, label: string): void {
  Array.from(panel.element.querySelectorAll("button")).find((button) => button.textContent === label)!.click();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("ModuleEditor", () => {
  it("allocates the first free custom module id", () => {
    expect(nextModuleId(["module.laser-mk1"])).toBe("module.custom-1");
    expect(nextModuleId(["module.custom-1", "module.custom-3"])).toBe("module.custom-2");
  });

  it("renders the full module schema through SchemaFormGen and shows the resolved icon", () => {
    const { host } = fakeHost([moduleConfig()]);
    const panel = new ModuleEditor(host, vi.fn());

    const family = panel.element.querySelector<HTMLSelectElement>('[name="family"]')!;
    expect(Array.from(family.options).map((option) => option.textContent)).toEqual([
      "laser", "kinetic", "missile", "shield", "boost", "utility",
      // The internal bay's families (2026-07-31) — the form is generated from
      // the schema, so they appear here the moment the enum grows.
      "engine", "generator", "transformer", "countermeasure", "sensors",
    ]);
    expect(panel.element.querySelector('[name="fire.mode"]')).not.toBeNull();
    // Cycle time is what a weapon is authored in (heat deleted 2026-08-20).
    expect(panel.element.querySelector('[name="fire.cycleTime"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="fire.damage"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="ui.icon"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="ui.iconId"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="ui.shortName"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="price"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="requiresLevel"]')).not.toBeNull();
    expect(panel.element.querySelector<HTMLElement>(".ed-module-icon-preview")!.dataset.iconId).toBe("laser");
    expect(panel.element.querySelector<HTMLElement>(".ed-module-preview-status")!.dataset.previewKind).toBe("placeholder");
    panel.dispose();
  });

  it("live-replaces schema edits and updates the icon preview", async () => {
    const modules = [moduleConfig({ ui: { icon: "[ICON: laser]", shortName: "Laser Mk1", label: "Laser" } })];
    const { host, replace } = fakeHost(modules);
    const panel = new ModuleEditor(host, vi.fn());
    const icon = panel.element.querySelector<HTMLInputElement>('[name="ui.icon"]')!;
    icon.value = "[ICON: shield]";
    icon.dispatchEvent(new Event("change"));
    await Promise.resolve();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(modules[0]!.ui.icon).toBe("[ICON: shield]");
    expect(panel.element.querySelector<HTMLElement>(".ed-module-icon-preview")!.dataset.iconId).toBe("shield");
    panel.dispose();
  });

  it("creates and duplicates the selection with collision-free ids", () => {
    const modules = [moduleConfig()];
    const { host } = fakeHost(modules);
    const panel = new ModuleEditor(host, vi.fn());

    click(panel, "New module");
    expect(modules[1]).toMatchObject({ id: "module.custom-1", name: "module.custom-1" });
    click(panel, "Duplicate");
    expect(modules[2]).toMatchObject({ id: "module.custom-2", name: "module.custom-1 Copy" });
    panel.dispose();
  });

  it("saves the selected module to its contentPathFor path", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = moduleConfig();
    const { host } = fakeHost([config]);
    const panel = new ModuleEditor(host, vi.fn());

    click(panel, "Save to disk");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/__editor/save");
    expect(JSON.parse(init?.body as string)).toEqual({
      path: "modules/laser-mk1.json",
      json: config,
    });
    panel.dispose();
  });

  it("shows the recipe immediately, then swaps to the ensured GLB master", async () => {
    const config = moduleConfig({
      render: {
        recipe: "procedural.module.laser",
        model: "modules/laser.glb",
        modelScale: 1.2,
        modelRotationY: 0.4,
      },
    });
    const { host } = fakeHost([config]);
    const modelMaster = MeshBuilder.CreateBox("master.model.modules/laser.glb", { size: 1 }, host.scene);
    modelMaster.setEnabled(false);
    vi.spyOn(AssetRegistry.prototype, "ensureModel").mockResolvedValue(modelMaster);

    const panel = new ModuleEditor(host, vi.fn());
    expect(panel.element.querySelector<HTMLElement>(".ed-module-preview-status")!.textContent).toContain("loading modules/laser.glb");
    await vi.waitFor(() =>
      expect(panel.element.querySelector<HTMLElement>(".ed-module-preview-status")!.dataset.previewKind).toBe("model"),
    );
    const preview = host.scene.getMeshByName(`modulePreview.${config.id}`);
    expect(preview).toBeInstanceOf(InstancedMesh);
    expect((preview as InstancedMesh).sourceMesh).toBe(modelMaster);
    panel.dispose();
  });
});
