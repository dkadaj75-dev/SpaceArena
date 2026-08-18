import { type AbstractMesh, type InstancedMesh, type Observer, type Scene } from "@babylonjs/core";
import { hardpointsOf, type ModuleConfig, type ShipConfig } from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { ShipManager } from "./ShipManager.js";

const HULL_PREFIX = "shipPreviewHull.";

/**
 * ShipManager decorator that keeps the existing socket-marker editor intact
 * while adding the default fitting's physical hardware and its visibility
 * toggle. Kept separate so the mounting layer cannot interfere with gizmos.
 */
export class ShipManagerModules implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly manager: ShipManager;
  private readonly assets: AssetRegistry;
  private readonly toggle = document.createElement("button");
  private readonly mounted: InstancedMesh[] = [];
  private hull: AbstractMesh | null = null;
  private showFittedModules = true;
  private revision = 0;
  private readonly beforeRender: Observer<Scene>;
  private readonly unsubscribeConfig: () => void;

  constructor(
    private readonly host: EditorHost,
    report: (message: string | null) => void,
  ) {
    this.manager = new ShipManager(host, report);
    this.assets = new AssetRegistry(host.scene);

    this.toggle.type = "button";
    this.toggle.className = "ed-btn ed-ship-fitted-toggle is-active";
    this.toggle.textContent = "Show fitted modules";
    this.toggle.setAttribute("aria-pressed", "true");
    this.toggle.addEventListener("click", () => {
      this.showFittedModules = !this.showFittedModules;
      this.toggle.classList.toggle("is-active", this.showFittedModules);
      this.toggle.setAttribute("aria-pressed", String(this.showFittedModules));
      this.sync(true);
    });

    const controls = document.createElement("div");
    controls.className = "ed-toolbar";
    controls.append(this.toggle);
    this.element.append(controls, this.manager.element);

    this.beforeRender = host.scene.onBeforeRenderObservable.add(() => this.sync(false));
    this.unsubscribeConfig = host.bus.on("config:changed", () => this.sync(true));
    this.sync(true);
  }

  private previewHull(): AbstractMesh | null {
    return this.host.scene.meshes.find((mesh) => !mesh.isDisposed() && mesh.name.startsWith(HULL_PREFIX)) ?? null;
  }

  private sync(force: boolean): void {
    const nextHull = this.previewHull();
    if (!force && nextHull === this.hull) return;
    this.hull = nextHull;
    const revision = ++this.revision;
    for (const mesh of this.mounted) mesh.dispose();
    this.mounted.length = 0;
    if (!this.showFittedModules || !nextHull) return;

    const shipId = nextHull.name.slice(HULL_PREFIX.length);
    const ship = this.host.configService.get<ShipConfig>("ship", shipId);
    if (!ship) return;
    const accent = ship.render.palette?.accent ?? ship.render.palette?.primary;
    const fallbackPalette: Record<string, string> = accent ? { primary: accent } : {};

    hardpointsOf(ship).forEach((socket, hardpointIndex) => {
      const moduleId = ship.defaultFitting[hardpointIndex];
      const module = moduleId ? this.host.configService.get<ModuleConfig>("module", moduleId) : undefined;
      if (!module) return;

      const master = this.assets.getModuleMaster(module, fallbackPalette);
      const mesh = master.createInstance(`shipPreviewModule.${socket.id}`);
      mesh.parent = nextHull;
      mesh.position.set(socket.transform.pos[0], socket.transform.pos[1], socket.transform.pos[2]);
      const rot = socket.transform.rot ?? [0, 0, 0];
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      mesh.scaling.setAll(socket.transform.scale ?? 1);
      mesh.isPickable = false;
      this.mounted.push(mesh);

      if (module.render?.model) {
        void this.assets.ensureModel(module.render).then((modelMaster) => {
          if (revision !== this.revision || !modelMaster || modelMaster === master) return;
          this.sync(true);
        });
      }
    });
  }

  dispose(): void {
    this.revision++;
    this.unsubscribeConfig();
    this.host.scene.onBeforeRenderObservable.remove(this.beforeRender);
    for (const mesh of this.mounted) mesh.dispose();
    this.mounted.length = 0;
    this.manager.dispose();
    this.assets.dispose();
    this.element.replaceChildren();
  }
}
