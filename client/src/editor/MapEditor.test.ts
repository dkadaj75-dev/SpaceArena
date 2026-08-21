// @vitest-environment happy-dom
import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { ConfigService, EventBus, type ArenaConfig, type ConfigEvents } from "@space-arena/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorAsteroidPosition, MapEditor, mapEditorOps, playtestArenaProblems } from "./MapEditor.js";

describe("MapEditor asteroid placement", () => {
  it("authors the selected y altitude while snapping only the picked plane axes", () => {
    expect(authorAsteroidPosition({ x: 12.6, z: -7.4 }, 125, true, 1)).toEqual({
      x: 13,
      y: 125,
      z: -7,
    });
  });
});

const notification = { id: "notification.boundary-warning", type: "notification", version: 1, text: "Boundary", style: "critical", durationMs: 1000 };
const asteroid = { id: "asteroid.rock", type: "asteroid", version: 1, name: "Rock", radius: 3, colliderScale: 1, destructible: false, impactDamage: 0, render: { recipe: "procedural.rock" } };
const prop = { id: "prop.block", type: "prop", version: 1, name: "Block", category: "structure", impactDamage: 0, render: { recipe: "model.static", model: "props/block.glb", modelScale: 1 } };
const terrainProp = { id: "prop.ground", type: "prop", version: 1, name: "Ground", category: "terrain", impactDamage: 0, render: { recipe: "model.static", model: "props/ground.glb", modelScale: 1 } };
const arena = {
  id: "arena.editor-test", type: "arena", version: 1, name: "Editor test", bounds: { shape: "box", width: 100, height: 100, floorY: -20, ceilingY: 30 },
  asteroidPlacements: [], propPlacements: [], navGraph: { nodes: [], links: [] },
  spawnPoints: [{ id: "spawn-a", team: 0, position: { x: -10, y: 0, z: 0 }, heading: 0 }, { id: "spawn-b", team: 1, position: { x: 10, y: 0, z: 0 }, heading: Math.PI }],
  flagBases: [{ id: "flag-a", team: 0, position: { x: -20, y: 0, z: 0 }, radius: 5 }, { id: "flag-b", team: 1, position: { x: 20, y: 0, z: 0 }, radius: 5 }],
  lighting: { ambientColor: "#111111", ambientIntensity: .4, directionalIntensity: .8 },
  render: { skybox: { texture: "sky.webp", intensity: 1, tint: "#ffffff" }, boundaryShield: { baseOpacity: .2, glowStartDistance: 10, redTransitionDistance: 5, warnDistance: 8, blueColor: "#00aaff", redColor: "#ff0000", hexDensity: 20, hexLineWidth: .01, warningNotification: "notification.boundary-warning" } }, zones: [],
} satisfies ArenaConfig;

interface MapEditorTestDriver {
  armed: { kind: "asteroid" | "prop"; id: string } | "nav" | null;
  navSelection: number[];
  layers: Map<string, { visible: boolean; locked: boolean }>;
  gameView: boolean;
  place(point: Vector3): void;
  select(kind: "asteroid" | "prop" | "spawn" | "flag" | "nav", index: number, mesh: import("@babylonjs/core").AbstractMesh): void;
  commitTransform(): void;
  duplicateSelected(): void;
  removeSelected(): void;
  toggleNavLink(): void;
  toggleGameView(): void;
  canSelect(kind: string, index: number): boolean;
  save(): Promise<void>;
}
function driver(editor: MapEditor): MapEditorTestDriver { return editor as unknown as MapEditorTestDriver; }

