import { actionSchema, type ActionConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";

function nextId(existing: string[]): string {
  let n = 1;
  while (existing.includes(`action.custom-${n}`)) n++;
  return `action.custom-${n}`;
}

/**
 * CRUD editor for action configs (1.15). `action.ts` is a flat schema with a
 * `kind` enum field (not a Zod discriminated union), so SchemaFormGen already
 * renders `kind` as a dropdown and no per-variant form-switching is needed.
 * `params` is a free-form `z.record(string, unknown())` bag with no enumerable
 * JSON-schema properties, so SchemaFormGen falls back to its labelled JSON
 * field for it — every key stays authorable (including new ones), it is simply
 * typed as JSON rather than as generated controls, because the runtime reads a
 * different shape per `kind`.
 */
export class ActionEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<ActionConfig> | null = null;

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.selectedId = host.configService.getAll<ActionConfig>("action")[0]?.id ?? null;
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.host.configService.getAll<ActionConfig>("action");
    const toolbar = document.createElement("div");
    toolbar.className = "ed-toolbar";
    const select = document.createElement("select");
    select.className = "ed-select";
    for (const config of configs) select.append(new Option(config.name ?? config.id, config.id, false, config.id === this.selectedId));
    select.addEventListener("change", () => {
      this.selectedId = select.value;
      this.render();
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn";
    add.textContent = "New action";
    add.addEventListener("click", () => this.createFrom(configs));
    toolbar.append(label("Action"), select, add);
    this.element.append(toolbar);

    const selected = configs.find((c) => c.id === this.selectedId);
    if (!selected) {
      // An unexplained blank panel reads as a broken tool. Say which it is.
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = configs.length
        ? "Pick an action above to edit it."
        : "No action configs loaded. “New action” starts one.";
      this.element.append(empty);
      return;
    }
    this.form = new SchemaFormGen({
      schema: actionSchema,
      value: selected,
      configService: this.host.configService,
      onProblem: (p) => this.report(p ? `${selected.id} ${p.path}: ${p.message}` : null),
    });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.save());
    this.element.append(this.form.element, save);
  }

  private createFrom(configs: ActionConfig[]): void {
    const template = configs.find((c) => c.id === this.selectedId) ?? configs[0];
    const id = nextId(configs.map((c) => c.id));
    const clone: ActionConfig = template
      ? { ...structuredClone(template), id, name: id }
      : { id, type: "action", version: 1, name: id, kind: "play_sound" };
    const result = this.host.configService.replace(clone);
    if (!result.ok) {
      this.report(result.errors.map((e) => e.message).join("; "));
      return;
    }
    this.selectedId = id;
    this.render();
  }

  async save(): Promise<void> {
    if (!this.form) return;
    const error = await saveConfig(this.form.getValue());
    if (error) this.report(error);
  }

  dispose(): void {
    this.element.replaceChildren();
  }
}

function label(value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "ed-label";
  span.textContent = value;
  return span;
}
