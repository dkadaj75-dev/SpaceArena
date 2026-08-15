import { MeshBuilder, NullEngine, Scene, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { GeometryProbe, TERRAIN_MESH_NAME, isImpactGeometry } from "./geometryImpact.js";

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function makeScene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

/** A stand-in for SceneBuilder's regolith disc: a wide slab at the given height. */
function terrain(scene: Scene, y: number): Mesh {
  const mesh = MeshBuilder.CreateBox(TERRAIN_MESH_NAME, { width: 200, height: 1, depth: 200 }, scene);
  mesh.position.y = y;
  // SceneBuilder leaves the floor unpickable; the probe must not care.
  mesh.isPickable = false;
  return mesh;
}

/** A stand-in for an authored prop instance: SceneBuilder stamps this metadata. */
function prop(scene: Scene, x: number): Mesh {
  const mesh = MeshBuilder.CreateBox("lunar-rift-boulder", { size: 4 }, scene);
  mesh.position.x = x;
  mesh.isPickable = false;
  mesh.metadata = { editorKind: "prop", editorIndex: 3 };
  return mesh;
}

describe("isImpactGeometry", () => {
  it("accepts the arena floor and authored props", () => {
    expect(isImpactGeometry({ name: TERRAIN_MESH_NAME })).toBe(true);
    expect(isImpactGeometry({ name: "anything", metadata: { editorKind: "prop" } })).toBe(true);
  });

  it("rejects the arena boundary, the sky and everything the view itself draws", () => {
    for (const name of [
      "boundsShell",
      "boundsRectSeg",
      "boundsBoxCeiling",
      "boundsBoxWallNorth",
      "skyBox",
      "stars",
      "groundPlane",
      "ship.4",
      "proj.kinetic.2",
      "asteroid.7",
      "beam.1",
    ]) {
      expect(isImpactGeometry({ name })).toBe(false);
    }
    expect(isImpactGeometry({ name: "x", metadata: { editorKind: "asteroid" } })).toBe(false);
  });
});

describe("GeometryProbe", () => {
  it("finds the first crossing of the floor along a shot's travel", () => {
    const scene = makeScene();
    terrain(scene, 0);
    const probe = new GeometryProbe(scene);
    probe.beginFrame();

    const point = probe.probe(10, 12, -4, 0, -1, 0, 40);
    expect(point).not.toBeNull();
    expect(point!.x).toBeCloseTo(10, 4);
    expect(point!.z).toBeCloseTo(-4, 4);
    expect(point!.y).toBeCloseTo(0.5, 4); // the slab's top face
  });

  it("finds an authored prop the shot flew into", () => {
    const scene = makeScene();
    prop(scene, 20);
    const probe = new GeometryProbe(scene);
    probe.beginFrame();

    const point = probe.probe(10, 0, 0, 1, 0, 0, 40);
    expect(point!.x).toBeCloseTo(18, 4); // the near face of a 4-unit box at x=20
  });

  it("draws a blank on the arena boundary — a shot expiring at the limit hits nothing", () => {
    const scene = makeScene();
    // The bounds shell IS geometry to Babylon; it is simply never a candidate.
    const shell = MeshBuilder.CreateSphere("boundsShell", { diameter: 60 }, scene);
    shell.isPickable = false;
    const probe = new GeometryProbe(scene);
    probe.beginFrame();

    expect(probe.probe(0, 0, 0, 1, 0, 0, 200)).toBeNull();
  });

  it("ignores geometry beyond the segment it was asked about", () => {
    const scene = makeScene();
    prop(scene, 60);
    const probe = new GeometryProbe(scene);
    probe.beginFrame();

    expect(probe.probe(0, 0, 0, 1, 0, 0, 5)).toBeNull();
    probe.beginFrame();
    expect(probe.probe(0, 0, 0, 1, 0, 0, 100)).not.toBeNull();
  });

  it("skips a disabled arena — a hidden scene is not a wall", () => {
    const scene = makeScene();
    terrain(scene, 0).setEnabled(false);
    const probe = new GeometryProbe(scene);
    probe.beginFrame();

    expect(probe.probe(0, 12, 0, 0, -1, 0, 40)).toBeNull();
  });

  it("spends a hard ration of casts per frame", () => {
    const scene = makeScene();
    terrain(scene, 0);
    const probe = new GeometryProbe(scene, 2);
    probe.beginFrame();

    expect(probe.probe(0, 12, 0, 0, -1, 0, 40)).not.toBeNull();
    expect(probe.probe(1, 12, 0, 0, -1, 0, 40)).not.toBeNull();
    expect(probe.remainingBudget).toBe(0);
    expect(probe.probe(2, 12, 0, 0, -1, 0, 40)).toBeNull(); // budget spent, not a miss
    probe.beginFrame();
    expect(probe.probe(2, 12, 0, 0, -1, 0, 40)).not.toBeNull();
  });

  it("reports the floor's ceiling, and negative infinity where there is no floor", () => {
    const scene = makeScene();
    const probe = new GeometryProbe(scene);
    expect(probe.groundCeilingY).toBe(Number.NEGATIVE_INFINITY);

    const floor = terrain(scene, -20);
    expect(probe.groundCeilingY).toBeCloseTo(-19.5, 4);

    // An arena rebuild disposes the disc; the probe must not hold the corpse.
    floor.dispose();
    expect(probe.groundCeilingY).toBe(Number.NEGATIVE_INFINITY);
  });
});
