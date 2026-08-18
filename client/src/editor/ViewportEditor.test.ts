import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, NullEngine, Scene, Vector3, type AbstractMesh } from "@babylonjs/core";
import { buildBundle, type AnyConfig, type ArenaConfig, type ContentBundle, type ShipConfig } from "@space-arena/shared";
import { DraftPackStore } from "./DraftPackStore.js";
import { ConstellationViewport, type ConstellationHost } from "./ConstellationViewport.js";
import { ViewportEditor, arrayFieldOf, editableTypeOf } from "./ViewportEditor.js";

/**
 * The session is driven through its private surface, exactly as the retired
 * MapEditor test drove that panel: the public API is "the catalogue selected
 * this config", and everything interesting happens in response to a pointer
 * pick or a gizmo drag that a NullEngine cannot produce.
 */
interface Driver {
  armed: { kind: "asteroid" | "prop"; id: string } | "nav" | null;
  navSelection: number[];
  layers: Map<string, { visible: boolean; locked: boolean }>;
  gameView: boolean;
  place(point: Vector3): void;
  selectPlacement(kind: string, index: number, mesh: AbstractMesh): void;
  selectSocket(index: number, mesh: AbstractMesh): void;
  commitFromGizmo(): void;
  duplicateSelection(): void;
  deleteSelection(): void;
  commitNavLink(): void;
  toggleGameView(): void;
  canSelect(kind: string, index: number): boolean;
}
function drive(editor: ViewportEditor): Driver { return editor as unknown as Driver; }

