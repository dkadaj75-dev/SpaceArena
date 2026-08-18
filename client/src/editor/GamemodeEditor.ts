import { gamemodeSchema, type GamemodeConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { applicationNotice } from "./applicationScope.js";

/** First free `gamemode.custom-N` id. */
export function nextGamemodeId(existing: readonly string[]): string {
  let n = 1;
  while (existing.includes(`gamemode.custom-${n}`)) n++;
  return `gamemode.custom-${n}`;
}

/**
 * Gamemode editor (ROADMAP 5.3 "win-condition / rule builder"): picker + New +
 * Save over the generated `gamemodeSchema` form.
 *
 * Everything the rule builder needs is already schema-declared, so this panel
 * adds no bespoke DOM: `winCondition` and `boundaryRule` are discriminated
 * unions, which {@link SchemaFormGen} now renders as a `type` dropdown plus the
 * selected variant's fields (switching type re-seeds the branch defaults);
 * `teams` / `respawn` / `rewards` / `eliminationEndsMatch` come out as
 * selects, toggles and bounded numbers; and the optional `bots` block renders
 * with a presence toggle whose `roster` array has add/remove rows, with
 * `profile` / `ship` / `defaultArena` resolved through the generator's
 * searchable id pickers.
 *
 * No new schema fields and no new sim rules are introduced here — this is a
 * front end onto the rules the gamemode schema already has.
 */
export class GamemodeEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<GamemodeConfig> | null = null;

  constructor(
    private readonly host: EditorHost,
    private readonly report: (message: string | null) => void,
  ) {
    this.selectedId = host.configService.getAll<GamemodeConfig>("gamemode")[0]?.id ?? null;
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.host.configService.getAll<GamemodeConfig>("gamemode");

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
    add.textContent = "New mode";
    add.addEventListener("click", () => this.createFrom(configs));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.save());
    const title = document.createElement("span");
    title.className = "ed-label";
    title.textContent = "Mode";
    toolbar.append(title, select, add, save);
    this.element.append(toolbar, applicationNotice("gamemode"));

    const selected = configs.find((c) => c.id === this.selectedId);
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = "No gamemodes loaded.";
      this.element.append(empty);
      return;
    }
    this.form = new SchemaFormGen<GamemodeConfig>({
      schema: gamemodeSchema,
      value: selected,
      configService: this.host.configService,
      onProblem: (p) => this.report(p ? `${selected.id} ${p.path}: ${p.message}` : null),
    });
    this.element.append(this.form.element);
  }

  private createFrom(configs: GamemodeConfig[]): void {
    const template = configs.find((c) => c.id === this.selectedId) ?? configs[0];
    if (!template) {
      this.report("Cannot create a gamemode: no template loaded.");
      return;
    }
    const id = nextGamemodeId(configs.map((c) => c.id));
    const clone: GamemodeConfig = { ...structuredClone(template), id, name: id };
    const result = this.host.configService.replace(clone);
    if (!result.ok) {
      this.report(result.errors.map((e) => e.message).join("; "));
      return;
    }
    this.selectedId = id;
    this.render();
  }

  private async save(): Promise<void> {
    if (!this.form) return;
    const error = await saveConfig(this.form.getValue());
    if (error) this.report(error);
  }

  dispose(): void {
    this.element.replaceChildren();
  }
}
