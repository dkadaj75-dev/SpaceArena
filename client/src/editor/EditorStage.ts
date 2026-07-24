import { Color3, HemisphericLight, MeshBuilder, TransformNode, Vector3, type GizmoManager, type LinesMesh, type Scene } from "@babylonjs/core";

/** Half-extent of the backdrop grid, in world units. */
const GRID_EXTENT = 20;
/** World units between grid lines. */
const GRID_STEP = 2;

/**
 * Neutral backdrop for editor tools that stage content without the arena.
 *
 * The arena's light rig is parented to `arenaRoot`, so hiding the arena for a
 * clean stage also kills every light and leaves staged ships pitch black. This
 * supplies its own hemispheric light plus a faint cyan ground grid for spatial
 * reference; the scene's dark clear colour is the background.
 */
export class EditorStage {
  private root: TransformNode | null = null;

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

    const light = new HemisphericLight("editorStageLight", new Vector3(0.3, 1, 0.2), this.scene);
    light.intensity = 0.8;
    light.diffuse = new Color3(0.95, 0.97, 1);
    light.groundColor = new Color3(0.18, 0.22, 0.3);
    light.parent = root;

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
    this.root?.dispose(false, true);
    this.root = null;
  }
}

/**
 * Makes a gizmo drag suspend the editor camera's own pointer gestures, so
 * dragging a transform handle moves only the attached mesh.
 *
 * `GizmoManager` builds its gizmos lazily, so this must run after the
 * position/rotation/scale gizmos have been enabled. Returns an unbind function.
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
