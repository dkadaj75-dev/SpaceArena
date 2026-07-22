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
