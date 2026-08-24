/**
 * Anonymous "who has the game open" presence (owner request 2026-08-23: a
 * discreet player count on the main menu).
 *
 * The client's periodic `/health` probe carries a stable anonymous id in an
 * `x-sa-client` header; each sighting refreshes that id's lease here, and the
 * count is simply how many leases are still live. Deliberately NOT tied to
 * room connections: a pilot browsing the hangar between matches is online in
 * every sense the menu cares about, and several clients behind one NAT (or a
 * playtest fleet on localhost) must each count once — which an IP-keyed count
 * cannot do.
 *
 * Best-effort by design: ids are self-issued and unauthenticated, so this is a
 * vanity number, not a metric — the caps below only keep a hostile client from
 * turning it into a memory leak.
 */

/** A client that has not probed for this long has closed the game. The client
 *  probes far more often than this in both its online and offline loops. */
const LEASE_MS = 90_000;
/** Self-issued ids are truncated, not rejected — the count must never throw. */
const MAX_ID_LENGTH = 64;
/** Hard ceiling on tracked ids; beyond it new ids are dropped, not evicted —
 *  an attacker inflating the map must not be able to evict real players. */
const MAX_TRACKED = 10_000;

const leases = new Map<string, number>();

function prune(now: number): void {
  for (const [id, seen] of leases) {
    if (now - seen > LEASE_MS) leases.delete(id);
  }
}

/** Record one sighting of `id`. Call on every health probe that carries one. */
export function notePresence(id: string, now = Date.now()): void {
  const key = id.slice(0, MAX_ID_LENGTH);
  if (key === "") return;
  if (!leases.has(key)) {
    prune(now); // make room from expired leases before enforcing the ceiling
    if (leases.size >= MAX_TRACKED) return;
  }
  leases.set(key, now);
}

/** Clients seen within the lease window. */
export function onlineCount(now = Date.now()): number {
  prune(now);
  return leases.size;
}

/** Tests only: forget everything. */
export function resetPresence(): void {
  leases.clear();
}
