import { CONFIG_SCHEMAS, CONFIG_TYPES, ConfigService, bundleLoader, type AnyConfig, type ConfigError, type ConfigType, type ContentBundle } from "@space-arena/shared";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { applicationNotice } from "./applicationScope.js";
import type { DraftPackStore } from "./DraftPackStore.js";
import { PANEL_REGISTRY, registeredContentPath } from "./panelRegistry.js";
import { renderPreview } from "./previewAdapters.js";
import { isViewportType, type ConstellationViewport } from "./ConstellationViewport.js";
import { ViewportEditor, editableTypeOf } from "./ViewportEditor.js";
import { AccordionState } from "./accordion.js";
import { newConfigId, newConfigOf } from "./newConfig.js";

export interface GenericConfigPanelOptions {
  /** Live 3D stage for the selected entity; null when no scene host is available. */
  viewport?: ConstellationViewport | null;
  /** Viewport selection + gizmo editing; null keeps the stage read-only. */
  editor?: ViewportEditor | null;
  /** Announces whether the centre cell currently shows 3D content. */
  onViewport?: (active: boolean) => void;
}

export class GenericConfigPanel {
  readonly element = document.createElement("section");
  private type: ConfigType = CONFIG_TYPES[0]!;
  private selectedPath = "";
  private disposePreview: (() => void) | null = null;
  private readonly viewport: ConstellationViewport | null;
  private readonly editor: ViewportEditor | null;
  private readonly viewportCell = document.createElement("div");
  private readonly viewportStatus = document.createElement("p");
  /**
   * Owned here rather than inside each `SchemaFormGen` so a viewport selection
   * can unfold the row it just picked (see {@link reveal}) — the form is rebuilt
   * on every edit, and the fold state has to outlive it either way.
   */
  private readonly accordions = new Map<ConfigType, AccordionState>();
  /** Field path the viewport asked to expose once the form is next built. */
  private pendingReveal: string | null = null;

  constructor(
    private readonly draft: DraftPackStore,
    private readonly onProblems: (errors: ConfigError[]) => void,
    private readonly options: GenericConfigPanelOptions = {},
  ) {
    this.element.className = "constellation-catalog";
    this.viewport = options.viewport ?? null;
    this.editor = options.editor ?? null;
    this.viewportCell.className = "constellation-viewport";
    this.viewportStatus.className = "constellation-viewport-status";
    this.viewportCell.append(this.viewportStatus);
    this.viewport?.watchStatus((text) => { this.viewportStatus.textContent = text; });
    this.element.dataset.viewport = this.viewport ? "off" : "none";
    this.render();
  }

  /**
   * Rebuild the catalogue.
   *
   * `restage` is off for a redraw the viewport editor itself triggered: it has
   * already committed to the draft and owns the restage, and a second one here
   * would tear the gizmo off the marker it is still attached to.
   */
  render(restage = true): void {
    this.disposePreview?.(); this.disposePreview = null;
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
    // New-first, then the list — the same order every folded list in the forms
    // uses. The catalogue itself stays expanded: it is the navigation, and
    // folding it would leave nothing to select.
    const actions = document.createElement("div"); actions.className = "constellation-list-actions";
    const fresh = document.createElement("button"); fresh.type = "button"; fresh.className = "ed-btn ed-btn--primary";
    fresh.textContent = `New ${PANEL_REGISTRY[this.type].label.replace(/s$/, "").toLowerCase()}`;
    fresh.addEventListener("click", () => this.create());
    const create = document.createElement("button"); create.type = "button"; create.className = "ed-btn"; create.textContent = "Duplicate selected";
    create.disabled = !this.selectedPath;
    create.addEventListener("click", () => this.duplicate());
    actions.append(fresh, create); sidebar.append(actions);
    for (const [path, config] of configs) {
      const button = document.createElement("button"); button.type = "button"; button.className = "constellation-item";
      button.classList.toggle("is-active", path === this.selectedPath); button.textContent = config.id;
      button.addEventListener("click", () => { this.selectedPath = path; this.render(); }); sidebar.append(button);
    }

    const editor = document.createElement("main"); editor.className = "constellation-form";
    const selected = configs.find(([path]) => path === this.selectedPath);
    if (selected) this.renderEditor(editor, bundle, selected[0], selected[1]);
    else { const empty = document.createElement("p"); empty.className = "ed-empty"; empty.textContent = "This pack has no config of this type. Duplicate requires a source config."; editor.append(empty); }
    this.element.replaceChildren(nav, sidebar, editor, this.viewportCell);
    void this.updateViewport(selected?.[1] ?? null, selected?.[0] ?? "", bundle, restage);
  }

