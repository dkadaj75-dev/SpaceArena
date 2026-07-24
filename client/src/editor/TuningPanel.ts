import { cameraSchema, tuningSchema, type CameraConfig, type TuningConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";

/** Node label used for substring filtering: a field's own text, or null for plain containers. */
function nodeLabel(el: HTMLElement): string | null {
  if (el.classList.contains("editor-field")) return el.querySelector(":scope > span")?.textContent ?? "";
  if (el.tagName === "DETAILS") return el.querySelector(":scope > summary")?.textContent ?? "";
  return null;
}

/** Hides child elements (and their subtrees) whose label doesn't contain `query`. Returns whether anything stayed visible. */
function filterTree(el: HTMLElement, query: string): boolean {
  let anyVisible = false;
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement) || child.tagName === "SUMMARY") continue;
    const label = nodeLabel(child);
    const childrenVisible = filterTree(child, query);
    const visible = query === "" || (label !== null && label.toLowerCase().includes(query)) || childrenVisible;
    child.style.display = visible ? "" : "none";
    anyVisible = anyVisible || visible;
  }
  return anyVisible;
}

/** One collapsible config section: form + save button, refiltered on demand. */
class ConfigSection<T extends TuningConfig | CameraConfig> {
  readonly element: HTMLDetailsElement;
  private readonly form: HTMLElement;
  private query = "";

  constructor(host: EditorHost, report: (message: string | null) => void, label: string, form: SchemaFormGen<T>) {
    this.element = document.createElement("details");
    this.element.open = true;
    const summary = document.createElement("summary");
    summary.textContent = label;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary ed-btn--sm";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.save());
    this.form = form.element;
    this.getValue = () => form.getValue();
    this.element.append(summary, this.form, save);
    // SchemaFormGen rebuilds its field tree on every successful edit, which
    // would otherwise wipe any active filter until the next keystroke.
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(this.form, { childList: true });
    void host; // host reserved for future live-preview hooks
    void report;
  }

  private readonly observer: MutationObserver;
  getValue: () => T;

  private async save(): Promise<void> {
    const error = await saveConfig(this.getValue());
    if (error) console.error(error);
  }

  setFilter(query: string): void {
    this.query = query.toLowerCase();
    filterTree(this.form, this.query);
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

  constructor(host: EditorHost, report: (message: string | null) => void) {
    const toolbar = document.createElement("div");
    toolbar.className = "ed-toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "ed-input";
    search.placeholder = "Filter fields…";
    search.addEventListener("input", () => this.filter(search.value));
    toolbar.append(search);
    this.element.append(toolbar);

    for (const tuning of host.configService.getAll<TuningConfig>("tuning")) {
      const form = new SchemaFormGen({
        schema: tuningSchema,
        value: tuning,
        configService: host.configService,
        onProblem: (p) => report(p ? `${tuning.id} ${p.path}: ${p.message}` : null),
      });
      const section = new ConfigSection(host, report, tuning.name ?? tuning.id, form);
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
      const section = new ConfigSection(host, report, camera.name ?? camera.id, form);
      this.sections.push(section);
      this.element.append(section.element);
    }
  }

  private filter(query: string): void {
    for (const section of this.sections) section.setFilter(query);
  }

  dispose(): void {
    for (const section of this.sections) section.dispose();
    this.element.replaceChildren();
  }
}
