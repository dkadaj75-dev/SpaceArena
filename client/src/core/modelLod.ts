import { Mesh, type AbstractMesh, type InstancedMesh } from "@babylonjs/core";

/** Force a one-off preview/local instance to render its authored base master. */
export function pinInstanceLod0(instance: InstancedMesh): void {
  instance.getLOD = () => {
    // Babylon's stock getLOD assigns _currentLOD as a side effect, and
    // InstancedMesh._activate only registers an instance for drawing when
    // _currentLOD is set — an override that skips the assignment draws nothing.
    (instance as unknown as { _currentLOD: Mesh })._currentLOD = instance.sourceMesh;
    return instance.sourceMesh;
  };
}

/** Remove inherited LOD selection from a cloned preview hierarchy only. */
export function pinCloneHierarchyLod0(root: AbstractMesh): void {
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    if (!(mesh instanceof Mesh)) continue;
    for (const level of mesh.getLODLevels()) mesh.removeLODLevel(level.mesh);
  }
}
