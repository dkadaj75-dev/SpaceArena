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
  z.object({ type: z.literal("warning"), graceSeconds: z.number().nonnegative().optional() }),
]);
export type BoundaryRule = z.infer<typeof boundaryRule>;

export const gamemodeSchema = z.object({
  ...baseShape("gamemode"),
  teams: z.enum(["1v1", "2v2"]),
  winCondition,
  /**
   * When true (default), a team with all ships destroyed loses immediately and
   * the last surviving team wins — an implicit elimination rule layered on top of
   * `winCondition`. Lets the player *lose* a practice `destroyTargets` match.
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
