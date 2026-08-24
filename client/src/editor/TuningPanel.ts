import { cameraSchema, tuningSchema, type CameraConfig, type TuningConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { applicationNotice } from "./applicationScope.js";
import { FieldFilter, filterTree } from "./fieldFilter.js";

/** One collapsible config section: form + save button, refiltered on demand. */
class ConfigSection<T extends TuningConfig | CameraConfig> {
  readonly element: HTMLDetailsElement;
  private readonly form: HTMLElement;
  private query = "";

  constructor(
    host: EditorHost,
    report: (message: string | null) => void,
    label: string,
    form: SchemaFormGen<T>,
    type: "tuning" | "camera",
  ) {
    this.element = document.createElement("details");
    // Folded on first render, like every other accordion in the tool set: a
    // pack's tuning config alone is ~60 fields, and stacking every tuning and
    // camera config open meant the panel opened halfway down a scroll of
    // numbers. The filter below is the way in — see setFilter().
    this.element.open = false;
    // Only a toggle made with NO filter active is the designer's own choice;
    // the ones setFilter() performs are the search reopening its hits, and
    // recording those would make a stray search stick permanently.
    this.element.addEventListener("toggle", () => {
      if (this.query === "") this.manualOpen = this.element.open;
    });
    const summary = document.createElement("summary");
    summary.textContent = label;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary ed-btn--sm";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.save());
    this.form = form.element;
    this.getValue = () => form.getValue();
    this.element.append(summary, applicationNotice(type), this.form, save);
    // SchemaFormGen rebuilds its field tree on every successful edit, which
    // would otherwise wipe any active filter until the next keystroke.
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(this.form, { childList: true });
    void host; // host reserved for future live-preview hooks
    this.report = report;
  }

  /** The designer's own open/shut, restored whenever the filter is cleared. */
  private manualOpen = false;
  private readonly observer: MutationObserver;
  private readonly report: (message: string | null) => void;
  getValue: () => T;

  async save(): Promise<void> {
    const error = await saveConfig(this.getValue());
    this.report(error);
  }

  setFilter(query: string): void {
    this.query = query.toLowerCase();
    const matched = filterTree(this.form, this.query);
    // Typing in the filter IS an explicit request to see what matches, so a
    // hit opens its section — searching a wall of shut accordions and being
    // shown nothing would make the filter useless. Clearing the query folds
    // them back rather than leaving every section the search happened to touch
    // hanging open.
    this.element.open = this.query === "" ? this.manualOpen : matched;
  }

  refresh(): void {
    this.setFilter(this.query);
  }

  dispose(): void {
    this.observer.disconnect();
  }
}

/** Flat searchable editor over every tuning + camera config (1.13). */
export class TuningPanel implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly sections: ConfigSection<TuningConfig | CameraConfig>[] = [];
  private readonly search: FieldFilter;

  constructor(host: EditorHost, report: (message: string | null) => void) {
    const toolbar = document.createElement("div");
    toolbar.className = "ed-toolbar";
    this.search = new FieldFilter({ placeholder: "e.g. damage, netRenderDelayMs", onQuery: (query) => this.filter(query) });
    toolbar.append(this.search.element);
    this.element.append(toolbar);

    for (const tuning of host.configService.getAll<TuningConfig>("tuning")) {
      const form = new SchemaFormGen({
        schema: tuningSchema,
        value: tuning,
        configService: host.configService,
        onProblem: (p) => report(p ? `${tuning.id} ${p.path}: ${p.message}` : null),
      });
      const section = new ConfigSection(host, report, tuning.name ?? tuning.id, form, "tuning");
      this.sections.push(section);
      this.element.append(section.element);
    }
    for (const camera of host.configService.getAll<CameraConfig>("camera")) {
      const form = new SchemaFormGen({
        schema: cameraSchema,
        value: camera,
        configService: host.configService,
        onProblem: (p) => report(p ? `${camera.id} ${p.path}: ${p.message}` : null),
      });
      const section = new ConfigSection(host, report, camera.name ?? camera.id, form, "camera");
      this.sections.push(section);
      this.element.append(section.element);
    }

    // Every section is folded, so a pack with no tuning/camera configs would
    // otherwise show a lone search box over nothing and read as a broken tool.
    if (this.sections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = "This content pack ships no tuning or camera configs.";
      this.element.append(empty);
    }
  }

  private filter(query: string): void {
    for (const section of this.sections) section.setFilter(query);
  }

  dispose(): void {
    this.search.dispose();
    for (const section of this.sections) section.dispose();
    this.element.replaceChildren();
  }
}
