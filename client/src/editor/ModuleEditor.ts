import { TransformNode, Vector3, type InstancedMesh, type Mesh } from "@babylonjs/core";
import { moduleSchema, type ModuleConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { applicationNotice } from "./applicationScope.js";
import { moduleIconId, moduleIconSvg } from "../game/hud/moduleIcons.js";
import { AssetRegistry, moduleRenderRecipe } from "../core/AssetRegistry.js";
import { EditorStage } from "./EditorStage.js";
import { FieldFilter, filterTree } from "./fieldFilter.js";
import "./ModuleEditor.css";

/** First free `module.custom-N` id shared by New and Duplicate. */
export function nextModuleId(existing: readonly string[]): string {
  let n = 1;
  while (existing.includes(`module.custom-${n}`)) n++;
  return `module.custom-${n}`;
}

/**
 * Schema-driven module authoring panel. The picker/clone actions are bespoke;
 * every config field is rendered by SchemaFormGen from `moduleSchema`.
 */
export class ModuleEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<ModuleConfig> | null = null;
  private readonly iconPreview = document.createElement("div");
  private readonly previewRoot: TransformNode;
  private readonly assets: AssetRegistry;
  private readonly stage: EditorStage;
  private previewMesh: InstancedMesh | null = null;
  private previewRevision = 0;
  private pendingModelApply: Promise<void> | null = null;
  private readonly previewStatus = document.createElement("div");
  /**
   * The tallest panel in the suite — 21 sections and 82 inputs, 1826px of form
   * in a 276px window, with a 58-entry dropdown as the only way through it.
   * Built once and re-appended by render(), so the query survives a module
   * switch and the box does not lose focus mid-word.
   */
  private readonly search = new FieldFilter({
    placeholder: "e.g. damage, cooldownMs",
    onQuery: (query) => { if (this.form) filterTree(this.form.element, query, { openGroups: true }); },
  });

  constructor(
    private readonly host: EditorHost,
    private readonly report: (message: string | null) => void,
  ) {
    this.previewRoot = new TransformNode("editorModulePreview", host.scene);
    this.assets = new AssetRegistry(host.scene);
    this.stage = new EditorStage(host.scene);
    host.setArenaVisible(false);
    this.stage.setEnabled(true);
    this.selectedId = host.configService.getAll<ModuleConfig>("module")[0]?.id ?? null;
    this.iconPreview.className = "ed-module-icon-preview";
    this.iconPreview.setAttribute("aria-label", "Resolved module icon preview");
    this.previewStatus.className = "ed-hint ed-module-preview-status";
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.host.configService.getAll<ModuleConfig>("module");
    const toolbar = document.createElement("div");
    toolbar.className = "ed-toolbar";
    const title = document.createElement("span");
    title.className = "ed-label";
    title.textContent = "Module";
    const select = document.createElement("select");
    select.className = "ed-select";
    for (const config of configs) {
      select.append(new Option(config.name ?? config.id, config.id, false, config.id === this.selectedId));
    }
    select.addEventListener("change", () => {
      this.selectedId = select.value;
      this.render();
    });
    const add = this.button("New module", () => this.cloneSelected(configs, false));
    const duplicate = this.button("Duplicate", () => this.cloneSelected(configs, true));
    const save = this.button("Save to disk", () => void this.save(), "ed-btn--primary");
    toolbar.append(title, select, add, duplicate, save, this.search.element);
    this.element.append(toolbar, applicationNotice("module"));

    const selected = configs.find((config) => config.id === this.selectedId);
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = "No module configs loaded.";
      this.element.append(empty);
      return;
    }
    this.form = new SchemaFormGen<ModuleConfig>({
      schema: moduleSchema,
      value: selected,
      configService: this.host.configService,
      onProblem: (problem) => this.report(problem ? `${selected.id} ${problem.path}: ${problem.message}` : null),
      onSaved: (value) => {
        this.updateIconPreview(value);
        this.applyPreview(value);
        queueMicrotask(() => this.mountIconPreview());
      },
    });
    this.updateIconPreview(selected);
    this.element.append(this.previewStatus, this.form.element);
    this.search.watch(this.form.element);
    this.mountIconPreview();
    this.applyPreview(selected);
  }

  private cloneSelected(configs: ModuleConfig[], duplicate: boolean): void {
    const template = configs.find((config) => config.id === this.selectedId) ?? configs[0];
    if (!template) {
      this.report("Cannot create a module: no template loaded.");
      return;
    }
    const id = nextModuleId(configs.map((config) => config.id));
    const clone: ModuleConfig = {
      ...structuredClone(template),
      id,
      name: duplicate ? `${template.name} Copy` : id,
    };
    const result = this.host.configService.replace(clone);
    if (!result.ok) {
      this.report(result.errors.map((error) => error.message).join("; "));
      return;
    }
    this.selectedId = id;
    this.render();
  }

  private updateIconPreview(config: ModuleConfig): void {
    const id = moduleIconId(config);
    this.iconPreview.dataset.iconId = id;
    this.iconPreview.innerHTML = moduleIconSvg(id);
  }

  /**
   * Swap the staged module immediately. The recipe stays visible while a GLB
   * loads, and the revision guard prevents an older path from winning a race.
   */
  private applyPreview(config: ModuleConfig): void {
    const revision = ++this.previewRevision;
    const render = moduleRenderRecipe(config);
    this.showPreviewMaster(
      this.assets.getModuleMaster(config),
      config,
      render.model ? `loading ${render.model}` : `placeholder ${render.recipe}`,
    );
    if (!render.model) {
      this.pendingModelApply = null;
      return;
    }

    const pending = this.assets.ensureModel(render).then((master) => {
      if (revision !== this.previewRevision || config.id !== this.selectedId) return;
      if (!master) {
        this.previewStatus.textContent = `3D preview: fallback ${render.recipe}`;
        this.previewStatus.dataset.previewKind = "fallback";
        this.report(`${config.id}: model "${render.model}" failed to load — check the path (content-relative).`);
        return;
      }
      this.showPreviewMaster(master, config, `GLB ${render.model}`);
      this.report(null);
    });
    this.pendingModelApply = pending;
    void pending.finally(() => {
      if (this.pendingModelApply === pending) this.pendingModelApply = null;
    });
  }

  private showPreviewMaster(master: Mesh, config: ModuleConfig, label: string): void {
    this.previewMesh?.dispose();
    const mesh = master.createInstance(`modulePreview.${config.id}`);
    mesh.parent = this.previewRoot;
    mesh.position.setAll(0);
    mesh.rotation.setAll(0);
    mesh.scaling.setAll(1);
    mesh.isPickable = false;
    this.previewMesh = mesh;
    this.previewStatus.textContent = `3D preview: ${label}`;
    this.previewStatus.dataset.previewKind = label.startsWith("GLB ") ? "model" : "placeholder";
    this.focusCamera(mesh);
  }

  /** Frame the module itself in the shell's shared orbitable editor stage. */
  private focusCamera(mesh: InstancedMesh): void {
    const camera = this.host.scene.activeCamera as unknown as {
      setTarget?: (target: Vector3) => void;
      radius?: number;
      beta?: number;
    };
    camera?.setTarget?.(Vector3.Zero());
    if (camera && typeof camera.radius === "number") {
      mesh.computeWorldMatrix(true);
      camera.radius = Math.max(2.5, mesh.getBoundingInfo().boundingSphere.radiusWorld * 4);
      camera.beta = 1.1;
    }
  }

  /** Keep the preview physically beside the generic `ui` group after each form re-render. */
  private mountIconPreview(): void {
    const groups = this.form?.element.querySelectorAll<HTMLDetailsElement>("details.ed-group") ?? [];
    for (const group of groups) {
      const summary = group.firstElementChild;
      if (!(summary instanceof HTMLElement) || summary.tagName !== "SUMMARY" || summary.textContent !== "ui") continue;
      group.classList.add("ed-module-ui-group");
      summary.after(this.iconPreview);
      return;
    }
  }

  private button(label: string, action: () => void, extraClass = ""): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ed-btn ${extraClass}`.trim();
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  async save(): Promise<void> {
    if (this.pendingModelApply) await this.pendingModelApply;
    if (!this.form) return;
    const error = await saveConfig(this.form.getValue());
    if (error) this.report(error);
  }

  dispose(): void {
    this.search.dispose();
    this.previewRevision++;
    this.previewMesh?.dispose();
    this.previewMesh = null;
    this.previewRoot.dispose(false, true);
    this.assets.dispose();
    this.stage.dispose();
    this.element.replaceChildren();
  }
}
