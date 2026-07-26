/**
 * Seedable deterministic PRNG (mulberry32). The sim is otherwise fully
 * deterministic; any randomness (e.g. future spread/jitter) must come from here
 * so two hosts fed the same seed + orders stay in lockstep. Never Math.random.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to uint32 domain.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/**
 * A named child stream of a master seed — `deriveRng(matchSeed, botEntityId)`.
 *
 * Anything outside the sim proper that needs "random" behaviour (bot decision
 * jitter, orbit direction, boost rolls) must still replay identically for a
 * given match, but must NOT share `World.rng`: consuming from the world stream
 * from a caller that only exists on some hosts (a server bot driver, say) would
 * desync the sim itself. Hashing the two inputs into an independent
 * {@link Rng} gives every participant its own reproducible stream, decorrelated
 * from its neighbours' and from the world's.
 */
export function deriveRng(seed: number, salt = 0): () => number {
  let h = (seed >>> 0) ^ Math.imul((salt >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  const rng = new Rng((h ^ (h >>> 16)) >>> 0);
  return () => rng.next();
}