function repoFile(relative: string): string {
  for (const prefix of ["", "..", "../.."]) {
    const candidate = resolve(process.cwd(), prefix, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${relative} from ${process.cwd()}`);
}

function contentJson(relative: string): AnyConfig {
  return JSON.parse(readFileSync(repoFile(`content/${relative}`), "utf8")) as AnyConfig;
}

const ARENA_PATH = "arenas/lunar-rift.json";
const SHIP_PATH = "ships/interceptor.json";
/** A terrain chunk and an ordinary rock, both really shipped. */
const TERRAIN_PROP = "prop.lunar-rift-chunk-0";
const ROCK_PROP = "prop.lunar-rift-boulder-a";

let pack: ContentBundle;

/**
 * The shipped interceptor with its GLB reference dropped, keeping its real
 * socket graph and fitting. Staging a hull with a `model` sends the registry off
 * to import a binary the test has no server for — a five-second connect timeout
 * per case, and nothing a NullEngine could render at the end of it. The socket
 * editing under test is identical either way.
 */
function proceduralInterceptor(): ShipConfig {
  const ship = contentJson("ships/interceptor.json") as ShipConfig;
  const render = { ...ship.render };
  delete render.model;
  delete render.modelScale;
  delete render.modelRotationY;
  delete render.lods;
  return { ...ship, render };
}

beforeAll(async () => {
  const files: Record<string, unknown> = {
    [ARENA_PATH]: contentJson("arenas/lunar-rift.json"),
    [SHIP_PATH]: proceduralInterceptor(),
    "props/lunar-rift-chunk-0.json": contentJson("props/lunar-rift-chunk-0.json"),
    "props/lunar-rift-boulder-a.json": contentJson("props/lunar-rift-boulder-a.json"),
    "asteroids/small-rock.json": contentJson("asteroids/small-rock.json"),
  };
  pack = await buildBundle({ id: "manifest.test", type: "manifest", version: 1, name: "Test", files: Object.keys(files) }, files);
});

const engines: NullEngine[] = [];

/** The host surface, all of it spied — the scene half of the port's contract. */
type HostCalls = Record<Exclude<keyof ConstellationHost, "scene">, ReturnType<typeof vi.fn>>;

interface Harness {
  editor: ViewportEditor;
  viewport: ConstellationViewport;
  draft: DraftPackStore;
  scene: Scene;
  host: ConstellationHost;
  calls: HostCalls;
  onDraftEdit: ReturnType<typeof vi.fn>;
  onReveal: ReturnType<typeof vi.fn>;
  onReport: ReturnType<typeof vi.fn>;
  /** Select a config the way the catalogue does: policy first, then stage. */
  open(path: string): Promise<void>;
  arena(): ArenaConfig;
  ship(): ShipConfig;
  marker(kind: string, index: number): AbstractMesh;
}

function harness(): Harness {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new ArcRotateCamera("cam", 0, 1, 50, Vector3.Zero(), scene);
  const calls: HostCalls = {
    setGameVisible: vi.fn(), setArenaVisible: vi.fn(), pauseSim: vi.fn(), resumeSim: vi.fn(),
    stageArena: vi.fn(), setSpawnMarkersForced: vi.fn(), setPropPickingForced: vi.fn(), suspendCameraGestures: vi.fn(),
  };
  const host: ConstellationHost = { scene, ...calls };
  const viewport = new ConstellationViewport(host);
  const draft = new DraftPackStore(structuredClone(pack));
  const onDraftEdit = vi.fn();
  const onReveal = vi.fn();
  const onReport = vi.fn();
  const editor = new ViewportEditor({ host, viewport, draft: () => draft, onDraftEdit, onReveal, onReport });

  const configAt = (path: string): AnyConfig => draft.snapshot().files[path] as AnyConfig;
  return {
    editor, viewport, draft, scene, host, calls, onDraftEdit, onReveal, onReport,
    async open(path) {
      const config = configAt(path);
      editor.setSubject(path, config);
      await viewport.show(config, (type, id) => Object.values(draft.snapshot().files)
        .find((file): file is AnyConfig => (file as { type?: unknown; id?: unknown }).type === type && (file as { id?: unknown }).id === id));
      editor.afterStage();
    },
    arena: () => configAt(ARENA_PATH) as ArenaConfig,
    ship: () => configAt(SHIP_PATH) as ShipConfig,
    marker(kind, index) {
      const mesh = viewport.markerFor(kind as "prop", index);
      if (!mesh) throw new Error(`no marker for ${kind}.${index}`);
      return mesh;
    },
  };
}

let live: Harness | null = null;

beforeEach(() => { localStorage.clear(); });

afterEach(() => {
  live?.editor.dispose();
  live?.viewport.dispose();
  live = null;
  for (const engine of engines.splice(0)) engine.dispose();
  document.body.replaceChildren();
});

describe("editable subjects", () => {
  it("claims arenas and ships, and nothing else", () => {
    expect(editableTypeOf({ type: "arena" } as AnyConfig)).toBe("arena");
    expect(editableTypeOf({ type: "ship" } as AnyConfig)).toBe("ship");
    for (const type of ["module", "asteroid", "prop", "tuning", "theme"]) {
      expect(editableTypeOf({ type } as AnyConfig)).toBeNull();
    }
  });

  it("maps each placement kind to the draft field the form column holds", () => {
    expect(arrayFieldOf("asteroid")).toBe("asteroidPlacements");
    expect(arrayFieldOf("prop")).toBe("propPlacements");
    expect(arrayFieldOf("spawn")).toBe("spawnPoints");
    expect(arrayFieldOf("flag")).toBe("flagBases");
    expect(arrayFieldOf("nav")).toBe("navGraph.nodes");
  });
});

describe("arena session", () => {
  it("stages the edited arena and makes its real props selectable", async () => {
    live = harness();
    await live.open(ARENA_PATH);

    // "Stage the edited arena": SceneBuilder is handed the DRAFT config, not an
    // id it would resolve out of a registry that has never seen this draft.
    expect(live.calls.stageArena).toHaveBeenCalledTimes(1);
    expect((live.calls.stageArena.mock.calls[0]![0] as ArenaConfig).id).toBe("arena.lunar-rift");
    expect(live.calls.setPropPickingForced).toHaveBeenLastCalledWith(true);
    expect(live.calls.setSpawnMarkersForced).toHaveBeenLastCalledWith(true);
    expect(live.calls.setArenaVisible).toHaveBeenLastCalledWith(true);
  });

  it("makes placement markers pickable and tagged with their draft index", async () => {
    live = harness();
    await live.open(ARENA_PATH);

    const spawn = live.marker("spawn", 1);
    expect(spawn.metadata).toEqual({ editorKind: "spawn", editorIndex: 1 });
    expect(spawn.isPickable).toBe(true);
    // Terrain is locked by default, so the floor never answers a stray click.
    const terrainIndex = live.arena().propPlacements!.findIndex((placement) => placement.propId === TERRAIN_PROP);
    expect(terrainIndex).toBeGreaterThanOrEqual(0);
    expect(live.marker("prop", terrainIndex).isPickable).toBe(false);
    expect(drive(live.editor).canSelect("prop", terrainIndex)).toBe(false);
  });

  it("drops an armed asset and its mirrored twin straight into the draft", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const before = live.arena().propPlacements!.length;

    const subject = drive(live.editor);
    subject.armed = { kind: "prop", id: ROCK_PROP };
    subject.place(new Vector3(40.4, 2.2, -60.6));

    const placements = live.arena().propPlacements!;
    expect(placements).toHaveLength(before + 2);
    expect(placements[before]!.position).toEqual({ x: 40, y: 2, z: -61 });
    // Mirror mode reflects through the origin and spins a half turn.
    expect(placements[before + 1]!.position).toEqual({ x: -40, y: 2, z: 61 });
    // And every edit is a draft edit: the dirty badge and Save just work.
    expect(live.draft.isDirty()).toBe(true);
    expect(live.draft.dirtyPaths()).toEqual([ARENA_PATH]);
    expect(live.onDraftEdit).toHaveBeenCalled();
  });

  it("locks a dropped terrain prop so it lands in the Terrain layer", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const before = live.arena().propPlacements!.length;

    const subject = drive(live.editor);
    subject.armed = { kind: "prop", id: TERRAIN_PROP };
    subject.place(new Vector3(0, 0, 0));

    expect(live.arena().propPlacements![before]!.locked).toBe(true);
    expect(subject.canSelect("prop", before)).toBe(false);
    // The Terrain layer row is the way in — unlock it and the ground moves.
    subject.layers.get("terrain")!.locked = false;
    expect(subject.canSelect("prop", before)).toBe(true);
  });

  it("writes a gizmo drag back into the draft, mirror included", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);
    subject.armed = { kind: "prop", id: ROCK_PROP };
    subject.place(new Vector3(40, 0, 0));
    subject.armed = null;
    const index = live.arena().propPlacements!.length - 2;
    await live.viewport.restage(live.arena());

    const mesh = live.marker("prop", index);
    subject.selectPlacement("prop", index, mesh);
    mesh.position.set(60, 3, -9);
    mesh.rotation.y = 0.5;
    mesh.scaling.setAll(2);
    subject.commitFromGizmo();

    const placements = live.arena().propPlacements!;
    expect(placements[index]!.position).toEqual({ x: 60, y: 3, z: -9 });
    expect(placements[index]!.scale).toBe(2);
    // 0.5 rad snapped to the nearest 15°.
    expect(placements[index]!.rotation!.y).toBeCloseTo(Math.PI / 12 * 2, 4);
    // The twin follows every edit while mirror mode is on.
    expect(placements[index + 1]!.position.x).toBe(-60);
    expect(placements[index + 1]!.scale).toBe(2);
  });

  it("keeps the selection and its context card alive across a commit", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);

    subject.selectPlacement("spawn", 0, live.marker("spawn", 0));
    const card = document.querySelector<HTMLElement>(".ed-ctx")!;
    expect(card.style.display).not.toBe("none");
    expect(card.querySelector(".ed-ctx-title")!.textContent).toBe("Spawn #0");

    const mesh = live.marker("spawn", 0);
    mesh.position.set(30, 0, 30);
    subject.commitFromGizmo();
    // The commit rebuilt every marker; the handles and the card must survive it.
    await Promise.resolve();
    expect(document.querySelector<HTMLElement>(".ed-ctx")!.style.display).not.toBe("none");
    expect(live.arena().spawnPoints[0]!.position).toMatchObject({ x: 30, z: 30 });
  });

  it("duplicates and deletes a placement, twin and all", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);
    subject.armed = { kind: "asteroid", id: "asteroid.small-rock" };
    subject.place(new Vector3(20, 0, 20));
    subject.armed = null;
    expect(live.arena().asteroidPlacements).toHaveLength(2);
    await live.viewport.restage(live.arena());

    subject.selectPlacement("asteroid", 0, live.marker("asteroid", 0));
    subject.duplicateSelection();
    // One duplicate plus its own mirror.
    expect(live.arena().asteroidPlacements).toHaveLength(4);

    await live.viewport.restage(live.arena());
    subject.selectPlacement("asteroid", 0, live.marker("asteroid", 0));
    subject.deleteSelection();
    expect(live.arena().asteroidPlacements).toHaveLength(2);
  });

  it("refuses to delete the last spawn instead of writing an invalid draft", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);
    // Reduce the draft to one spawn, then try to remove it.
    const lean = structuredClone(live.arena());
    lean.spawnPoints = [lean.spawnPoints[0]!];
    live.draft.setFile(ARENA_PATH, lean);
    live.editor.setSubject(ARENA_PATH, live.arena());
    await live.viewport.restage(live.arena());

    subject.selectPlacement("spawn", 0, live.marker("spawn", 0));
    subject.deleteSelection();

    expect(live.arena().spawnPoints).toHaveLength(1);
    expect(live.onReport).toHaveBeenCalledWith("An arena needs at least one spawn point.");
  });

  it("links and unlinks two selected nav nodes", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);
    const before = live.arena().navGraph!.links.length;
    // Two nodes with no authored link between them.
    const nodes = live.arena().navGraph!.nodes;
    const pair = [0, nodes.findIndex((node, index) => index > 0
      && !live!.arena().navGraph!.links.some((link) => link.includes(nodes[0]!.id) && link.includes(node.id)))];
    subject.navSelection = pair;

    subject.commitNavLink();
    expect(live.arena().navGraph!.links.length).toBeGreaterThan(before);
    subject.navSelection = pair;
    subject.commitNavLink();
    expect(live.arena().navGraph!.links).toHaveLength(before);
  });

  it("hides a layer's markers and restores them", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);
    expect(live.viewport.markerFor("spawn", 0)).not.toBeNull();

    subject.layers.get("spawn")!.visible = false;
    await live.viewport.restage(live.arena());
    expect(live.viewport.markerFor("spawn", 0)).toBeNull();

    subject.layers.get("spawn")!.visible = true;
    await live.viewport.restage(live.arena());
    expect(live.viewport.markerFor("spawn", 0)).not.toBeNull();
  });

  it("game view drops every piece of authoring furniture and restores it", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const subject = drive(live.editor);
    subject.selectPlacement("spawn", 0, live.marker("spawn", 0));
    expect(document.querySelector<HTMLElement>(".ed-ctx")!.style.display).not.toBe("none");

    subject.toggleGameView();
    expect(subject.gameView).toBe(true);
    expect(live.scene.getTransformNodeByName("constellationViewport")!.isEnabled()).toBe(false);
    expect(live.calls.setSpawnMarkersForced).toHaveBeenLastCalledWith(false);
    expect(document.querySelector<HTMLElement>(".ed-ctx")!.style.display).toBe("none");

    subject.toggleGameView();
    expect(live.scene.getTransformNodeByName("constellationViewport")!.isEnabled()).toBe(true);
    expect(live.calls.setSpawnMarkersForced).toHaveBeenLastCalledWith(true);
    expect(document.querySelector<HTMLElement>(".ed-ctx")!.style.display).not.toBe("none");
  });

  it("offers the layer, place and transform controls as folded tool groups", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    const rail = live.editor.element;

    expect(rail.querySelectorAll(".ed-layer-row")).toHaveLength(7);
    expect(rail.querySelector<HTMLElement>('[data-layer="terrain"] [data-check="locked"]')!)
      .toHaveProperty("checked", true);
    // Constellation's convention: everything folded except the one control an
    // arena session reaches for first.
    expect(rail.querySelector<HTMLDetailsElement>('[data-accordion="layers"]')!.open).toBe(true);
    expect(rail.querySelector<HTMLDetailsElement>('[data-accordion="place"]')!.open).toBe(false);
    expect(rail.querySelector<HTMLDetailsElement>('[data-accordion="transform"]')!.open).toBe(false);
    expect(rail.querySelector<HTMLButtonElement>('[data-action="game-view"]')!.textContent).toBe("Game view (G)");
  });

  it("deep-links the form column to the placement it just selected", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    drive(live.editor).selectPlacement("prop", 5, live.marker("prop", 5));
    expect(live.onReveal).toHaveBeenCalledWith("propPlacements.5");
  });
});

describe("ship session", () => {
  it("makes socket markers pickable and releases the arena overrides", async () => {
    live = harness();
    await live.open(SHIP_PATH);

    const marker = live.viewport.socketMarkerFor(0)!;
    expect(marker.metadata).toEqual({ socketIndex: 0 });
    expect(marker.isPickable).toBe(true);
    expect(live.viewport.socketMarkers().size).toBe(live.ship().sockets.length);
    expect(live.calls.setPropPickingForced).toHaveBeenLastCalledWith(false);
    expect(live.calls.setSpawnMarkersForced).toHaveBeenLastCalledWith(false);
    // A staged ship wants the clean grid, not the arena.
    expect(live.calls.setArenaVisible).toHaveBeenLastCalledWith(false);
  });

  it("writes a socket gizmo drag into the draft, rounded to four places", async () => {
    live = harness();
    await live.open(SHIP_PATH);
    const marker = live.viewport.socketMarkerFor(0)!;
    drive(live.editor).selectSocket(0, marker);

    marker.position.set(0.8294861316680908, -0.4000000059604645, 1.5);
    marker.rotation.set(0, 0.25, 0);
    marker.scaling.setAll(1);
    drive(live.editor).commitFromGizmo();

    expect(live.ship().sockets[0]!.transform).toEqual({ pos: [0.8295, -0.4, 1.5], rot: [0, 0.25, 0] });
    expect(live.draft.dirtyPaths()).toEqual([SHIP_PATH]);
  });

  it("shows the socket card with its fitted slot and deep-links the heavy editors", async () => {
    live = harness();
    await live.open(SHIP_PATH);
    // Array index 7 is the third hardpoint but the EIGHTH fitted slot: the
    // internals between them share the fitting's index space.
    drive(live.editor).selectSocket(7, live.viewport.socketMarkerFor(7)!);

    const card = document.querySelector<HTMLElement>(".ed-ctx")!;
    expect(card.querySelector(".ed-ctx-title")!.textContent).toBe(`#7 ${live.ship().sockets[7]!.id}`);
    expect(card.textContent).toContain("#7");
    expect(live.onReveal).toHaveBeenCalledWith("sockets.7");

    card.querySelectorAll<HTMLButtonElement>(".ed-ctx-link")[0]!.click();
    expect(live.onReveal).toHaveBeenLastCalledWith("sockets.7");
  });

  it("duplicates and deletes a socket from the card's actions", async () => {
    live = harness();
    await live.open(SHIP_PATH);
    const before = live.ship().sockets.length;
    drive(live.editor).selectSocket(8, live.viewport.socketMarkerFor(8)!);

    drive(live.editor).duplicateSelection();
    expect(live.ship().sockets).toHaveLength(before + 1);

    await live.viewport.restage(live.ship());
    drive(live.editor).selectSocket(9, live.viewport.socketMarkerFor(9)!);
    drive(live.editor).deleteSelection();
    expect(live.ship().sockets).toHaveLength(before);
  });
});

