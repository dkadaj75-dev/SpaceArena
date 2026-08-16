import { describe, expect, it } from "vitest";
import { SpatialHash } from "./spatialHash.js";

/**
 * Refactor plan §2b — the query-ORDER contract.
 *
 * `spatialHash.ts:6` documents that "cells and returned ids are iterated in
 * insertion/id order", and the four consumers all had suites while nothing
 * asserted the ordering itself. It is genuinely load-bearing in one place:
 * {@link import("./systems/CollisionSystem.js")} mutates `st.pos` *inside* the
 * candidate loop, so two overlapping rocks push apart in query order and float
 * addition is not commutative. `los.ts` is an any-hit boolean and
 * `ProjectileSystem`/`CombatSystem` select nearest with a strict `<`, so those
 * three are order-insensitive except on exact ties.
 *
 * These tests pin the three rules a rewrite has to preserve:
 *
 *   1. within one cell, ids come back in INSERTION order (not sorted);
 *   2. cells are visited cx-major, then cz, ascending;
 *   3. an id spanning several cells is emitted once, at its FIRST visited cell.
 *
 * Rule 3 with rule 2 is what makes the planned static/dynamic bucket split
 * survivable: the split must walk cell-by-cell emitting static-then-dynamic
 * within each cell, never layer-major. `separates layers within a cell` below is
 * the assertion that fails if someone walks layer-major.
 */
