import type { EntityId } from "./components.js";

/**
 * Uniform grid spatial hash for planar broadphase (collision candidate pairs +
 * LoS/segment AABB queries). Rebuilt per tick from entity positions+radii.
 *
 * Deterministic, and `spatialHash.test.ts` pins exactly how. The order is worth
 * stating precisely, because the obvious summary ("insertion order") is only
 * half right and a rewrite that believes it will change sim results:
 *
 *   1. WITHIN a cell, ids come back in insertion order ({@link insert} pushes).
 *   2. ACROSS cells, order is GRID-COORDINATE SCAN order — cx ascending, then cz
 *      ascending — not `cells` Map order. {@link queryAABB} never iterates the
 *      Map; it computes keys and looks them up, so insertion order of the cells
 *      themselves is invisible to every query.
 *   3. An entity covering several cells is emitted ONCE, at the FIRST cell the
 *      scan reaches it in — first-seen-wins dedupe.
 *
 * Rule 3 is the load-bearing one: `CollisionSystem` mutates `st.pos` inside its
 * candidate loop, so overlapping rocks push apart in query order and float
 * addition is not commutative. `los.ts` is an any-hit boolean and
 * `ProjectileSystem`/`CombatSystem` take nearest on a strict `<`, so those three
 * only care about exact ties.
 */
export class SpatialHash {
  /**
   * Two layers, queried as one.
   *
   * Asteroid transforms are immutable — nothing in `shared/src/sim` writes an
   * asteroid position, and rocks tumble through a closed-form pose that a
   * bounding-sphere hash cannot see — so re-inserting all of them every tick was
   * rebuilding an identical structure. The static layer is rebuilt only when the
   * live rock set or the cell size actually changes.
   *
   * ORDER IS PRESERVED EXACTLY, and that is the whole risk of this split. Today
   * every bucket holds asteroids (ascending id) ahead of ships (ascending id),
   * because the rebuild inserted all rocks before all ships. {@link queryAABB}
   * therefore emits, PER CELL, the static bucket and then the dynamic one — a
   * layer-major walk would visit every static cell before any dynamic cell and
   * silently reorder collision resolution.
   */
  private readonly cells = new Map<number, EntityId[]>();
  private readonly staticCells = new Map<number, EntityId[]>();

  constructor(private cellSize: number) {}

  /**
   * Swap the grid resolution before a rebuild (used by offline tuning
   * hot-reload). Re-buckets nothing by itself: the caller must rebuild BOTH
   * layers, which is why the static layer's rebuild key includes the cell size.
   */
  setCellSize(cellSize: number): void {
    if (Number.isFinite(cellSize) && cellSize > 0) this.cellSize = cellSize;
  }

  /** Drop both layers. */
  clear(): void {
    this.cells.clear();
    this.staticCells.clear();
  }

  /** Drop only the per-tick layer, keeping the static rocks in place. */
  clearDynamic(): void {
    this.cells.clear();
  }

  /** Drop only the static layer, ahead of re-inserting it. */
  clearStatic(): void {
    this.staticCells.clear();
  }

  /** Insert into the rarely-rebuilt layer (asteroids). */
  insertStatic(id: EntityId, x: number, z: number, r: number): void {
    this.insertInto(this.staticCells, id, x, z, r);
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
    this.insertInto(this.cells, id, x, z, r);
  }

  private insertInto(cells: Map<number, EntityId[]>, id: EntityId, x: number, z: number, r: number): void {
    const minX = this.cellCoord(x - r);
    const maxX = this.cellCoord(x + r);
    const minZ = this.cellCoord(z - r);
    const maxZ = this.cellCoord(z + r);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const k = this.key(cx, cz);
        let bucket = cells.get(k);
        if (!bucket) {
          bucket = [];
          cells.set(k, bucket);
        }
        bucket.push(id);
      }
    }
  }

  /**
   * Generation-stamped "already emitted" marker, replacing a `Set` allocated per
   * query. Entity ids are small and dense (the sim's `nextId` grows well under
   * one per tick), so a flat Int32Array indexed by id is both smaller and faster
   * than hashing — and, critically, it preserves FIRST-SEEN-WINS dedupe exactly,
   * which is the ordering rule `spatialHash.test.ts` pins.
   */
  private visited = new Int32Array(256);
  private stamp = 0;

  private markVisited(id: EntityId): boolean {
    if (id >= this.visited.length) {
      const grown = new Int32Array(Math.max(id + 1, this.visited.length * 2));
      grown.set(this.visited);
      this.visited = grown;
    }
    if (this.visited[id] === this.stamp) return false;
    this.visited[id] = this.stamp;
    return true;
  }

  /** Unique candidate ids overlapping the AABB [minX,maxX]×[minZ,maxZ]. */
  queryAABB(minX: number, minZ: number, maxX: number, maxZ: number): EntityId[] {
    // A fresh stamp makes every previous mark stale in O(1). On wrap (~27 days
    // of continuous play at the shipped query rate) clear once and restart —
    // cheaper to handle than to reason about.
    if (++this.stamp === 0x7fffffff) {
      this.visited.fill(0);
      this.stamp = 1;
    }
    // The output array is deliberately NOT pooled. Every consumer today consumes
    // its result before the next query, so a shared buffer would work — but that
    // is an invariant no signature states and no test enforces, and the array is
    // the small half of the cost the `Set` used to dominate.
    const out: EntityId[] = [];
    const c0 = this.cellCoord(minX);
    const c1 = this.cellCoord(maxX);
    const z0 = this.cellCoord(minZ);
    const z1 = this.cellCoord(maxZ);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        // Static THEN dynamic, inside this cell, before moving to the next —
        // never all of one layer and then all of the other. See the class doc.
        const staticBucket = this.staticCells.get(k);
        if (staticBucket !== undefined) {
          for (const id of staticBucket) {
            if (this.markVisited(id)) out.push(id);
          }
        }
        const bucket = this.cells.get(k);
        if (bucket !== undefined) {
          for (const id of bucket) {
            if (this.markVisited(id)) out.push(id);
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
