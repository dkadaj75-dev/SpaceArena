import { Mesh, type AbstractMesh, type InstancedMesh } from "@babylonjs/core";

/** Force a one-off preview/local instance to render its authored base master. */
export function pinInstanceLod0(instance: InstancedMesh): void {
  instance.getLOD = () => instance.sourceMesh;
}

/** Remove inherited LOD selection from a cloned preview hierarchy only. */
export function pinCloneHierarchyLod0(root: AbstractMesh): void {
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    if (!(mesh instanceof Mesh)) continue;
    for (const level of mesh.getLODLevels()) mesh.removeLODLevel(level.mesh);
  }
}
