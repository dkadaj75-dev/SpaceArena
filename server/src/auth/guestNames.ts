const ADJECTIVES = [
  "Crimson",
  "Silent",
  "Solar",
  "Nova",
  "Astral",
  "Iron",
  "Velvet",
  "Radiant",
  "Midnight",
  "Quantum",
  "Stellar",
  "Lunar",
] as const;

const NOUNS = [
  "Vector",
  "Quasar",
  "Comet",
  "Pulsar",
  "Voyager",
  "Nebula",
  "Vanguard",
  "Meteor",
  "Orbit",
  "Beacon",
  "Ranger",
  "Drifter",
] as const;

type NameExists = (name: string) => boolean;

/** Generate a server-owned guest callsign, adding a short suffix on collision. */
export function generateGuestPilotName(
  exists: NameExists,
  random: () => number = Math.random,
  now: () => number = Date.now,
): string {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] ?? ADJECTIVES[0];
  const noun = NOUNS[Math.floor(random() * NOUNS.length)] ?? NOUNS[0];
  const base = `${adjective} ${noun}`;
  if (!exists(base)) return base;

  for (let attempt = 0; attempt < 12; attempt++) {
    const suffix = 100 + Math.floor(random() * 900);
    const candidate = `${base}-${suffix}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${String(now()).slice(-4)}`;
}

