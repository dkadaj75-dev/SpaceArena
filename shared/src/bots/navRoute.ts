import type { ArenaConfig } from "../schemas/arena.js";
import type { Vec3 } from "../schemas/common.js";
import { dist3 } from "../sim/math.js";

type Point = Required<Vec3>;
type NavGraph = NonNullable<ArenaConfig["navGraph"]>;

/**
 * Deterministic, precomputed routing over an arena's small authored nav graph.
 * The graph is immutable for a match, so Floyd-Warshall pays its cost once and
 * every bot decision becomes a couple of nearest-node scans plus next-hop reads.
 */
export class NavRoute {
  private readonly nodes: Array<{ id: string; position: Point }>;
  private readonly next: Array<Array<number | null>>;

  constructor(graph: NavGraph | undefined) {
    this.nodes = [...(graph?.nodes ?? [])]
      .map((node) => ({ id: node.id, position: point(node.position) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.nodes.map((node, index) => [node.id, index]));
    const n = this.nodes.length;
    const distance = Array.from({ length: n }, () => Array<number>(n).fill(Infinity));
    this.next = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
    for (let i = 0; i < n; i++) {
      distance[i]![i] = 0;
      this.next[i]![i] = i;
    }
    for (const [fromId, toId] of graph?.links ?? []) {
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (from === undefined || to === undefined) continue;
      const weight = dist3(this.nodes[from]!.position, this.nodes[to]!.position);
      distance[from]![to] = Math.min(distance[from]![to]!, weight);
      distance[to]![from] = Math.min(distance[to]![from]!, weight);
      this.next[from]![to] = to;
      this.next[to]![from] = from;
    }
    // Node order is id order, so retaining the existing route on equal cost is
    // the stable id-based tie break required for deterministic replays.
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const through = distance[i]![k]! + distance[k]![j]!;
      if (through < distance[i]![j]!) {
        distance[i]![j] = through;
        this.next[i]![j] = this.next[i]![k] ?? null;
      }
    }
  }

  get isEmpty(): boolean {
    return this.nodes.length === 0;
  }

  /** Return the next visible aim point, or null when direct flight is clear. */
  route(fromValue: Vec3, goalValue: Vec3, canSee: (a: Point, b: Point) => boolean): Point | null {
    const from = point(fromValue);
    const goal = point(goalValue);
    if (canSee(from, goal)) return null;
    if (this.nodes.length === 0) return null;

    const visible = this.nearest(from, (node) => canSee(from, node.position));
    const start = visible ?? this.nearest(from);
    const finish = this.nearest(goal);
    if (start === null || finish === null) return null;

    const hop = this.next[start]![finish] ?? null;
    if (hop === null) return this.nodes[start]!.position;
    let aim = hop;
    const nextNext = this.next[hop]![finish] ?? null;
    if (nextNext !== null && nextNext !== aim && canSee(from, this.nodes[nextNext]!.position)) aim = nextNext;
    return this.nodes[aim]!.position;
  }

  private nearest(value: Point, accept: (node: { id: string; position: Point }) => boolean = () => true): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      if (!accept(node)) continue;
      const distance = dist3(value, node.position);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }
}

function point(value: Vec3): Point {
  return { x: value.x, y: value.y ?? 0, z: value.z };
}
