import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBundle, type ContentBundle } from "@space-arena/shared";
import { ConstellationApp } from "./ConstellationApp.js";
import type { EditorRepository } from "./repository/EditorRepository.js";

/**
 * A pack that really validates. It has to: `import()` refuses an invalid pack
 * and keeps the current draft, so a hand-waved fixture would make every
 * assertion below pass against the bug it is meant to catch.
 */
function miniPack(): { manifest: unknown; files: Record<string, unknown> } {
  return {
    manifest: { id: "manifest.test", type: "manifest", version: 1, name: "Test Pack", files: ["asteroids/rock.json", "arenas/test.json"] },
    files: {
      "asteroids/rock.json": {
        id: "asteroid.rock", type: "asteroid", version: 1, name: "Rock",
        radius: 4, hp: 100, destructible: true, impactDamage: 5, render: { recipe: "procedural.rock-small" },
      },
      "arenas/test.json": {
        id: "arena.test", type: "arena", version: 1, name: "Test Arena",
        bounds: { shape: "sphere", radius: 80 },
        asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 0, z: 0 } }],
        spawnPoints: [
          { id: "sp-a", team: 0, position: { x: -20, z: -20 }, heading: 0 },
          { id: "sp-b", team: 1, position: { x: 20, z: 20 }, heading: 3.14 },
        ],
      },
    },
  };
}

let valid: ContentBundle;

beforeAll(async () => {
  const { manifest, files } = miniPack();
  valid = await buildBundle(manifest, files);
});

function bundle(): ContentBundle {
  return structuredClone(valid);
}

function repository(): EditorRepository {
  return {
    status: vi.fn(),
    load: vi.fn(async () => bundle()),
    publish: vi.fn(),
    rollback: vi.fn(),
  } as unknown as EditorRepository;
}

/** Reach the private `import` handler without faking a FileList. */
type Importer = { import(file: File): Promise<void> };

function packFile(source: ContentBundle): File {
  return new File([JSON.stringify(source)], "pack.json", { type: "application/json" });
}

let app: ConstellationApp | null = null;

beforeEach(() => {
  localStorage.clear();
  // The repo-save probe must not reach the network in a unit test.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));
  // Import and discard both ask first; auto-accept so the flow under test runs.
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
    this.querySelectorAll("button")[1]?.click();
  });
});

