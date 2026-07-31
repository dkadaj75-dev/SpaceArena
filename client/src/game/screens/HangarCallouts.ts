import { Matrix, Vector3, Viewport, type Scene, type TransformNode } from "@babylonjs/core";
import type { HangarSlot } from "../hangarFitting.js";

/** Where a callout wants to sit, in CSS px inside the stage pane. */
export interface CalloutPoint {
  x: number;
  y: number;
  /** True when the socket is behind the camera — the marker hides. */
  behind: boolean;
}

/** Scratch objects: the projection runs once per socket per frame. */
const viewScratch = new Vector3();
const identity = Matrix.Identity();
const viewport = new Viewport(0, 0, 1, 1);

/**
 * Project a world point into CSS px within a `width` × `height` box, or return
 * `false` for the degenerate band at the camera plane where the perspective
 * divide blows up. Mirrors `main.ts`'s HUD projection so the Hangar and the
 * match agree about where a world point lands on screen.
 */
export function projectToPane(
  scene: Scene,
  world: Vector3,
  width: number,
  height: number,
  out: CalloutPoint,
): boolean {
  if (width <= 0 || height <= 0) return false;
  const viewMatrix = scene.getViewMatrix() as Matrix | undefined;
  if (!viewMatrix) return false;
  Vector3.TransformCoordinatesToRef(world, viewMatrix, viewScratch);
  if (Math.abs(viewScratch.z) <= 0.01) return false;
  out.behind = viewScratch.z < 0;
  Vector3.ProjectToRef(world, identity, scene.getTransformMatrix(), viewport, viewScratch);
  out.x = viewScratch.x * width;
  out.y = viewScratch.y * height;
  return true;
}

/** What the Hangar hands each callout: the slot plus its socket offset on the hull. */
export interface CalloutSpec {
  slot: HangarSlot;
  /** Socket position in HULL space, straight from the ship config. */
  offset: readonly [number, number, number];
}

export interface CalloutCallbacks {
  /** A marker was clicked (or a module was dropped on it). */
  onSelect(hardpointIndex: number): void;
  /** A module id was dropped onto this slot. */
  onDrop(hardpointIndex: number, moduleId: string): void;
}

/**
 * Callout markers pinned to the ship in the Hangar's 3D pane (owner
 * 2026-07-31). One per fitted slot, drawn as a labelled tag over the hull:
 *
 *  - it names what is in the slot, so the model reads as a legend of the fit;
 *  - clicking it opens that slot's contextual module list; and
 *  - it is a DROP TARGET — dragging a module from the list onto the ship is the
 *    primary way to fit one.
 *
 * The markers are DOM, not 3D: they stay crisp, they take pointer events
 * without a mesh picker, and they can use the same styling as the panel. Their
 * screen positions are re-projected every rendered frame, so they track orbit
 * and zoom exactly.
 */
export class HangarCallouts {
  private readonly root: HTMLDivElement;
  private markers = new Map<number, HTMLButtonElement>();
  private readonly point: CalloutPoint = { x: 0, y: 0, behind: false };
  private readonly world = new Vector3();
  private specs: CalloutSpec[] = [];

  constructor(
    parent: HTMLElement,
    private readonly scene: Scene,
    private readonly stageRoot: TransformNode,
    private readonly callbacks: CalloutCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "hangar-callouts";
    parent.appendChild(this.root);
  }

  /** Rebuild the marker set for a fitting. Cheap enough to call on every edit. */
  rebuild(specs: readonly CalloutSpec[], labelFor: (slot: HangarSlot) => string): void {
    this.root.innerHTML = "";
    this.markers = new Map();
    this.specs = [...specs];
    for (const spec of this.specs) {
      const marker = document.createElement("button");
      marker.className = `hangar-callout kind-${spec.slot.kind}${spec.slot.moduleId ? "" : " empty"}`;
      marker.dataset["slot"] = String(spec.slot.hardpointIndex);
      marker.type = "button";
      marker.append(
        elSpan("dot", ""),
        elSpan("tag", labelFor(spec.slot)),
      );
      marker.addEventListener("click", () => this.callbacks.onSelect(spec.slot.hardpointIndex));

      // Drop target. `dragover` must preventDefault or the browser refuses the
      // drop outright — that is the whole handshake.
      marker.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        marker.classList.add("drop-hover");
      });
      marker.addEventListener("dragleave", () => marker.classList.remove("drop-hover"));
      marker.addEventListener("drop", (ev) => {
        ev.preventDefault();
        marker.classList.remove("drop-hover");
        const moduleId = ev.dataTransfer?.getData("text/plain");
        if (moduleId) this.callbacks.onDrop(spec.slot.hardpointIndex, moduleId);
      });

      this.root.appendChild(marker);
      this.markers.set(spec.slot.hardpointIndex, marker);
    }
  }

  /** Mark which slot's contextual menu is open. */
  setSelected(hardpointIndex: number | null): void {
    for (const [index, marker] of this.markers) {
      marker.classList.toggle("selected", index === hardpointIndex);
    }
  }

  /**
   * Highlight the slots a dragged module could legally go into, so the player
   * can see where to drop before letting go.
   */
  setDropCandidates(indices: ReadonlySet<number> | null): void {
    for (const [index, marker] of this.markers) {
      marker.classList.toggle("droppable", indices !== null && indices.has(index));
      marker.classList.toggle("dimmed", indices !== null && !indices.has(index));
    }
  }

  /** Re-project every marker. Called once per rendered frame. */
  update(): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width <= 0 || height <= 0) return;
    const origin = this.stageRoot.position;
    for (const spec of this.specs) {
      const marker = this.markers.get(spec.slot.hardpointIndex);
      if (!marker) continue;
      // Hull space → world. The staged ship sits unrotated at the stage root,
      // so the socket offset is a straight translation; the CAMERA orbits, not
      // the ship, which is what keeps this a two-line transform.
      this.world.set(origin.x + spec.offset[0], origin.y + spec.offset[1], origin.z + spec.offset[2]);
      if (!projectToPane(this.scene, this.world, width, height, this.point) || this.point.behind) {
        marker.style.visibility = "hidden";
        continue;
      }
      marker.style.visibility = "visible";
      marker.style.left = `${this.point.x}px`;
      marker.style.top = `${this.point.y}px`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function elSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