describe("SpatialHash query order", () => {
  const CELL = 16;

  it("returns ids from one cell in insertion order, not sorted order", () => {
    const hash = new SpatialHash(CELL);
    // One cell, deliberately descending ids: a sorted result would hide a
    // rewrite that collects into a Set or sorts on the way out.
    hash.insert(30, 1, 1, 0.5);
    hash.insert(10, 2, 2, 0.5);
    hash.insert(20, 3, 3, 0.5);
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([30, 10, 20]);
  });

  it("visits cells cx-major then cz, both ascending, regardless of insert order", () => {
    const hash = new SpatialHash(CELL);
    // Four cells: (0,0) (0,1) (1,0) (1,1). Inserted in an order that matches
    // none of the possible scan orders, so the assertion pins the scan itself.
    hash.insert(4, 24, 24, 0.5); // cell (1,1)
    hash.insert(1, 8, 8, 0.5); // cell (0,0)
    hash.insert(3, 24, 8, 0.5); // cell (1,0)
    hash.insert(2, 8, 24, 0.5); // cell (0,1)
    // cx-major: (0,0) (0,1) (1,0) (1,1) → 1, 2, 3, 4. A cz-major walk would
    // give 1, 3, 2, 4.
    expect(hash.queryAABB(0, 0, 31, 31)).toEqual([1, 2, 3, 4]);
  });

  it("emits a multi-cell id once, at the first cell that holds it", () => {
    const hash = new SpatialHash(CELL);
    // id 1 straddles the cx=0/cx=1 boundary, so it sits in two buckets; id 2 is
    // only in the second. Dedup must keep 1 at its FIRST cell, ahead of 2.
    hash.insert(1, 16, 8, 4);
    hash.insert(2, 24, 8, 0.5);
    const out = hash.queryAABB(0, 0, 31, 15);
    expect(out).toEqual([1, 2]);
    expect(out.filter((id) => id === 1)).toHaveLength(1);
  });

  it("separates layers within a cell — static inserted first stays first", () => {
    const hash = new SpatialHash(CELL);
    // The invariant ArenaSimulation establishes today by inserting every
    // asteroid before every ship. Two cells, each holding one of each: a
    // cell-major walk gives [100, 200, 101, 201]; a layer-major walk would give
    // [100, 101, 200, 201] and silently change collision resolution order.
    hash.insert(100, 8, 8, 0.5); // "asteroid", cell (0,0)
    hash.insert(101, 24, 8, 0.5); // "asteroid", cell (1,0)
    hash.insert(200, 9, 9, 0.5); // "ship", cell (0,0)
    hash.insert(201, 25, 9, 0.5); // "ship", cell (1,0)
    expect(hash.queryAABB(0, 0, 31, 15)).toEqual([100, 200, 101, 201]);
  });

  it("emits the static layer before the dynamic one WITHIN each cell", () => {
    const hash = new SpatialHash(CELL);
    // The real arrangement: rocks static, ships dynamic, two cells holding one
    // of each. Cell-major gives [100, 200, 101, 201] — identical to what a
    // single-layer hash produced when all rocks were inserted before all ships.
    // A layer-major walk would give [100, 101, 200, 201] and reorder collision
    // resolution, which is the entire risk of the static/dynamic split.
    hash.insertStatic(100, 8, 8, 0.5);
    hash.insertStatic(101, 24, 8, 0.5);
    hash.insert(200, 9, 9, 0.5);
    hash.insert(201, 25, 9, 0.5);
    expect(hash.queryAABB(0, 0, 31, 15)).toEqual([100, 200, 101, 201]);
  });

  it("keeps the static layer across a dynamic-only clear", () => {
    const hash = new SpatialHash(CELL);
    hash.insertStatic(100, 8, 8, 0.5);
    hash.insert(200, 9, 9, 0.5);
    hash.clearDynamic();
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([100]);
    hash.insert(201, 9, 9, 0.5);
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([100, 201]);
    hash.clearStatic();
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([201]);
  });

  it("dedupes across layers, keeping the first-seen occurrence", () => {
    const hash = new SpatialHash(CELL);
    // Same id in both layers is not a shipped arrangement, but the dedupe must
    // still be first-seen-wins rather than emitting it twice.
    hash.insertStatic(7, 8, 8, 0.5);
    hash.insert(7, 8, 8, 0.5);
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([7]);
  });

  it("keeps the same contract across the negative-coordinate key offset", () => {
    const hash = new SpatialHash(CELL);
    // key() packs cell coords with a +0x8000 offset; negatives are the case
    // that offset exists for, and Math.floor makes -1 a cell of its own.
    hash.insert(7, -24, -24, 0.5); // cell (-2,-2)
    hash.insert(8, -8, -8, 0.5); // cell (-1,-1)
    hash.insert(9, 8, 8, 0.5); // cell (0,0)
    expect(hash.queryAABB(-32, -32, 15, 15)).toEqual([7, 8, 9]);
  });

  it("gives queryCircle the same order as the AABB it delegates to", () => {
    const hash = new SpatialHash(CELL);
    hash.insert(5, 8, 8, 0.5);
    hash.insert(3, 24, 8, 0.5);
    hash.insert(4, 8, 24, 0.5);
    expect(hash.queryCircle(16, 16, 12)).toEqual(hash.queryAABB(4, 4, 28, 28));
    expect(hash.queryCircle(16, 16, 12)).toEqual([5, 4, 3]);
  });

  it("drops every bucket on clear, and re-inserts define a fresh order", () => {
    const hash = new SpatialHash(CELL);
    hash.insert(1, 8, 8, 0.5);
    hash.clear();
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([]);
    hash.insert(2, 8, 8, 0.5);
    hash.insert(1, 8, 8, 0.5);
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([2, 1]);
  });

  it("re-buckets against the new resolution after setCellSize", () => {
    const hash = new SpatialHash(CELL);
    hash.setCellSize(8);
    // At cellSize 8 these are cells (0,0) and (1,0); at 16 they would share one.
    hash.insert(1, 4, 4, 0.5);
    hash.insert(2, 12, 4, 0.5);
    expect(hash.queryAABB(0, 0, 7, 7)).toEqual([1]);
    expect(hash.queryAABB(0, 0, 15, 7)).toEqual([1, 2]);
  });

  it("ignores a non-finite or non-positive cell size rather than corrupting the grid", () => {
    const hash = new SpatialHash(CELL);
    hash.setCellSize(0);
    hash.setCellSize(-4);
    hash.setCellSize(Number.NaN);
    hash.insert(1, 8, 8, 0.5);
    expect(hash.queryAABB(0, 0, 15, 15)).toEqual([1]);
  });
});
