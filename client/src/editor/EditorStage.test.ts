import { describe, expect, it } from "vitest";
import { Observable, type GizmoManager } from "@babylonjs/core";
import { bindGizmoCameraSuspend } from "./EditorStage.js";

/** Minimal stand-in for the three gizmos a GizmoManager exposes. */
function fakeGizmo(): { onDragStartObservable: Observable<unknown>; onDragEndObservable: Observable<unknown> } {
  return { onDragStartObservable: new Observable(), onDragEndObservable: new Observable() };
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

describe("bindGizmoCameraSuspend", () => {
  it("suspends the camera for the duration of a drag on every gizmo", () => {
    const { manager, gizmos } = fakeManager();
    const calls: boolean[] = [];
    bindGizmoCameraSuspend(manager, (on) => calls.push(on));

    for (const gizmo of gizmos) {
      gizmo.onDragStartObservable.notifyObservers(null);
      gizmo.onDragEndObservable.notifyObservers(null);
    }

    // One suspend/resume pair per gizmo — position, rotation and scale.
    expect(calls).toEqual([true, false, true, false, true, false]);
  });

  it("unbinding detaches the observers and always releases the camera", () => {
    const { manager, gizmos } = fakeManager();
    const calls: boolean[] = [];
    const unbind = bindGizmoCameraSuspend(manager, (on) => calls.push(on));

    // Leave the camera suspended mid-drag, then tear down (panel disposed).
    gizmos[0]!.onDragStartObservable.notifyObservers(null);
    expect(calls).toEqual([true]);

    unbind();
    // Teardown must never strand the camera in the suspended state.
    expect(calls).toEqual([true, false]);

    // Further gizmo activity is ignored once unbound.
    for (const gizmo of gizmos) {
      gizmo.onDragStartObservable.notifyObservers(null);
      gizmo.onDragEndObservable.notifyObservers(null);
      expect(gizmo.onDragStartObservable.hasObservers()).toBe(false);
      expect(gizmo.onDragEndObservable.hasObservers()).toBe(false);
    }
    expect(calls).toEqual([true, false]);
  });

  it("tolerates a manager whose gizmos are not all enabled", () => {
    const position = fakeGizmo();
    const manager = {
      gizmos: { positionGizmo: position, rotationGizmo: null, scaleGizmo: null },
    } as unknown as GizmoManager;
    const calls: boolean[] = [];
    const unbind = bindGizmoCameraSuspend(manager, (on) => calls.push(on));

    position.onDragStartObservable.notifyObservers(null);
    position.onDragEndObservable.notifyObservers(null);
    unbind();

    expect(calls).toEqual([true, false, false]);
  });
});
