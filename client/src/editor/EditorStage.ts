import {
  BaseTexture, Color3, Constants, DirectionalLight, GizmoManager, HemisphericLight, MeshBuilder, RawCubeTexture,
  Texture, TransformNode, Vector3, type LinesMesh, type Scene,
} from "@babylonjs/core";

/** Half-extent of the backdrop grid, in world units. */
const GRID_EXTENT = 20;
/** World units between grid lines. */
const GRID_STEP = 2;

/**
 * Neutral backdrop for editor tools that stage content without the arena.
 *
 * The arena's light rig is parented to `arenaRoot`, so hiding the arena for a
 * clean stage also kills every light and leaves staged ships pitch black. This
 * supplies its own rig — a hemispheric fill, a directional key, and a tiny IBL
 * cube (GLB hulls are PBR: without an environment texture their metallic
 * surfaces render black no matter how many analytic lights shine on them; same
 * trick as HangarBay's RawCubeTexture) — plus a faint cyan ground grid for
 * spatial reference; the scene's dark clear colour is the background.
 */
export class EditorStage {
  private root: TransformNode | null = null;
  private environment: RawCubeTexture | null = null;
  private previousEnvironment: BaseTexture | null = null;

  constructor(private readonly scene: Scene) {}

  /** Builds the stage on first enable and tears it down when disabled. */
  setEnabled(enabled: boolean): void {
    if (enabled === (this.root !== null)) return;
    if (!enabled) {
      this.dispose();
      return;
    }
    const root = new TransformNode("editorStageRoot", this.scene);
    this.root = root;

    // Kept close to HangarBay's exposure (key 0.7): fill+key+IBL stack, and the
    // first cut (0.65 + 1.4) blew textured hulls out to white.
    const fill = new HemisphericLight("editorStageLight", new Vector3(0.3, 1, 0.2), this.scene);
    fill.intensity = 0.4;
    fill.diffuse = new Color3(0.95, 0.97, 1);
    fill.groundColor = new Color3(0.18, 0.22, 0.3);
    fill.parent = root;

    const key = new DirectionalLight("editorStageKey", new Vector3(-0.45, -0.8, -0.4), this.scene);
    key.intensity = 0.75;
    key.diffuse = new Color3(1, 0.96, 0.9);
    key.specular = new Color3(1, 0.98, 0.95);
    key.parent = root;

    this.previousEnvironment = this.scene.environmentTexture;
    this.environment = createStageEnvironment(this.scene);
    if (this.environment) this.scene.environmentTexture = this.environment;

    const grid = this.buildGrid();
    grid.parent = root;
  }

  /** One LinesMesh holding the whole grid — cheap, and disposed in one call. */
  private buildGrid(): LinesMesh {
    const lines: Vector3[][] = [];
    for (let v = -GRID_EXTENT; v <= GRID_EXTENT; v += GRID_STEP) {
      lines.push([new Vector3(-GRID_EXTENT, 0, v), new Vector3(GRID_EXTENT, 0, v)]);
      lines.push([new Vector3(v, 0, -GRID_EXTENT), new Vector3(v, 0, GRID_EXTENT)]);
    }
    const grid = MeshBuilder.CreateLineSystem("editorStageGrid", { lines }, this.scene);
    grid.color = new Color3(0.34, 0.85, 1);
    grid.alpha = 0.16;
    grid.isPickable = false;
    return grid;
  }

  dispose(): void {
    if (this.environment) {
      if (this.scene.environmentTexture === this.environment) this.scene.environmentTexture = this.previousEnvironment;
      this.environment.dispose();
      this.environment = null;
      this.previousEnvironment = null;
    }
    this.root?.dispose(false, true);
    this.root = null;
  }
}

/**
 * Freeze the editor camera's pointer gestures for the duration of a gizmo drag.
 *
 * The tactical camera and the gizmo both read the same pointer stream, so
 * without this a drag on a translate handle also orbits the scene and the
 * marker appears to fly away from the cursor. Bound once per GizmoManager and
 * released on teardown — the returned unbind always clears the suspension, so a
 * panel disposed mid-drag cannot strand the camera frozen.
 */
export function bindGizmoCameraSuspend(gizmos: GizmoManager, suspend: (on: boolean) => void): () => void {
  const unbind: Array<() => void> = [];
  for (const gizmo of [gizmos.gizmos.positionGizmo, gizmos.gizmos.rotationGizmo, gizmos.gizmos.scaleGizmo]) {
    if (!gizmo) continue;
    const start = gizmo.onDragStartObservable.add(() => suspend(true));
    const end = gizmo.onDragEndObservable.add(() => suspend(false));
    unbind.push(() => {
      gizmo.onDragStartObservable.remove(start);
      gizmo.onDragEndObservable.remove(end);
    });
  }
  return () => {
    for (const off of unbind) off();
    // Never leave the camera stuck in the suspended state.
    suspend(false);
  };
}

/**
 * Keep transform commits wired across marker rebuilds. Every committed edit
 * replaces the markers, but the GizmoManager (and its observables) live for the
 * whole editing session — so the commit hook is bound to the MANAGER once, not
 * re-armed per selection with `addOnce`.
 */
export function bindGizmoDragCommit(gizmos: GizmoManager, commit: () => void): () => void {
  const observables = [
    gizmos.gizmos.positionGizmo?.onDragEndObservable,
    gizmos.gizmos.rotationGizmo?.onDragEndObservable,
    gizmos.gizmos.scaleGizmo?.onDragEndObservable,
  ].filter((observable) => observable !== undefined);
  const observers = observables.map((observable) => ({ observable, observer: observable.add(commit) }));
  return () => {
    for (const { observable, observer } of observers) observable.remove(observer);
  };
}

/**
 * Tiny synthetic IBL cube: cool sky above, warm horizon, dark floor. NullEngine
 * has no texture backend, so tests (no rendering canvas) skip it — the same
 * guard HangarBay uses.
 */
function createStageEnvironment(scene: Scene): RawCubeTexture | null {
  if (!scene.getEngine().getRenderingCanvas()) return null;
  const size = 8;
  const faceColours: readonly [number, number, number][] = [
    [52, 72, 100], [52, 72, 100], [148, 168, 196], [14, 20, 32], [40, 56, 80], [40, 56, 80],
  ];
  const faces = faceColours.map(([r, g, b]) => {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
    return data;
  });
  try {
    const environment = new RawCubeTexture(scene, faces, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, true);
    environment.coordinatesMode = Texture.CUBIC_MODE;
    environment.gammaSpace = false;
    environment.level = 0.7;
    return environment;
  } catch {
    // A NullEngine given a mock canvas (headless tests) has no texture
    // backend; the analytic lights still cover the staging.
    return null;
  }
}