describe("switching subjects", () => {
  it("releases the staged draft arena when the catalogue moves to a ship", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    expect(live.calls.stageArena).toHaveBeenLastCalledWith(expect.objectContaining({ id: "arena.lunar-rift" }));

    await live.open(SHIP_PATH);

    // Otherwise the previous map's floor and skybox stay behind the hull.
    expect(live.calls.stageArena).toHaveBeenLastCalledWith(null);
    expect(live.calls.setPropPickingForced).toHaveBeenLastCalledWith(false);
  });

  it("leaves game view behind rather than stranding the next subject in it", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    drive(live.editor).toggleGameView();
    expect(drive(live.editor).gameView).toBe(true);

    await live.open(SHIP_PATH);

    // Game view has one exit, and it lives on the arena rail — a ship session
    // inheriting it would have unpickable sockets and no way to fix that.
    expect(drive(live.editor).gameView).toBe(false);
    expect(live.viewport.socketMarkerFor(0)!.isPickable).toBe(true);
  });

  it("keeps the selection when the same config is re-announced after an edit", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    drive(live.editor).selectPlacement("spawn", 0, live.marker("spawn", 0));

    // What `GenericConfigPanel.render(false)` does after a viewport commit.
    live.editor.setSubject(ARENA_PATH, live.arena());
    live.editor.afterStage();

    expect(document.querySelector<HTMLElement>(".ed-ctx")!.style.display).not.toBe("none");
  });
});

describe("teardown", () => {
  it("hands the scene back: draft staging released, overrides cleared", async () => {
    live = harness();
    await live.open(ARENA_PATH);
    live.editor.dispose();

    expect(live.calls.stageArena).toHaveBeenLastCalledWith(null);
    expect(live.calls.setPropPickingForced).toHaveBeenLastCalledWith(false);
    expect(live.calls.setSpawnMarkersForced).toHaveBeenLastCalledWith(false);
    // The camera can never be left frozen by a session that died mid-drag.
    expect(live.calls.suspendCameraGestures).toHaveBeenLastCalledWith(false);
    expect(document.querySelector(".ed-ctx")).toBeNull();
    live.viewport.dispose();
    live = null;
  });
});
