/**
 * Player-like display names for bots (owner 2026-07-31). A bot called "Rookie"
 * reads as furniture; a bot called "V0idRunner_88" reads as an opponent, which
 * is the whole point — practice should feel like a match.
 *
 * Deterministic: every name is drawn from a caller-supplied RNG, so a match
 * replayed on the same seed fields the same roster. Nothing here touches
 * `Math.random`.
 */

/** Handle stems — evocative but neutral, no real-player impersonation. */
const STEMS = [
  "Vector", "Nova", "Rift", "Quasar", "Talon", "Ember", "Vortex", "Cinder",
  "Halcyon", "Zenith", "Drift", "Pulsar", "Onyx", "Warden", "Specter", "Comet",
  "Ion", "Basilisk", "Lumen", "Ravager", "Solstice", "Kestrel", "Mirage", "Apex",
  "Havoc", "Corsair", "Tempest", "Wraith", "Nomad", "Cobalt", "Phantom", "Sable",
];

/** Optional prefix, the way handles actually look in a lobby. */
const PREFIXES = ["", "", "", "", "xX", "Dr", "Mr", "Lil", "Big", "Old", "Neo", "Cpt"];

/** Optional suffix. Empty entries are weighted so plain names stay common. */
const SUFFIXES = ["", "", "", "", "Xx", "_", "HD", "TV", "GG", "77", "99", "_x"];

/** Second word, sometimes joined to the stem. */
const TAILS = [
  "", "", "", "runner", "hunter", "storm", "blade", "wing", "shot", "fall",
  "burn", "hawk", "fox", "byte", "core",
];

/** Leetspeak substitutions, applied rarely so most names stay readable. */
const LEET: ReadonlyArray<readonly [string, string]> = [
  ["o", "0"],
  ["i", "1"],
  ["e", "3"],
  ["a", "4"],
  ["s", "5"],
];

/**
 * Server backfill asks for one name at a time, while local practice asks for a
 * roster. Remembering names per RNG stream gives both call sites the same
 * match-level uniqueness guarantee without putting room state in sim code.
 */
const namesByStream = new WeakMap<() => number, Set<string>>();

/** Pick one entry from `list` using `rng` (a 0..1 generator). */
function pick<T>(rng: () => number, list: readonly T[]): T {
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
  return list[index]!;
}

/**
 * One player-like handle. Shapes it can take, roughly in order of frequency:
 * `Vector`, `Novarunner`, `xXTalonXx`, `R1ftHunter_`, `Quasar_77`.
 */
function rawBotName(rng: () => number): string {
  const prefix = pick(rng, PREFIXES);
  let stem = pick(rng, STEMS);
  const tail = pick(rng, TAILS);
  const suffix = pick(rng, SUFFIXES);

  // Occasionally capitalise the tail so both "Novarunner" and "NovaRunner" occur.
  const joinedTail = tail === "" ? "" : rng() < 0.5 ? tail : tail.charAt(0).toUpperCase() + tail.slice(1);

  // ~1 in 6 gets a single leet substitution — enough for flavour, rare enough
  // that names stay legible.
  if (rng() < 0.17) {
    const [from, to] = pick(rng, LEET);
    const at = stem.toLowerCase().indexOf(from);
    if (at >= 0) stem = stem.slice(0, at) + to + stem.slice(at + 1);
  }

  // A bare number tail reads oddly glued to a word, so separate it.
  const numeric = /^\d/.test(suffix);
  const glue = numeric && prefix === "" ? "_" : "";
  let name = `${prefix}${stem}${joinedTail}${glue}${suffix}`;
  // A few lowercase tags keep the roster from following one casing template.
  if (rng() < 0.16) name = name.toLowerCase();
  return name.slice(0, 16);
}

/** One player-like, unique-within-stream handle. */
export function generateBotName(rng: () => number): string {
  let seen = namesByStream.get(rng);
  if (!seen) {
    seen = new Set();
    namesByStream.set(rng, seen);
  }

  let name = rawBotName(rng);
  for (let attempt = 0; attempt < 8 && seen.has(name); attempt++) name = rawBotName(rng);
  if (seen.has(name)) {
    let n = 2;
    while (seen.has(`${name.slice(0, 16 - String(n).length)}${n}`)) n++;
    name = `${name.slice(0, 16 - String(n).length)}${n}`;
  }
  seen.add(name);
  return name;
}

/**
 * `count` DISTINCT handles. Collisions are re-rolled a bounded number of times
 * and then disambiguated with a numeral, so this always terminates and always
 * returns exactly `count` names — two identically-named bots in one match would
 * be worse than a slightly duller name.
 */
export function generateBotNames(rng: () => number, count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const name = generateBotName(rng);
    seen.add(name);
    out.push(name);
  }
  return out;
}
