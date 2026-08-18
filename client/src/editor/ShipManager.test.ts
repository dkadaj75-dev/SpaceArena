import { Observable, type GizmoManager } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { bindGizmoSocketCommit, roundMarkerValue } from "./ShipManager.js";

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
