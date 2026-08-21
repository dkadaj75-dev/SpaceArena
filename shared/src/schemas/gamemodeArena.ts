import type { GamemodeConfig } from "./gamemode.js";

/**
 * MAP ROTATION (owner request 2026-08-21) — "Deathmatch and Team Deathmatch
 * should load one or another at random".
 *
 * ## Where the rotation applies, and where it deliberately does not
 *
 * Picking a map at random is only safe where ONE process owns both the
 * simulation and the render of a match, because both sides must land on the
 * same arena or they disagree about the floor, the bounds and the asteroid
 * field.
 *
 *  - **Offline / local-bots** (practice, the dead-server fallback, the editor's
 *    playtest): the client owns the sim, so it rotates. This is also the
 *    designer's loop.
 *  - **Online rooms**: the client resolves its arena from the gamemode config
 *    BEFORE it connects (`NetGameSession.join` builds the session, its static
 *    world and its arena in the constructor, ahead of `NetClient.connect`), and
 *    the arena id appears in no room state, no message and no join option.
 *    There is therefore no channel over which a server-side random pick could
 *    reach the client, and a room that rolled its own map would silently desync
 *    every player in it. Online play stays on `defaultArena` until such a
 *    channel exists — one `@type("string") arenaId` on `ArenaState`, plus
 *    constructing the net session after the first state arrives.
 *
 * That is why `defaultArena` remains the authority and `arenaPool` is an
 * addition rather than a replacement: the pinned value is what the two sides
 * can agree on without talking.
 */

/**
 * Every arena this mode may be played on, in a stable order. Always at least
 * one entry when the mode names any arena at all; empty only for a mode that
 * authors neither field (the caller then falls back to its own default).
 *
 * `defaultArena` is included even when a pool is authored — a mode's pinned map
 * is a member of its own rotation, not an alternative to it — and duplicates
 * are collapsed so authoring it in both places does not weight it twice.
 */
export function arenaChoicesOf(gamemode: Pick<GamemodeConfig, "defaultArena" | "arenaPool"> | undefined): string[] {
  if (!gamemode) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [gamemode.defaultArena, ...(gamemode.arenaPool ?? [])]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Choose one of `choices` using `roll`, a number in [0, 1) — injected rather
 * than taken from `Math.random` so a caller with a match seed can make the
 * pick reproducible (and so this stays a pure function the tests can pin).
 *
 * A roll at or past 1, or a NaN, lands on the last/first entry rather than
 * indexing off the end.
 */
export function pickArena(choices: readonly string[], roll: number): string | undefined {
  if (choices.length === 0) return undefined;
  if (!Number.isFinite(roll)) return choices[0];
  const index = Math.floor(Math.min(Math.max(roll, 0), 0.999999) * choices.length);
  return choices[Math.min(index, choices.length - 1)];
}
