import { Ray, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";

/**
 * Where a shot that missed everything the SIM tracks actually touched the
 * world (owner request 2026-08-14: "impacts on geometry, not just ships").
 *
 * The sim only knows ships, asteroids and the authored prop colliders; the
 * arena's regolith floor is a client-side mesh it has never heard of, and no
 * `projectileImpact` event exists at all. So the view answers the question the
 * way it answers the missile-detonation question — from what it can see:
 * it casts the shot's own travel line against the ARENA GEOMETRY MESHES and
 * takes the first crossing.
 *
 * The exclusion that matters is structural rather than a special case: the
 * candidate set is exactly the regolith floor and the authored props. The
 * arena BOUNDARY (`boundsShell` / `boundsBoxWall*` / `boundsRectSeg`), the
 * skybox, the starfield and the editor's invisible pick plane are simply not in
 * it, so ordnance expiring against the play-area limit can never draw anything
 * — there is nothing there for it to hit.
 */

/**
 * Name {@link import("../../core/SceneBuilder.js").SceneBuilder} gives the
 * arena's regolith floor disc (`createTerrainDisc`). Matched by name because
 * the floor is a procedural mesh with no content id behind it; props are
 * matched by the `editorKind` metadata SceneBuilder stamps on every one of
 * their meshes.
 */
export const TERRAIN_MESH_NAME = "terrainGround";

/** Solid, shootable arena scenery — the ground and anything authored as a prop. */
export function isImpactGeometry(mesh: Pick<AbstractMesh, "name"> & { metadata?: unknown }): boolean {
  const metadata = mesh.metadata as { editorKind?: unknown } | null | undefined;
  if (metadata?.editorKind === "prop") return true;
  return mesh.name === TERRAIN_MESH_NAME;
}

/**
 * Casts short rays against that geometry, under a hard per-frame budget.
 *
 * Ray/triangle work is not free — the regolith disc alone is some 9,000
 * triangles, and the NEAREST crossing is wanted rather than the first one
 * Babylon stumbles over (a spark on the far face of a boulder is a spark the
 * player never sees), so the whole triangle list is walked. On a mobile target
 * that buys a hard ration: at most {@link maxPerFrame} casts per rendered
 * frame, on top of the caller's own distance gate. Exhausting the ration costs
 * a spark, never a frame.
 */
export class GeometryProbe {
  private readonly ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), 1);
  private readonly point = new Vector3();
  private budget: number;
  /** Cached floor mesh; re-looked-up whenever the arena rebuilt and disposed it. */
  private terrain: AbstractMesh | null = null;
  /** Scene mesh count behind a KNOWN-EMPTY floor lookup — see `terrainMesh`. */
  private terrainScanCount = -1;
  private readonly predicate = (mesh: AbstractMesh): boolean => {
    if (!mesh.isEnabled() || !mesh.isVisible || !isImpactGeometry(mesh)) return false;
    // Arena scenery that the engine has not drawn yet still carries an identity
    // world matrix, and a probe on the first frame after a rebuild would then
    // find the floor at the origin. Forcing costs nothing on the frozen statics
    // SceneBuilder produces (a frozen matrix returns immediately) and only ever
    // runs for the handful of meshes that got this far.
    mesh.computeWorldMatrix(true);
    return true;
  };

  constructor(
    private readonly scene: Scene,
    private readonly maxPerFrame = 2,
  ) {
    this.budget = maxPerFrame;
  }

  /** Refill the per-frame ration. Called once per rendered frame. */
  beginFrame(): void {
    this.budget = this.maxPerFrame;
  }

  /** Casts left this frame — diagnostics and tests. */
  get remainingBudget(): number {
    return this.budget;
  }

  /**
   * World Y above which no ray can possibly reach the floor, or `-Infinity`
   * when this arena has no floor mesh at all (every non-lunar bubble, and the
   * rift, whose ground is made of props the sim already collides with).
   *
   * This is the cheap gate that keeps the floor probe off the hot path: a shot
   * is only ever probed against the ground once it is below the terrain's own
   * ceiling, which is a single float comparison per shot per frame.
   */
  get groundCeilingY(): number {
    const terrain = this.terrainMesh();
    if (!terrain) return Number.NEGATIVE_INFINITY;
    terrain.computeWorldMatrix(true);
    return terrain.getBoundingInfo().boundingBox.maximumWorld.y;
  }

  /**
   * First point at which the segment from (`x`,`y`,`z`) along (`dx`,`dy`,`dz`)
   * crosses solid geometry, or null. The returned vector is REUSED — copy what
   * you need out of it before the next call.
   */
  probe(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    distance: number,
  ): Vector3 | null {
    if (this.budget <= 0 || !(distance > 0)) return null;
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-6)) return null;
    this.budget--;
    this.ray.origin.set(x, y, z);
    this.ray.direction.set(dx / length, dy / length, dz / length);
    this.ray.length = distance;
    // `fastCheck: false` — the nearest crossing, not the first triangle found.
    const pick = this.scene.pickWithRay(this.ray, this.predicate, false);
    if (!pick?.hit || !pick.pickedPoint) return null;
    // Babylon's picking is not obliged to respect `ray.length` on every path;
    // a hit past the segment we asked about is a miss as far as we care.
    if (pick.distance > distance) return null;
    this.point.copyFrom(pick.pickedPoint);
    return this.point;
  }

  private terrainMesh(): AbstractMesh | null {
    if (this.terrain && !this.terrain.isDisposed()) return this.terrain;
    // An arena rebuild disposes the old disc; look the new one up lazily rather
    // than making SceneBuilder tell us about a mesh it owns.
    this.terrain = this.scene.getMeshByName(TERRAIN_MESH_NAME);
    return this.terrain;
  }
}
