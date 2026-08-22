import { NullEngine, Observable, Scene, type GizmoManager } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import { bindGizmoSocketCommit, roundMarkerValue, ShipManager } from "./ShipManager.js";

/** Minimal stand-in for the three gizmos a GizmoManager exposes. */
function fakeGizmo(): { onDragEndObservable: Observable<unknown> } {
  return { onDragEndObservable: new Observable() };
}

function fakeManager(): { manager: GizmoManager; gizmos: ReturnType<typeof fakeGizmo>[] } {
  const position = fakeGizmo();
  const rotation = fakeGizmo();
  const scale = fakeGizmo();
  const manager = {
    gizmos: { positionGizmo: position, rotationGizmo: rotation, scaleGizmo: scale },
  } as unknown as GizmoManager;
  return { manager, gizmos: [position, rotation, scale] };
}

describe("bindGizmoSocketCommit", () => {
  it("commits every drag after the preview marker is rebuilt", () => {
    const { manager, gizmos } = fakeManager();
    const commit = vi.fn();
    bindGizmoSocketCommit(manager, commit);

    // Before the fix, select() used addOnce(). The first commit rebuilt the
    // marker without re-arming the observer, so this second drag was lost.
    gizmos[0]!.onDragEndObservable.notifyObservers(null);
    gizmos[0]!.onDragEndObservable.notifyObservers(null);

    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("binds every transform gizmo and removes all observers on teardown", () => {
    const { manager, gizmos } = fakeManager();
    const commit = vi.fn();
    const unbind = bindGizmoSocketCommit(manager, commit);

    for (const gizmo of gizmos) gizmo.onDragEndObservable.notifyObservers(null);
    expect(commit).toHaveBeenCalledTimes(3);

    unbind();
    for (const gizmo of gizmos) {
      gizmo.onDragEndObservable.notifyObservers(null);
      expect(gizmo.onDragEndObservable.hasObservers()).toBe(false);
    }
    expect(commit).toHaveBeenCalledTimes(3);
  });
});

describe("socket marker serialization", () => {
  it("rounds float32 transform noise to four decimal places", () => {
    expect(roundMarkerValue(-0.4000000059604645)).toBe(-0.4);
    expect(roundMarkerValue(0.8294861316680908)).toBe(0.8295);
    expect(roundMarkerValue(-1.3632718324661255)).toBe(-1.3633);
  });
});

describe("ShipManager accordions", () => {
  const module = {
    id: "module.laser", type: "module", version: 1, name: "Laser", family: "laser", level: 1,
    activation: { deployTime: 0, retractTime: 0 }, ui: { icon: "laser", label: "Laser" }, price: 0, requiresLevel: 1,
  } satisfies ModuleConfig;
  /** Shaped like a shipped hull (content/ships/*.json), trimmed to one socket. */
  const ship = {
    id: "ship.test", type: "ship", version: 1, name: "Test", class: "heavy",
    core: {
      hull: { base: 195, resists: { kinetic: 0.25, energy: 0.15 } },
      engine: { nominalSpeed: 16, accel: 7, turnRate: 1 },
      recharge: { multiplier: 1 }, energyStore: { multiplier: 1 },
      power: { capacity: 14 }, efficiency: { energyDraw: 1 },
      sensors: { lockRange: 125, lockTimeSec: 1.5, coneDeg: 120 },
    },
    upgradeTracks: { hull: "upgrade.hull-std", engine: "upgrade.engine-std", energy: "upgrade.energy-std" },
    defaultFitting: ["module.laser"],
    render: { recipe: "procedural.brawler", palette: { primary: "#b8542f", accent: "#ffb257" } },
    collider: { shape: "circle", radius: 2.1 },
    sockets: [{ id: "s0", kind: "hardpoint", transform: { pos: [0, 0, 1] }, accepts: ["laser"] }],
  } as unknown as ShipConfig;

  function panel(): { manager: ShipManager; scene: Scene; engine: NullEngine } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const configService = {
      get: (type: string, id: string) => (type === "ship" && id === ship.id ? ship : type === "module" && id === module.id ? module : undefined),
      getAll: (type: string) => (type === "ship" ? [ship] : type === "module" ? [module] : []),
      replace: vi.fn(() => ({ ok: true as const, errors: [] })),
    } as unknown as ConfigService;
    const host = {
      scene, configService, bus: { on: () => () => {} },
      suspendCameraGestures() {}, setArenaVisible() {}, setPropPickingForced() {}, setSpawnMarkersForced() {},
      setGameVisible() {}, pauseSim() {}, resumeSim() {}, rebuildArena() {},
    } as unknown as EditorHost;
    return { manager: new ShipManager(host, vi.fn()), scene, engine };
  }

  it("opens every one of its eleven sections folded", () => {
    const { manager, scene, engine } = panel();

    const sections = [...manager.element.querySelectorAll<HTMLDetailsElement>("details")];
    expect(sections.length).toBeGreaterThan(5);
    // Model, emissive, camera, combat, skins, sockets, fitting, core stats…
    // opening them all made every ship a wall with the edit buried mid-scroll.
    expect(sections.filter((s) => s.open)).toEqual([]);
    // Folded, the summary is the only thing naming the section — it must exist.
    expect(sections.every((s) => (s.querySelector("summary")?.textContent ?? "").length > 0)).toBe(true);

    manager.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("offers every module family as an accepts checkbox, new ones included", () => {
    // The socket editor's family list is `moduleFamily.options`, so the two
    // support families (2026-08-22) became authorable the moment the enum grew.
    // Pinned because the alternative — a hand-written list here — is exactly the
    // thing that silently stops matching the schema.
    const { manager, scene, engine } = panel();
    // The accepts list lives on the SELECTED socket, so select the hull's one
    // hardpoint first (the same click a designer makes in the socket list).
    const pick = [...manager.element.querySelectorAll<HTMLButtonElement>("button.ed-list-btn")]
      .find((b) => (b.textContent ?? "").includes("s0"))!;
    pick.click();
    const labels = [...manager.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .map((b) => b.parentElement?.textContent?.trim());
    expect(labels).toContain("disruptor");
    expect(labels).toContain("repair");

    manager.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("shows the emissive light map gap rather than letting a hull ship without one", () => {
    // Owner 2026-08-22: every ship is meant to have an emissive light texture.
    // Nothing enforces it (the owner paints the images over time), so this row
    // is the only place the gap surfaces while a hull is being authored.
    const { manager, scene, engine } = panel();
    const box = manager.element.querySelector<HTMLElement>("[data-emissive-texture]")!;

    // This hull wires no emissive element at all: nowhere to put a map.
    expect(box.querySelector(".ed-warn")?.textContent).toContain("nowhere to put an emissive map");
    expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");

    manager.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("keeps a section the designer opened open across renderUi's rebuild", () => {
    const { manager, scene, engine } = panel();
    const titleOf = (d: HTMLDetailsElement): string => d.querySelector("summary")?.textContent ?? "";
    const sockets = [...manager.element.querySelectorAll<HTMLDetailsElement>("details")].find((d) => titleOf(d) === "Sockets")!;

    sockets.open = true;
    sockets.dispatchEvent(new Event("toggle"));
    // Selecting a socket rebuilds the whole panel.
    (manager as unknown as { select(index: number): void }).select(0);

    const rebuilt = [...manager.element.querySelectorAll<HTMLDetailsElement>("details")].find((d) => titleOf(d) === "Sockets")!;
    expect(rebuilt).not.toBe(sockets);
    expect(rebuilt.open).toBe(true);

    manager.dispose();
    scene.dispose();
    engine.dispose();
  });
});
