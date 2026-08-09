import { CONFIG_SCHEMAS, CONFIG_TYPES, ConfigService, bundleLoader, type AnyConfig, type ConfigError, type ConfigType, type ContentBundle } from "@space-arena/shared";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { applicationNotice } from "./applicationScope.js";
import type { DraftPackStore } from "./DraftPackStore.js";
import { PANEL_REGISTRY, registeredContentPath } from "./panelRegistry.js";

export class GenericConfigPanel {
  readonly element = document.createElement("section");
  private type: ConfigType = CONFIG_TYPES[0]!;
  private selectedPath = "";

  constructor(private readonly draft: DraftPackStore, private readonly onProblems: (errors: ConfigError[]) => void) {
    this.element.className = "constellation-catalog";
    this.render();
  }

  render(): void {
    const bundle = this.draft.snapshot();
    const configs = entriesOf(bundle, this.type);
    if (!configs.some(([path]) => path === this.selectedPath)) this.selectedPath = configs[0]?.[0] ?? "";

    const nav = document.createElement("nav"); nav.className = "constellation-types"; nav.setAttribute("aria-label", "Configuration types");
    for (const type of CONFIG_TYPES) {
      const button = document.createElement("button"); button.type = "button"; button.className = "ed-tab";
      button.classList.toggle("is-active", type === this.type); button.textContent = PANEL_REGISTRY[type].label;
      button.addEventListener("click", () => { this.type = type; this.selectedPath = ""; this.render(); }); nav.append(button);
    }

    const sidebar = document.createElement("aside"); sidebar.className = "constellation-list";
    const heading = document.createElement("h2"); heading.textContent = `${PANEL_REGISTRY[this.type].label} (${configs.length})`; sidebar.append(heading);
    for (const [path, config] of configs) {
      const button = document.createElement("button"); button.type = "button"; button.className = "constellation-item";
      button.classList.toggle("is-active", path === this.selectedPath); button.textContent = config.id;
      button.addEventListener("click", () => { this.selectedPath = path; this.render(); }); sidebar.append(button);
    }
    const create = document.createElement("button"); create.type = "button"; create.className = "ed-btn"; create.textContent = "Duplicate selected";
    create.disabled = !this.selectedPath;
    create.addEventListener("click", () => this.duplicate()); sidebar.append(create);

    const editor = document.createElement("main"); editor.className = "constellation-form";
    const selected = configs.find(([path]) => path === this.selectedPath);
    if (selected) this.renderEditor(editor, bundle, selected[0], selected[1]);
    else { const empty = document.createElement("p"); empty.className = "ed-empty"; empty.textContent = "This pack has no config of this type. Duplicate requires a source config."; editor.append(empty); }
    this.element.replaceChildren(nav, sidebar, editor);
  }

  private renderEditor(target: HTMLElement, bundle: ContentBundle, path: string, config: AnyConfig): void {
    const head = document.createElement("div"); head.className = "constellation-config-head";
    const title = document.createElement("h2"); title.textContent = config.id;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ed-btn ed-btn--danger"; remove.textContent = "Delete";
    remove.addEventListener("click", () => this.confirmDelete(path, config.id)); head.append(title, remove);
    const deployed = document.createElement("p"); deployed.className = "constellation-asset-note";
    deployed.textContent = "Asset fields edit references to already deployed assets. Binary upload is not available in Phase 0.";
    const preview = document.createElement("p"); preview.className = "constellation-preview"; preview.textContent = PANEL_REGISTRY[this.type].preview;
    const service = new ConfigService(bundleLoader(bundle));
    void service.load("manifest.json").then(() => {
      const form = new SchemaFormGen({
        schema: CONFIG_SCHEMAS[this.type], value: config, configService: service,
        allowPackInvalid: true,
        onProblems: (problems) => this.onProblems(problems.map((problem) => ({ file: path, ...problem }))),
        onSaved: (value) => { this.draft.setFile(path, value); void this.preflight(); },
      });
      target.append(head, deployed, preview, applicationNotice(this.type), form.element);
    });
  }

  private duplicate(): void {
    const selected = entriesOf(this.draft.snapshot(), this.type).find(([path]) => path === this.selectedPath);
    if (!selected) return;
    const base = selected[1]; let suffix = 2; let next: AnyConfig;
    do { next = PANEL_REGISTRY[this.type].create(base, `${base.id}-copy-${suffix++}`); } while (entriesOf(this.draft.snapshot(), this.type).some(([, c]) => c.id === next.id));
    const path = registeredContentPath(next); this.draft.addFile(path, next); this.selectedPath = path; this.render(); void this.preflight();
  }

  private confirmDelete(path: string, id: string): void {
    const sheet = document.createElement("dialog"); sheet.className = "constellation-confirm";
    const text = document.createElement("p"); text.textContent = `Delete ${id}? Whole-pack preflight will identify every dangling reference.`;
    const cancel = document.createElement("button"); cancel.className = "ed-btn"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => sheet.close());
    const confirm = document.createElement("button"); confirm.className = "ed-btn ed-btn--danger"; confirm.textContent = "Delete config";
    confirm.addEventListener("click", () => { this.draft.deleteFile(path); sheet.close(); sheet.remove(); this.selectedPath = ""; this.render(); void this.preflight(); });
    sheet.append(text, cancel, confirm); document.body.append(sheet); sheet.showModal();
  }

  private async preflight(): Promise<void> { const result = await this.draft.preflight(); this.onProblems(result.errors); }
}

function entriesOf(bundle: ContentBundle, type: ConfigType): [string, AnyConfig][] {
  return Object.entries(bundle.files).filter((entry): entry is [string, AnyConfig] => {
    const value = entry[1] as { type?: unknown }; return value?.type === type;
  }).sort((a, b) => a[1].id.localeCompare(b[1].id));
}
