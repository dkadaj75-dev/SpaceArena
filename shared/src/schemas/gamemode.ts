import { z } from "zod";
import { baseShape } from "./base.js";

/** Extensible discriminated union of win conditions. */
export const winCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("destroyTargets"), count: z.number().int().positive() }),
  z.object({ type: z.literal("fragLimit"), count: z.number().int().positive() }),
  z.object({ type: z.literal("timeLimit"), seconds: z.number().positive() }),
]);
export type WinCondition = z.infer<typeof winCondition>;

/** Extensible discriminated union of arena boundary behaviors. */
export const boundaryRule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bounce"), restitution: z.number().min(0).max(1).optional() }),
  z.object({ type: z.literal("damage"), damagePerSec: z.number().nonnegative() }),
  z.object({
    type: z.literal("damageAndBounce"),
    damagePerSec: z.number().nonnegative(),
    restitution: z.number().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal("warning"), graceSeconds: z.number().nonnegative().optional() }),
]);
export type BoundaryRule = z.infer<typeof boundaryRule>;

/**
 * One entry of a gamemode's pre-placed bot roster (Phase 5 §10A). Purely data:
 * which behaviour profile drives the bot, which ship it flies, which team it
 * joins and how many of it to spawn.
 */
export const gamemodeBotSlot = z.object({
  /** `botprofile` config id driving this bot. */
  profile: z.string(),
  /** `ship` config id to spawn (defaults to the gamemode's `bots.defaultShip`). */
  ship: z.string().optional(),
  team: z.number().int().nonnegative(),
  count: z.number().int().positive().optional(),
});
export type GamemodeBotSlot = z.infer<typeof gamemodeBotSlot>;

/**
 * Bot configuration for a gamemode. Optional and fully additive: a mode without
 * it behaves exactly as before (no backfill, no roster).
 *  - `roster`   — bots spawned up-front (offline practice-vs-bots modes)
 *  - `defaultProfile`/`defaultShip` — used by the server's empty-slot backfill
 *  - `backfillWaitMs` — how long the room waits for humans before backfilling
 */
export const gamemodeBots = z.object({
  defaultProfile: z.string(),
  defaultShip: z.string().optional(),
  backfillWaitMs: z.number().nonnegative().optional(),
  roster: z.array(gamemodeBotSlot).optional(),
  /**
   * Roll each bot a random hull and weapon fitting instead of flying the slot's
   * authored ship on its stock loadout (owner 2026-07-31) — practice stops
   * looking like a mirror match. Bounded to entry-tier weapons and stock
   * internals (see `botLoadout.ts`), so it varies shape, not strength.
   */
  randomizeLoadouts: z.boolean().optional(),
  /**
   * Hull ids the randomiser may draw from. Omitted ⇒ every ship in the pack.
   * Only consulted when `randomizeLoadouts` is on.
   */
  shipPool: z.array(z.string()).optional(),
});
export type GamemodeBots = z.infer<typeof gamemodeBots>;

export const gamemodeSchema = z.object({
  ...baseShape("gamemode"),
  teams: z.enum(["1v1", "2v2"]),
  /** Optional bot roster / backfill policy (Phase 5 5.1). Omitted ⇒ no bots. */
  bots: gamemodeBots.optional(),
  /** Optional default arena id this mode is played on when the room gets none. */
  defaultArena: z.string().optional(),
  winCondition,
  /**
   * Optional HARD time cap (seconds of live match time) layered on top of any
   * `winCondition`: when it elapses the match ends immediately with the
   * top-scoring team as winner — or a DRAW (winner null) on a tie. This is how
   * a frag-limit mode gets a guaranteed end ("first to 10 kills, or whoever
   * leads at 10 minutes"); a `timeLimit` win condition alone cannot coexist
   * with a frag target because `winCondition` is single-choice.
   */
  timeLimitCapSec: z.number().positive().optional(),
  /**
   * When true (default), a team with all ships destroyed loses immediately and
   * the last surviving team wins — an implicit elimination rule layered on top of
   * `winCondition`. Lets the player *lose* a practice `destroyTargets` match.
   * Turn this OFF in respawn modes: between a death and its respawn the team is
   * momentarily "wiped" and the rule would end the match on every kill.
   */
  eliminationEndsMatch: z.boolean().optional().default(true),
  respawn: z.object({
    enabled: z.boolean(),
    delay: z.number().nonnegative(),
  }),
  boundaryRule,
  rewards: z.object({
    win: z.number().int().nonnegative(),
    loss: z.number().int().nonnegative(),
    perKill: z.number().int().nonnegative(),
  }),
});

export type GamemodeConfig = z.infer<typeof gamemodeSchema>;
