import { describe, expect, it, vi } from "vitest";
import type { ActionConfig, AsteroidConfig, ConfigService, NotificationConfig } from "@space-arena/shared";
import { ActionEditor } from "./ActionEditor.js";
import { AssetEditor } from "./AssetEditor.js";
import { NotificationEditor } from "./NotificationEditor.js";
import type { EditorHost, EditorPanel } from "./EditorShell.js";

/**
 * The three single-schema CRUD panels share one shape: a picker, a New button
 * and a generated form. They also shared one hole — `if (!selected) return`,
 * which left a pack with none of that config type staring at a bare toolbar and
 * nothing else, indistinguishable from a tool that had failed to load.
 */
function host(type: string, configs: unknown[]): EditorHost {
  const configService = {
    getAll: vi.fn((t: string) => (t === type ? configs : [])),
    get: vi.fn(() => undefined),
    replace: vi.fn(() => ({ ok: true as const, errors: [] })),
  } as unknown as ConfigService;
  return { configService } as unknown as EditorHost;
}

const action = { id: "action.boom", type: "action", version: 1, name: "Boom", kind: "play_sound" } as ActionConfig;
const asteroid = {
  id: "asteroid.rock", type: "asteroid", version: 1, name: "Rock", radius: 3, colliderScale: 1,
  destructible: true, impactDamage: 5, render: { recipe: "procedural.rock-small" },
} as AsteroidConfig;
const notification = {
  id: "notification.hit", type: "notification", version: 1, name: "Hit", text: "Hit", style: "info", durationMs: 2000,
} as NotificationConfig;

const CASES: { name: string; type: string; config: unknown; empty: string; picker: string; make: (h: EditorHost) => EditorPanel }[] = [
  { name: "ActionEditor", type: "action", config: action, empty: "No action configs loaded", picker: "Action", make: (h) => new ActionEditor(h, vi.fn()) },
  { name: "AssetEditor", type: "asteroid", config: asteroid, empty: "No asteroid configs loaded", picker: "Asteroid", make: (h) => new AssetEditor(h, vi.fn()) },
  { name: "NotificationEditor", type: "notification", config: notification, empty: "No notification configs loaded", picker: "Notification", make: (h) => new NotificationEditor(h, vi.fn()) },
];

describe.each(CASES)("$name", ({ type, config, empty, picker, make }) => {
  it("explains an empty pack instead of rendering a bare toolbar", () => {
    const panel = make(host(type, []));

    const notice = panel.element.querySelector(".ed-empty");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(empty);
    // …and it points at the way out.
    expect(notice!.textContent).toContain("New");

    panel.dispose();
  });

  it("names what its picker picks, and drops the empty notice once loaded", () => {
    const panel = make(host(type, [config]));

    expect([...panel.element.querySelectorAll(".ed-label")].map((el) => el.textContent)).toContain(picker);
    // The picker is styled like every other select in the tool set.
    expect(panel.element.querySelector("select")?.classList.contains("ed-select")).toBe(true);
    expect(panel.element.querySelector(".ed-empty")).toBeNull();
    expect(panel.element.querySelector("form.editor-schema-form")).not.toBeNull();

    panel.dispose();
  });

  it("spells out what its New button creates", () => {
    const panel = make(host(type, [config]));
    const labels = [...panel.element.querySelectorAll("button")].map((b) => b.textContent);
    // A bare "New" gave no clue which of fifteen tools' config it would add.
    expect(labels).not.toContain("New");
    expect(labels.some((l) => l?.startsWith("New "))).toBe(true);
    panel.dispose();
  });
});