afterEach(() => {
  document.querySelectorAll(".sa-editor, dialog").forEach((el) => el.remove());
  app = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function badge(): HTMLElement {
  return document.querySelector<HTMLElement>(".constellation-dirty")!;
}

describe("ConstellationApp draft wiring", () => {
  it("re-registers its change listener on the imported store", async () => {
    // The regression: `import()` swaps `this.draft` for a new DraftPackStore,
    // and the onChange subscription belonged to the store it replaced. Editing
    // an imported pack then updated nothing — no dirty badge, no save button,
    // no unload guard — while looking perfectly normal.
    app = new ConstellationApp(repository(), () => {});
    await app.open();
    expect(badge().dataset.tone).toBe("clean");

    const original = (app as unknown as { draft: unknown }).draft;
    await (app as unknown as Importer).import(packFile(bundle()));
    expect(badge().dataset.tone).toBe("clean");
    // Guard the guard: an invalid pack is refused and the draft kept, which
    // would make everything below assert against the original store instead.
    expect((app as unknown as { draft: unknown }).draft).not.toBe(original);

    // An edit on the IMPORTED store must still drive the whole shell.
    const draft = (app as unknown as { draft: { setFile(path: string, value: unknown): void } }).draft;
    draft.setFile("asteroids/rock.json", { ...miniPack().files["asteroids/rock.json"] as object, hp: 250 });

    expect(badge().dataset.tone).toBe("dirty");
    expect(badge().textContent).toBe("1 unsaved change(s)");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-repo"]')!.disabled).toBe(false);
  });

  it("confirms before an import throws away a dirty draft", async () => {
    app = new ConstellationApp(repository(), () => {});
    await app.open();
    const draft = (app as unknown as { draft: { setFile(path: string, value: unknown): void } }).draft;
    draft.setFile("asteroids/rock.json", { ...miniPack().files["asteroids/rock.json"] as object, hp: 999 });
    expect(badge().dataset.tone).toBe("dirty");

    // Cancel (the first dialog button) — the draft must survive untouched.
    vi.mocked(HTMLDialogElement.prototype.showModal).mockImplementation(function (this: HTMLDialogElement) {
      this.querySelectorAll("button")[0]?.click();
    });
    await (app as unknown as Importer).import(packFile(bundle()));

    expect(badge().dataset.tone).toBe("dirty");
    expect((app as unknown as { draft: unknown }).draft).toBe(draft);
  });

  it("keeps the pack identity in the status line and only lends it to a message", async () => {
    app = new ConstellationApp(repository(), () => {});
    await app.open();
    const status = document.querySelector<HTMLElement>(".constellation-status")!;
    const identity = `0 changed file(s) · base ${valid.sourceHash.slice(0, 15)}…`;
    expect(status.textContent).toBe(identity);

    (app as unknown as { message(text: string): void }).message("5 file(s) saved to content/");
    expect(status.textContent).toBe("5 file(s) saved to content/");
    // Outcomes are the only thing announced; the dirty badge is not a live region.
    expect(document.querySelector(".constellation-announce")?.textContent).toBe("5 file(s) saved to content/");
    expect(badge().hasAttribute("aria-live")).toBe(false);

    // The next edit retires the message and restores the baseline.
    const draft = (app as unknown as { draft: { setFile(path: string, value: unknown): void } }).draft;
    draft.setFile("asteroids/rock.json", { ...miniPack().files["asteroids/rock.json"] as object, hp: 300 });
    expect(status.textContent).toBe(identity.replace("0 changed", "1 changed"));
  });

  it("degrades to forms only when there is no scene host", async () => {
    // Constellation ships in every build, but the 3D viewport needs the game's
    // canvas. With `constellationHost` null there must be no viewport cell, no
    // selection card and no gizmo tool rail — just the generated forms.
    app = new ConstellationApp(repository(), () => {});
    await app.open();

    expect(document.querySelector<HTMLElement>(".constellation-catalog")!.dataset.viewport).toBe("none");
    expect(document.querySelector(".ed-vptools")).toBeNull();
    expect(document.querySelector(".ed-ctx")).toBeNull();
    expect((app as unknown as { viewportEditor: unknown }).viewportEditor).toBeNull();
  });

  it("unfolds and scrolls to the form row a viewport selection names", async () => {
    app = new ConstellationApp(repository(), () => {});
    await app.open();
    const panel = (app as unknown as { panel: { reveal(path: string): void } | null }).panel!;

    // Select the arena, whose lists are folded by Constellation's convention.
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".constellation-types .ed-tab"));
    tabs.find((tab) => tab.textContent === "Arena")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector<HTMLDetailsElement>('[data-accordion="asteroidPlacements"]')!.open).toBe(false);

    panel.reveal("asteroidPlacements.0");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The whole chain to the picked row opens: list → "List of …" → the row.
    expect(document.querySelector<HTMLDetailsElement>('[data-accordion="asteroidPlacements"]')!.open).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>('[data-accordion="asteroidPlacements[]"]')!.open).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>('[data-accordion="asteroidPlacements.0"]')!.open).toBe(true);
  });

  it("puts Save ahead of the destructive Exit in the toolbar", async () => {
    app = new ConstellationApp(repository(), () => {});
    await app.open();

    const bar = document.querySelector(".ed-topbar")!;
    const order = Array.from(bar.children).map((el) => el.className);
    expect(order.findIndex((c) => c.includes("constellation-save"))).toBeLessThan(
      order.findIndex((c) => c.includes("constellation-exit")),
    );
  });
});
