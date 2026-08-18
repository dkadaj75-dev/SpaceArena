import { NullEngine, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorShell, viewportRectFor, type EditorHost } from "./EditorShell.js";

/** Desktop: 1280×720 window, 44px top bar + 34px tool row, 400px inspector. */
const DESKTOP_SPACER = { left: 0, top: 78, width: 880, height: 642 };
const DESKTOP_INSPECTOR = { left: 880, top: 78, width: 400, height: 642 };
/** Phone: full-width viewport cell with the sheet drawn over its bottom half. */
const PHONE_SPACER = { left: 0, top: 78, width: 390, height: 766 };
const PHONE_SHEET = { left: 0, top: 500, width: 390, height: 344 };

describe("viewportRectFor", () => {
  it("hands the docked layout the spacer cell verbatim — the inspector is beside it, not over it", () => {
    expect(viewportRectFor(DESKTOP_SPACER, DESKTOP_INSPECTOR, false)).toEqual(DESKTOP_SPACER);
  });

  it("stops the viewport at the top of a full-width bottom sheet", () => {
    expect(viewportRectFor(PHONE_SPACER, PHONE_SHEET, false)).toEqual({ left: 0, top: 78, width: 390, height: 422 });
  });

  it("keeps the full cell when the sheet is collapsed to its handle", () => {
    const collapsed = { left: 0, top: 808, width: 390, height: 36 };
    expect(viewportRectFor(PHONE_SPACER, collapsed, true)).toEqual(PHONE_SPACER);
  });

  it("never returns a degenerate rect — a zero-height cell would divide by zero downstream", () => {
    const rect = viewportRectFor({ left: 0, top: 78, width: 0, height: 0 }, PHONE_SHEET, false);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it("ignores a missing inspector (mid-teardown) rather than collapsing the viewport", () => {
    expect(viewportRectFor(PHONE_SPACER, null, false)).toEqual(PHONE_SPACER);
  });
});

/**
 * Shell smoke: a real shell over a NullEngine scene, opened on the cheapest
 * built-in tool (Problems builds no 3D content). Every heavier panel is only
 * constructed when its tab is shown, so this never drags MapEditor in.
 */
function openShell(): { shell: EditorShell; canvas: HTMLCanvasElement; resize: ReturnType<typeof vi.fn>; dispose: () => void } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const canvas = document.createElement("canvas");
  vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(canvas);
  const resize = vi.fn();
  vi.spyOn(engine, "resize").mockImplementation(resize);
  const host = {
    scene,
    configService: { getAll: () => [], get: () => undefined },
    bus: { on: () => () => {} },
    pauseSim: vi.fn(),
    resumeSim: vi.fn(),
    rebuildArena: vi.fn(),
    setGameVisible: vi.fn(),
    setArenaVisible: vi.fn(),
    setSpawnMarkersForced: vi.fn(),
    setPropPickingForced: vi.fn(),
    launchPlaytest: vi.fn(),
    suspendCameraGestures: vi.fn(),
  } as unknown as EditorHost;
  localStorage.setItem("sa-editor.tab", "Problems");
  const shell = new EditorShell(host);
  shell.toggle();
  return { shell, canvas, resize, dispose: () => { scene.dispose(); engine.dispose(); } };
}

const BUILT_IN_TOOLS = ["Map", "Inspector", "Tuning", "Ships", "Balance", "Assets", "Actions", "Notifications", "Bots", "Modes", "Theme", "Quality", "Console", "Problems"];
const dummyPanel = (): { element: HTMLElement; dispose: () => void } => ({ element: document.createElement("div"), dispose: () => {} });

const shells: (() => void)[] = [];
afterEach(() => { for (const dispose of shells.splice(0)) dispose(); vi.restoreAllMocks(); });

describe("EditorShell chrome", () => {
  it("groups the tool set behind a category row and opens the stored tab's category", () => {
    const { shell, dispose } = openShell();
    shells.push(dispose);
    const root = document.getElementById("space-arena-editor")!;
    const groups = [...root.querySelectorAll<HTMLElement>(".ed-nav-group")].map((b) => b.textContent);
    expect(groups).toEqual(["World", "Ships", "Content", "Balance", "System"]);
    // Problems lives in System, so that category — not the first one — is active.
    expect(root.querySelector(".ed-nav-group.is-active")?.textContent).toBe("System");
    const tools = [...root.querySelectorAll<HTMLElement>(".ed-toolrow .ed-tab")].map((b) => b.textContent);
    expect(tools).toEqual(["Theme", "Quality", "Console", "Problems"]);
    expect(root.querySelector(".ed-toolrow .ed-tab.is-active")?.textContent).toBe("Problems");
    // Validation status and Exit are never navigated away from.
    expect(root.querySelector(".ed-status")).not.toBeNull();
    expect(root.querySelector(".ed-btn--danger")?.textContent).toContain("Exit");
    shell.close();
  });

  it("insets the render canvas while open and hands it back untouched on close", () => {
    const { shell, canvas, resize, dispose } = openShell();
    shells.push(dispose);
    expect(canvas.style.position).toBe("fixed");
    expect(canvas.style.width).not.toBe("");
    expect(resize).toHaveBeenCalled();
    shell.close();
    // Restored verbatim: a match must never inherit the editor's split canvas.
    for (const key of ["position", "left", "top", "right", "bottom", "width", "height"] as const) {
      expect(canvas.style[key]).toBe("");
    }
    expect(document.getElementById("space-arena-editor")).toBeNull();
  });

  it("puts a 2-argument registration in its named group and honours an explicit hint", () => {
    const { shell, dispose } = openShell();
    shells.push(dispose);
    // Navigating every category would build every real tool against a stub
    // host; the grouping is what is under test, so swap the bodies out.
    for (const name of BUILT_IN_TOOLS) shell.registerPanel(name, dummyPanel);
    shell.registerPanel("Modules", dummyPanel);
    shell.registerPanel("Widgets", dummyPanel, "World");
    shell.close();
    shell.toggle();
    const root = document.getElementById("space-arena-editor")!;
    const groupOf = (tool: string): string | undefined =>
      [...root.querySelectorAll<HTMLElement>(".ed-nav-group")]
        .map((b) => b.textContent ?? "")
        .find((group) => {
          (root.querySelector<HTMLElement>(`.ed-nav-group[data-group="${group}"]`))?.click();
          return [...root.querySelectorAll<HTMLElement>(".ed-toolrow .ed-tab")].some((t) => t.textContent === tool);
        });
    expect(groupOf("Widgets")).toBe("World");
    expect(groupOf("Modules")).toBe("Ships");
    shell.close();
  });
});