  /**
   * Stage (or tear down) the selected entity in the game scene. The chrome only
   * goes transparent once something is really built, so a type with no 3D
   * subject keeps a readable opaque background.
   *
   * The editing session is pointed at the subject BEFORE the markers are built
   * (its policy decides which of them are pickable) and re-bound to its
   * selection after — that pair is what keeps the gizmo attached across the
   * rebuild every committed edit causes.
   */
  private async updateViewport(config: AnyConfig | null, path: string, bundle: ContentBundle, restage = true): Promise<void> {
    if (!this.viewport) return;
    if (!config || !isViewportType(config.type)) {
      this.editor?.detach();
      this.viewport.clear();
      this.element.dataset.viewport = "off";
      this.options.onViewport?.(false);
      return;
    }
    if (config.type !== "arena" && config.type !== "ship") this.editor?.detach();
    else this.editor?.setSubject(path, config);
    if (!restage) return;
    const staged = await this.viewport.show(config, (type, id) => lookupIn(bundle, type, id));
    // A later selection may have landed while a model was loading — that call
    // owns the chrome state, so only the winning one reports.
    if (!staged) return;
    this.editor?.afterStage();
    this.element.dataset.viewport = "on";
    this.options.onViewport?.(true);
  }

  /**
   * Unfold the form row a viewport pick corresponds to, and scroll to it. The
   * card in the viewport carries the quick fields; the generated form is where
   * the rest of the placement (or socket) lives, so a selection has to be able
   * to reach it in one action rather than a hunt through a folded list.
   */
  reveal(fieldPath: string): void {
    const state = this.accordionsFor(this.type);
    const segments = fieldPath.split(".");
    // Open every ancestor: "propPlacements" → "propPlacements[]" → "propPlacements.7".
    for (let end = 1; end <= segments.length; end++) {
      const key = segments.slice(0, end).join(".");
      state.set(key, true);
      if (end < segments.length) state.set(`${key}[]`, true);
    }
    this.pendingReveal = fieldPath;
    this.render(false);
  }

  private accordionsFor(type: ConfigType): AccordionState {
    let state = this.accordions.get(type);
    if (!state) { state = new AccordionState(type); this.accordions.set(type, state); }
    return state;
  }

  private renderEditor(target: HTMLElement, bundle: ContentBundle, path: string, config: AnyConfig): void {
    const head = document.createElement("div"); head.className = "constellation-config-head";
    const title = document.createElement("h2"); title.textContent = config.id;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ed-btn ed-btn--danger"; remove.textContent = "Delete";
    remove.addEventListener("click", () => this.confirmDelete(path, config.id)); head.append(title, remove);
    const deployed = document.createElement("p"); deployed.className = "constellation-asset-note";
    deployed.textContent = "Asset fields edit references to already deployed assets. Binary upload is not available in Phase 0.";
    const preview = document.createElement("p"); preview.className = "constellation-preview"; preview.textContent = PANEL_REGISTRY[this.type].preview;
    const livePreview = document.createElement("section"); livePreview.setAttribute("aria-live", "polite");
    const baseConfig = this.draft.base.files[path] as AnyConfig | undefined;
    const service = new ConfigService(bundleLoader(bundle));
    void service.load("manifest.json").then(() => {
      const form = new SchemaFormGen({
        schema: CONFIG_SCHEMAS[this.type], value: config, configService: service,
        allowPackInvalid: true,
        // Structural fold state is remembered per config type, so opening "Prop
        // placements" on one arena leaves it open on the next. Row-level folds
        // are not: this form is rebuilt on every selection change, and its
        // per-document state goes with it (see `accordion.ts`).
        accordions: this.accordionsFor(this.type),
        onProblems: (problems) => this.onProblems(problems.map((problem) => ({ file: path, ...problem }))),
        onSaved: (value) => {
          this.draft.setFile(path, value); void this.preflight();
          void this.updatePreview(livePreview, value, baseConfig);
          void this.updateViewport(value, path, this.draft.snapshot());
        },
      });
      const tools = this.editor && editableTypeOf(config) ? [this.editor.element] : [];
      target.append(head, deployed, preview, applicationNotice(this.type), ...tools, this.workflowHelp(config), livePreview, form.element);
      void this.updatePreview(livePreview, config, baseConfig);
      this.applyPendingReveal(form.element);
    });
  }