describe("MapEditor placement session", () => {
  let engine: NullEngine; let scene: Scene; let configs: ConfigService; let editor: MapEditor;
  let setSpawnMarkersForced: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    engine = new NullEngine(); scene = new Scene(engine); configs = new ConfigService(() => Promise.resolve(null), new EventBus<ConfigEvents>());
    setSpawnMarkersForced = vi.fn();
    for (const config of [notification, asteroid, prop, terrainProp, arena]) expect(configs.replace(config).ok).toBe(true);
    editor = new MapEditor({ scene, configService: configs, bus: new EventBus(), pauseSim() {}, resumeSim() {}, rebuildArena() {}, setGameVisible() {}, setArenaVisible() {}, setSpawnMarkersForced, setPropPickingForced() {}, suspendCameraGestures() {}, launchPlaytest: vi.fn() }, vi.fn());
  });
  afterEach(() => { editor.dispose(); scene.dispose(); engine.dispose(); document.body.replaceChildren(); });

  it("adds, moves, duplicates and deletes mirrored prop placements in the config draft", () => {
    const subject = driver(editor); subject.armed = { kind: "prop", id: "prop.block" }; subject.place(new Vector3(4.4, 2.2, -7.6));
    let draft = configs.get<ArenaConfig>("arena", arena.id)!; expect(draft.propPlacements).toHaveLength(2); expect(draft.propPlacements![1]!.position).toEqual({ x: -4, y: 2, z: 8 });
    const mesh = scene.getMeshByName("editor.prop.0")!; subject.select("prop", 0, mesh); mesh.position.set(6, 3, -9); mesh.rotation.y = .5; mesh.scaling.setAll(2); subject.commitTransform();
    draft = configs.get("arena", arena.id)!; expect(draft.propPlacements![0]!.scale).toBe(2); expect(draft.propPlacements![1]!.position.x).toBe(-6);
    subject.select("prop", 0, scene.getMeshByName("editor.prop.0")!); subject.duplicateSelected(); expect(configs.get<ArenaConfig>("arena", arena.id)!.propPlacements).toHaveLength(4);
    subject.select("prop", 0, scene.getMeshByName("editor.prop.0")!); subject.removeSelected(); expect(configs.get<ArenaConfig>("arena", arena.id)!.propPlacements).toHaveLength(2);
  });

  it("writes spawn heading radians and links/unlinks selected nav nodes", () => {
    const subject = driver(editor); const spawn = scene.getMeshByName("editor.spawn.0")!; subject.select("spawn", 0, spawn); spawn.rotation.y = Math.PI / 3; subject.commitTransform();
    expect(configs.get<ArenaConfig>("arena", arena.id)!.spawnPoints[0]!.heading).toBeCloseTo(Math.PI / 3);
    subject.armed = "nav"; subject.place(new Vector3(0, 0, 0)); subject.place(new Vector3(10, 0, 0)); subject.navSelection = [0, 2]; subject.toggleNavLink();
    expect(configs.get<ArenaConfig>("arena", arena.id)!.navGraph!.links).toHaveLength(2); subject.toggleNavLink(); expect(configs.get<ArenaConfig>("arena", arena.id)!.navGraph!.links).toHaveLength(0);
  });

  it("filters layer and terrain locks before selection", () => {
    const subject = driver(editor); subject.layers.get("prop")!.locked = true; expect(subject.canSelect("prop", 0)).toBe(false); subject.layers.get("prop")!.locked = false;
    const terrainTwin = mapEditorOps.twinOf("spawn", arena.spawnPoints[0]!, structuredClone(arena)); expect(terrainTwin.team).toBe(1); expect(terrainTwin.heading).toBeCloseTo(Math.PI);
  });

  it("saves the current placement draft as the arena payload", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" }); vi.stubGlobal("fetch", fetch);
    const subject = driver(editor); subject.armed = { kind: "asteroid", id: "asteroid.rock" }; subject.place(new Vector3(3, 4, 5)); await subject.save();
    const request = fetch.mock.calls[0]![1] as RequestInit; const payload = JSON.parse(String(request.body));
    expect(payload.path).toBe("arenas/editor-test.json"); expect(payload.json.asteroidPlacements).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("blocks playtest launch when the arena schema is invalid", () => {
    expect(playtestArenaProblems({ ...arena, bounds: { shape: "box", width: 100, height: 100, floorY: 30, ceilingY: 20 } })).toContain("bounds.ceilingY: ceilingY must be greater than floorY");
  });

  it("routes terrain and locked props to the Terrain layer, locked by default", () => {
    const subject = driver(editor);
    subject.armed = { kind: "prop", id: "prop.ground" }; subject.place(new Vector3(0, 0, 4));
    subject.armed = { kind: "prop", id: "prop.block" }; subject.place(new Vector3(0, 0, 10));
    // Terrain placements default locked so stray clicks never drag the floor.
    expect(subject.canSelect("prop", 0)).toBe(false);
    expect(subject.canSelect("prop", 2)).toBe(true);
    // The Terrain layer row is the obvious way in — unlock and the ground moves.
    subject.layers.get("terrain")!.locked = false;
    expect(subject.canSelect("prop", 0)).toBe(true);
    // A hand-locked ordinary prop answers to the Terrain layer too.
    subject.layers.get("terrain")!.locked = true;
    const draft = structuredClone(configs.get<ArenaConfig>("arena", arena.id)!);
    draft.propPlacements![2]!.locked = true;
    expect(configs.replace(draft).ok).toBe(true);
    expect(subject.canSelect("prop", 2)).toBe(false);
  });

  it("game view hides the authoring furniture and restores selection on return", () => {
    const subject = driver(editor);
    subject.armed = { kind: "asteroid", id: "asteroid.rock" }; subject.place(new Vector3(3, 0, 5)); subject.armed = null;
    subject.select("asteroid", 0, scene.getMeshByName("editor.asteroid.0")! );
    expect(document.querySelector(".ed-ctx")).not.toBeNull();

    subject.toggleGameView();
    expect(subject.gameView).toBe(true);
    expect(scene.getTransformNodeByName("editorMapPreview")!.isEnabled()).toBe(false);
    expect(setSpawnMarkersForced).toHaveBeenLastCalledWith(false);
    expect((document.querySelector(".ed-ctx") as HTMLElement).style.display).toBe("none");

    subject.toggleGameView();
    expect(scene.getTransformNodeByName("editorMapPreview")!.isEnabled()).toBe(true);
    expect(setSpawnMarkersForced).toHaveBeenLastCalledWith(true);
    expect((document.querySelector(".ed-ctx") as HTMLElement).style.display).not.toBe("none");
  });

  it("keeps the selection and context panel alive across a commit", () => {
    const subject = driver(editor);
    subject.armed = { kind: "asteroid", id: "asteroid.rock" }; subject.place(new Vector3(3, 0, 5)); subject.armed = null;
    const mesh = scene.getMeshByName("editor.asteroid.0")!;
    subject.select("asteroid", 0, mesh);
    mesh.position.set(6, 0, 5);
    subject.commitTransform();
    // The rebuild replace() triggers must re-attach the handles + panel.
    expect((document.querySelector(".ed-ctx") as HTMLElement).style.display).not.toBe("none");
    expect(configs.get<ArenaConfig>("arena", arena.id)!.asteroidPlacements[0]!.position.x).toBe(6);
  });
});

