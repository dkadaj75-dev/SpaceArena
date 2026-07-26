import type { EntityId } from "./components.js";

/**
 * Uniform grid spatial hash for planar broadphase (collision candidate pairs +
 * LoS/segment AABB queries). Rebuilt per tick from entity positions+radii.
 * Deterministic: cells and returned ids are iterated in insertion/id order.
 */
export class SpatialHash {
  private readonly cells = new Map<number, EntityId[]>();

  constructor(private cellSize: number) {}

  /** Swap the grid resolution before a rebuild (used by offline tuning hot-reload). */
  setCellSize(cellSize: number): void {
    if (Number.isFinite(cellSize) && cellSize > 0) this.cellSize = cellSize;
  }

  clear(): void {
    this.cells.clear();
  }

  private key(cx: number, cz: number): number {
    // Pack two signed cell coords into one number (offset to keep non-negative).
    return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  }

  private cellCoord(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  /** Insert an entity whose spherical collider projects over [x±r, z±r]. */
  insert(id: EntityId, x: number, z: number, r: number): void {
    const minX = this.cellCoord(x - r);
    const maxX = this.cellCoord(x + r);
    const minZ = this.cellCoord(z - r);
    const maxZ = this.cellCoord(z + r);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const k = this.key(cx, cz);
        let bucket = this.cells.get(k);
        if (!bucket) {
          bucket = [];
          this.cells.set(k, bucket);
        }
        bucket.push(id);
      }
    }
  }

  /** Unique candidate ids overlapping the AABB [minX,maxX]×[minZ,maxZ]. */
  queryAABB(minX: number, minZ: number, maxX: number, maxZ: number): EntityId[] {
    const out: EntityId[] = [];
    const seen = new Set<EntityId>();
    const c0 = this.cellCoord(minX);
    const c1 = this.cellCoord(maxX);
    const z0 = this.cellCoord(minZ);
    const z1 = this.cellCoord(maxZ);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells.get(this.key(cx, cz));
        if (!bucket) continue;
        for (const id of bucket) {
          if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        }
      }
    }
    return out;
  }

  /** Candidates near a point within radius `r`. */
  queryCircle(x: number, z: number, r: number): EntityId[] {
    return this.queryAABB(x - r, z - r, x + r, z + r);
  }
}
