import { z } from "zod";
import { baseShape } from "./base.js";

/** Extensible discriminated union of win conditions. */
export const winCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("destroyTargets"), count: z.number().int().positive() }),
  z.object({ type: z.literal("fragLimit"), count: z.number().int().positive() }),
  z.object({ type: z.literal("timeLimit"), seconds: z.number().positive() }),
  /** First team to `count` flag captures wins (owner 2026-07-31). Needs `ctf`. */
  z.object({ type: z.literal("captureLimit"), count: z.number().int().positive() }),
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
  /** Explicit positional fitting. When present it always beats randomization. */
  fitting: z.array(z.string().nullable()).optional(),
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

/**
 * Capture-the-flag rules (owner 2026-07-31). Present ⇒ the sim spawns one flag
 * per authored `arena.flagBases` entry and runs {@link import("../sim/systems/CtfSystem.js").ctfSystem}.
 *
 * The rules themselves are fixed (they are the mode); what is authored here is
 * the feel: how close you have to fly to take a flag, how long a dropped one
 * waits for a rescue, and how long its trail hangs in space behind it.
 */
export const gamemodeCtf = z.object({
  /**
   * Distance within which flying past a flag takes it, in world units. Measured
   * surface-to-centre — the ship's own collider radius counts, so a big hull
   * scoops a flag slightly earlier than a small one, which is the intuition.
   */
  pickupRadius: z.number().positive().default(4),
  /**
   * Seconds a dropped flag waits in space before returning itself to base.
   * The whole tension of a dropped flag: rescue it or lose the run.
   */
  dropReturnSec: z.number().nonnegative().default(10),
  /**
   * Length of the flag's wake, in world units (≈ 200 m at the shipped
   * `theme.hud.metersPerUnit` of 2). Drawn in 3D and on the radar so a runner
   * can be tracked across the arena rather than merely spotted.
   */
  trailLength: z.number().nonnegative().default(100),
});
export type GamemodeCtf = z.infer<typeof gamemodeCtf>;

export const gamemodeSchema = z.object({
  ...baseShape("gamemode"),
  teams: z.enum(["1v1", "2v2", "5v5", "10v10"]),
  /** How this mode is launched. Tutorial is the only shipped offline mode. */
  launch: z.enum(["online", "offline"]).optional().default("online"),
  /**
   * Ships in the pack but is NOT offered on the Play menu. For modes that exist
   * to be *run*, not chosen: the bot-behaviour audit's duel, the
   * 1v1 skirmish the sim tests build their worlds from. Distinct from
   * `launch: "offline"`, which says how a mode starts rather than whether a
   * player is ever shown it.
   */
  hidden: z.boolean().optional().default(false),
  /**
   * How this mode is presented on the main menu.
   *
   * The menu's SECTIONS are fixed in shape but not in content: a pack that adds
   * a mode gets a menu entry with no code change, and the grouping is authored
   * here rather than hardcoded in the screen. Absent ⇒ the mode lands under the
   * catch-all heading with its full name.
   */
  menu: z
    .object({
      /** Section heading to file this mode under, e.g. "Team Deathmatch". */
      group: z.string().min(1),
      /**
       * Short face on the card ("2v2"), when the group heading already carries
       * the mode name. Absent ⇒ the mode's own `name`.
       */
      label: z.string().min(1).optional(),
      /** One line under the label, for what a player cannot infer from "5v5". */
      blurb: z.string().optional(),
      /** Sort key inside the group; ties fall back to pack order. */
      order: z.number().optional(),
      /**
       * Icon key the menu draws. Unknown keys fall back to the group's own icon,
       * so a pack naming an icon this client does not ship still gets a button.
       */
      icon: z.string().optional(),
    })
    .optional(),
  /** Optional bot roster / backfill policy (Phase 5 5.1). Omitted ⇒ no bots. */
  bots: gamemodeBots.optional(),
  /** Optional default arena id this mode is played on when the room gets none. */
  defaultArena: z.string().optional(),
  winCondition,
  /** Capture-the-flag rules; omitted ⇒ no flags, no bases, no captures. */
  ctf: gamemodeCtf.optional(),
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
}).superRefine((mode, ctx) => {
  // A capture target with nothing to capture would be a match that can only end
  // on the clock — fail the pack instead of shipping an unwinnable mode.
  if (mode.winCondition.type === "captureLimit" && !mode.ctf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a 'captureLimit' win condition needs a `ctf` block (and an arena with flagBases)",
      path: ["ctf"],
    });
  }
});

export type GamemodeConfig = z.infer<typeof gamemodeSchema>;
