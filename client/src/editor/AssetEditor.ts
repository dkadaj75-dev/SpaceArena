import { asteroidSchema, type AsteroidConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { applicationNotice } from "./applicationScope.js";

function nextId(existing: string[]): string {
  let n = 1;
  while (existing.includes(`asteroid.custom-${n}`)) n++;
  return `asteroid.custom-${n}`;
}

/**
 * Asset states editor (1.14), currently representative-typed on asteroids.
 * Ship visual assets (hull meshes/palettes) join this editor in Phase 4.
 */
export class AssetEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<AsteroidConfig> | null = null;

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    const configs = host.configService.getAll<AsteroidConfig>("asteroid");
    this.selectedId = configs[0]?.id ?? null;
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.host.configService.getAll<AsteroidConfig>("asteroid");
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
    add.textContent = "New asteroid";
    add.addEventListener("click", () => this.createFrom(configs));
    toolbar.append(label("Asteroid"), select, add);
    this.element.append(toolbar, applicationNotice("asteroid"));

    const selected = configs.find((c) => c.id === this.selectedId);
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = configs.length
        ? "Pick an asteroid above to edit it."
        : "No asteroid configs loaded. “New asteroid” starts one.";
      this.element.append(empty);
      return;
    }
    this.form = new SchemaFormGen({
      schema: asteroidSchema,
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

  private createFrom(configs: AsteroidConfig[]): void {
    const template = configs.find((c) => c.id === this.selectedId) ?? configs[0];
    const id = nextId(configs.map((c) => c.id));
    const clone: AsteroidConfig = template
      ? { ...structuredClone(template), id, name: id }
      : {
          id,
          type: "asteroid",
          version: 1,
          name: id,
          radius: 3,
          colliderScale: 1,
          destructible: true,
          impactDamage: 5,
          render: { recipe: "procedural.rock-small" },
        };
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
