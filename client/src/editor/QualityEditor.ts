import {
  qualitySchema,
  QUALITY_TIERS,
  type QualityConfig,
  type QualityTier,
} from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { QUALITY_STORAGE_KEY, parseStoredTier } from "../core/qualityTier.js";

/**
 * ROADMAP §10 5.6 — Quality tool: SchemaFormGen over every `quality` config
 * (same pattern as Tuning/Theme), plus the player-facing tier override.
 *
 * The override writes the same `sa.quality` localStorage key the 5.8 settings
 * screen will own, so this panel is a dev front-end for the *shipping*
 * mechanism, not a parallel one. Editing a tier's fields hot-reloads it through
 * the normal `config:changed` path, which `QualityManager` listens to.
 */
export class QualityEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly forms: SchemaFormGen<QualityConfig>[] = [];

  constructor(host: EditorHost, report: (message: string | null) => void) {
    this.element.append(this.buildOverrideBar());

    const configs = host.configService.getAll<QualityConfig>("quality");
    if (configs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ed-hint";
      empty.textContent = "This content pack ships no quality tiers.";
      this.element.append(empty);
      return;
    }

    for (const config of configs) {
      const form = new SchemaFormGen({
        schema: qualitySchema,
        value: config,
        configService: host.configService,
        onProblem: (p) => report(p ? `${config.id} ${p.path}: ${p.message}` : null),
      });
      this.forms.push(form);

      const section = document.createElement("details");
      section.open = true;
      const summary = document.createElement("summary");
      summary.textContent = `${config.name ?? config.id} (${config.tier})`;
      const save = document.createElement("button");
      save.type = "button";
      save.className = "ed-btn ed-btn--primary ed-btn--sm";
      save.textContent = "Save to disk";
      save.addEventListener("click", () => {
        void saveConfig(form.getValue()).then((error) => {
          report(error);
        });
      });
      section.append(summary, form.element, save);
      this.element.append(section);
    }
  }

  /**
   * The `sa.quality` override: "Auto" clears the key (device probe + first-
   * seconds FPS decide), a named tier pins it. Written directly rather than
   * through QualityManager so the panel stays independent of the running match.
   */
  private buildOverrideBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "ed-toolbar";

    const label = document.createElement("span");
    label.textContent = "Player override (sa.quality)";

    const select = document.createElement("select");
    select.className = "ed-input";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto (device probe + FPS)";
    select.append(auto);
    for (const tier of QUALITY_TIERS) {
      const option = document.createElement("option");
      option.value = tier;
      option.textContent = tier;
      select.append(option);
    }
    select.value = parseStoredTier(readOverride()) ?? "";

    const hint = document.createElement("span");
    hint.className = "ed-hint";
    hint.textContent = "Applies on next reload.";

    select.addEventListener("change", () => {
      writeOverride(parseStoredTier(select.value));
    });

    bar.append(label, select, hint);
    return bar;
  }

  dispose(): void {
    this.forms.length = 0;
    this.element.replaceChildren();
  }
}

function readOverride(): string | null {
  try {
    return localStorage.getItem(QUALITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeOverride(tier: QualityTier | null): void {
  try {
    if (tier) localStorage.setItem(QUALITY_STORAGE_KEY, tier);
    else localStorage.removeItem(QUALITY_STORAGE_KEY);
  } catch {
    // Storage disabled — nothing to persist, the running session is unaffected.
  }
}