  /** Scroll to the row {@link reveal} unfolded, once the form that holds it exists. */
  private applyPendingReveal(form: HTMLElement): void {
    const target = this.pendingReveal;
    this.pendingReveal = null;
    if (!target) return;
    const row = form.querySelector<HTMLElement>(`[data-accordion="${cssEscape(target)}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }

  private async updatePreview(target: HTMLElement, config: AnyConfig, baseConfig?: AnyConfig): Promise<void> {
    this.disposePreview?.();
    this.disposePreview = await renderPreview(target, { bundle: this.draft.snapshot(), config, baseConfig });
  }

  private workflowHelp(config: AnyConfig): HTMLElement {
    const box = document.createElement("details"); box.className = "constellation-workflow";
    const summary = document.createElement("summary");
    const copy: Partial<Record<ConfigType, string>> = {
      ship: "Ship hull + socket gizmo workflow", module: "Module fitting + identity workflow", arena: "Map objects + spawn workflow",
      event: "Trigger + ordered action builder", progression: "XP curve + unlock/reward table", cosmetic: "Swatch + applicability workflow",
      effect: "Effect recipe + deployed asset workflow", upgrade: "Level curve + resulting metrics", action: "Action kind + record-key params",
      tuning: "Tuning values + feature flags + draft balance bench", theme: "Tokens + portrait/landscape gallery",
      botprofile: "Behavior weights + seeded audit", notification: "Notification sandbox", quality: "Device-quality budget workflow",
    };
    summary.textContent = copy[config.type] ?? `${PANEL_REGISTRY[config.type].label} workflow`;
    const p = document.createElement("p");
    p.textContent = config.type === "action" ? "Params is an arbitrary record: use Add property, edit its stable string key, then choose JSON/value editing. It is stored in this same draft file."
      : "This dedicated workspace and the generic fields below are two views of the same draft entity; publish remains one whole-pack transaction.";
    box.append(summary, p); return box;
  }

  /**
   * A brand-new config of the current type, built from the schema's own
   * defaults. Types whose required fields are cross-references cannot be born
   * blank, so those fall back to duplicating the selection.
   */
  private create(): void {
    const existing = entriesOf(this.draft.snapshot(), this.type);
    const id = newConfigId(this.type, existing.map(([, config]) => config.id));
    const fresh = newConfigOf(this.type, id);
    if (!fresh) { this.duplicate(); return; }
    this.commit(fresh);
  }

  private duplicate(): void {
    const selected = entriesOf(this.draft.snapshot(), this.type).find(([path]) => path === this.selectedPath);
    if (!selected) return;
    const base = selected[1]; let suffix = 2; let next: AnyConfig;
    do { next = PANEL_REGISTRY[this.type].create(base, `${base.id}-copy-${suffix++}`); } while (entriesOf(this.draft.snapshot(), this.type).some(([, c]) => c.id === next.id));
    this.commit(next);
  }

  /** Add a config to the draft, select it, and re-run whole-pack preflight. */
  private commit(config: AnyConfig): void {
    const path = registeredContentPath(config); this.draft.addFile(path, config); this.selectedPath = path; this.render(); void this.preflight();
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

/**
 * Escape a dotted field path for use INSIDE the quotes of an attribute
 * selector. Not `CSS.escape`, which quotes identifiers: a quoted attribute
 * value only has to survive `"` and `\`, and field paths are schema keys and
 * array indices anyway.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** Resolve one referenced config out of the draft bundle (arena placements…). */
function lookupIn(bundle: ContentBundle, type: ConfigType, id: string): AnyConfig | undefined {
  return entriesOf(bundle, type).find(([, config]) => config.id === id)?.[1];
}

function entriesOf(bundle: ContentBundle, type: ConfigType): [string, AnyConfig][] {
  return Object.entries(bundle.files).filter((entry): entry is [string, AnyConfig] => {
    const value = entry[1] as { type?: unknown }; return value?.type === type;
  }).sort((a, b) => a[1].id.localeCompare(b[1].id));
}
