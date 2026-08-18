import { notificationSchema, type NotificationConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";

function nextId(existing: string[]): string {
  let n = 1;
  while (existing.includes(`notification.custom-${n}`)) n++;
  return `notification.custom-${n}`;
}

/** CRUD editor for notification configs (1.15). */
export class NotificationEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<NotificationConfig> | null = null;

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.selectedId = host.configService.getAll<NotificationConfig>("notification")[0]?.id ?? null;
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.host.configService.getAll<NotificationConfig>("notification");
    const toolbar = document.createElement("div");
    toolbar.className = "ed-toolbar";
    const select = document.createElement("select");
    for (const config of configs) select.append(new Option(config.name ?? config.id, config.id, false, config.id === this.selectedId));
    select.addEventListener("change", () => {
      this.selectedId = select.value;
      this.render();
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn";
    add.textContent = "New";
    add.addEventListener("click", () => this.createFrom(configs));
    toolbar.append(select, add);
    this.element.append(toolbar);

    const selected = configs.find((c) => c.id === this.selectedId);
    if (!selected) return;
    this.form = new SchemaFormGen({
      schema: notificationSchema,
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

  private createFrom(configs: NotificationConfig[]): void {
    const template = configs.find((c) => c.id === this.selectedId) ?? configs[0];
    const id = nextId(configs.map((c) => c.id));
    const clone: NotificationConfig = template
      ? { ...structuredClone(template), id, name: id }
      : { id, type: "notification", version: 1, name: id, text: "New notification", style: "info", durationMs: 2000 };
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