/**
 * The DRAWN star (`arena.render.star`, SceneBuilder.buildStar) is authored
 * through the same generated arena form as the rest of the map. Regression
 * cover for the reason it was unreachable: its `dir` is a `z.tuple`, which the
 * generator rendered as untyped text rows until `tupleField` existed.
 */
describe("MapEditor arena render.star coverage", () => {
  let engine: NullEngine; let scene: Scene; let configs: ConfigService; let editor: MapEditor;
  let rebuildArena: ReturnType<typeof vi.fn>;
  const starArena = {
    ...arena,
    id: "arena.star-test",
    render: { ...arena.render, star: { dir: [0, 0, 1] as [number, number, number], apparentSize: 0.5, core: "#fff4d2", shell: "#ff8a1e", corona: "#ff9433", speed: 1 } },
  } satisfies ArenaConfig;

  beforeEach(() => {
    engine = new NullEngine(); scene = new Scene(engine); configs = new ConfigService(() => Promise.resolve(null), new EventBus<ConfigEvents>());
    rebuildArena = vi.fn();
    for (const config of [notification, asteroid, prop, terrainProp, starArena]) expect(configs.replace(config).ok).toBe(true);
    editor = new MapEditor({ scene, configService: configs, bus: new EventBus(), pauseSim() {}, resumeSim() {}, rebuildArena, setGameVisible() {}, setArenaVisible() {}, setSpawnMarkersForced() {}, setPropPickingForced() {}, suspendCameraGestures() {}, launchPlaytest: vi.fn() }, vi.fn());
  });
  afterEach(() => { editor.dispose(); scene.dispose(); engine.dispose(); document.body.replaceChildren(); });

  it("surfaces every drawn-star knob, with the direction as three number boxes", () => {
    const field = (name: string): HTMLInputElement | null => editor.element.querySelector<HTMLInputElement>(`[name="render.star.${name}"]`);

    for (const slot of ["dir.0", "dir.1", "dir.2"]) {
      expect(field(slot)?.type).toBe("number");
    }
    expect(field("apparentSize")?.type).toBe("number");
    // Hex colours come out as swatch + hex box, so the swatch carries the name.
    for (const colour of ["core", "shell", "corona"]) expect(field(colour)?.type).toBe("color");
    expect(field("speed")?.type).toBe("number");
  });

  it("live-rebuilds the arena when a star knob is committed", () => {
    rebuildArena.mockClear();
    const size = editor.element.querySelector<HTMLInputElement>('[name="render.star.apparentSize"]')!;
    size.value = "0.9";
    size.dispatchEvent(new Event("change"));

    expect(configs.get<ArenaConfig>("arena", starArena.id)!.render!.star!.apparentSize).toBe(0.9);
    // SceneBuilder only redraws the billboard on a rebuild, so a knob that does
    // not trigger one would look inert to the designer turning it.
    expect(rebuildArena).toHaveBeenCalledWith(starArena.id);
  });

  it("keeps the unit-vector refinement reachable: an off-unit direction reports on the tuple", () => {
    const report = vi.fn();
    const problems: string[] = [];
    report.mockImplementation((m: string | null) => { if (m) problems.push(m); });
    const solo = new MapEditor({ scene, configService: configs, bus: new EventBus(), pauseSim() {}, resumeSim() {}, rebuildArena() {}, setGameVisible() {}, setArenaVisible() {}, setSpawnMarkersForced() {}, setPropPickingForced() {}, suspendCameraGestures() {}, launchPlaytest: vi.fn() }, report);
    const z = solo.element.querySelector<HTMLInputElement>('[name="render.star.dir.2"]')!;
    z.value = "4";
    z.dispatchEvent(new Event("change"));

    expect(problems.join(" ")).toContain("unit vector");
    solo.dispose();
  });
});
