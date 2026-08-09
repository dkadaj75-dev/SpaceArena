import { z } from "zod";
import { baseShape, configId } from "./base.js";
import { moduleFamily } from "./common.js";

/**
 * A TUTORIAL: the onboarding flow authored as data, not as a switch statement in
 * the client (owner 2026-08-08 — "everything is content").
 *
 * The shape is a flat, ordered list of {@link tutorialStep}s. Each step says
 * three things and nothing else:
 *
 *   - WHERE it happens (`stage`: the arena, the lobby, the hangar, the shop),
 *   - WHAT the instructor says (`title`/`text`/`hint`, plus an optional
 *     `highlight` naming a control to ring),
 *   - WHEN it is over (`condition`, a typed completion test).
 *
 * A step may additionally `spawn` a scripted actor — the practice hulk, then the
 * live drone. Spawns are deliberately per-STEP rather than a gamemode roster: a
 * tutorial that put both targets in the arena at once would be teaching the
 * player to fight two ships before it had taught them to shoot one.
 *
 * The client half is `client/src/game/tutorial/` — {@link TutorialDirector}
 * walks this list, `tutorialConditions.ts` evaluates the tests, and the overlay
 * draws the coach mark. Nothing in there knows the flow; it only knows how to
 * run one.
 */

/** Where a step takes place. A change of stage IS the instruction to navigate. */
export const tutorialStage = z.enum(["flight", "lobby", "hangar", "shop"]);
export type TutorialStage = z.infer<typeof tutorialStage>;

/** Which scripted actor a step spawns / asks the player to kill. */
export const tutorialActorRole = z.enum(["dummy", "bot"]);
export type TutorialActorRole = z.infer<typeof tutorialActorRole>;

/**
 * A LOGICAL control to ring with a coach mark, never a CSS selector: content
 * names the affordance ("the throttle"), the client owns which node that is
 * today. A selector in a content pack would break the moment a widget's class
 * changed, and content must not be able to break on a refactor.
 */
export const tutorialHighlight = z.enum([
  "throttle",
  "steer",
  "fire",
  "modules",
  "reticle",
  "minimap",
  "lobby-hangar",
  "lobby-shop",
  "hangar-slots",
  "hangar-modules",
  "shop-tabs",
  "shop-buy",
]);
export type TutorialHighlight = z.infer<typeof tutorialHighlight>;

/**
 * When a step is done. Every member is a fact the client can OBSERVE — from the
 * sim snapshot, from a drained `SimEvent`, or from a screen the player opened —
 * so a step can never complete on a timer the player did not earn (except
 * `dwell`, which is exactly a "read this beat" pause and says so).
 */
export const tutorialCondition = z.discriminatedUnion("kind", [
  /** Commanded throttle reached `value` (0..1). */
  z.object({ kind: z.literal("throttle-above"), value: z.number().min(0).max(1) }),
  /** Total attitude change accumulated during the step, in radians. */
  z.object({ kind: z.literal("heading-changed"), radians: z.number().positive() }),
  /** The player's weapons fired at least `shots` times. */
  z.object({ kind: z.literal("fired"), shots: z.number().int().positive() }),
  /**
   * The lesson of the heat ring, in one condition: fill a weapon's rack past
   * `peak`, then let it fall back under `cooled`. Both as 0..1 fractions of the
   * module's own resolved heat capacity.
   */
  z.object({
    kind: z.literal("heat-above-then-cooled"),
    peak: z.number().min(0).max(1),
    cooled: z.number().min(0).max(1),
  }),
  /**
   * The player brought a module up. `family` narrows it to one kind of module
   * (the shield, for the energy lesson); omitted ⇒ any module at all.
   */
  z.object({ kind: z.literal("module-toggled"), family: moduleFamily.optional() }),
  /** The sim reported a completed lock for the player's ship. */
  z.object({ kind: z.literal("lock-acquired") }),
  /** A scripted actor died. `any` accepts either. */
  z.object({ kind: z.literal("kill"), target: z.union([tutorialActorRole, z.literal("any")]) }),
  /** The player opened a screen (this is how the menu steps are taught). */
  z.object({ kind: z.literal("screen-visited"), screen: tutorialStage }),
  /** The hangar's working loadout changed — a module was fitted, swapped or cleared. */
  z.object({ kind: z.literal("loadout-changed") }),
  /** The ownership ledger recorded a purchase (hull, module or paint). */
  z.object({ kind: z.literal("purchase-made") }),
  /** A pure beat: hold the line on screen for `seconds`, then move on. */
  z.object({ kind: z.literal("dwell"), seconds: z.number().positive() }),
  /** The player pressed the coach mark's confirm button. */
  z.object({ kind: z.literal("acknowledged") }),
]);
export type TutorialCondition = z.infer<typeof tutorialCondition>;

/**
 * A scripted actor placed in front of the player when its step begins.
 *
 * `profile` is what separates the two targets the tutorial needs: WITH one the
 * actor gets a bot driver and fights back, WITHOUT one it is an inert hulk — no
 * driver, no orders, no trigger — which is the disarmed target the shipped pack
 * no longer has a gamemode for.
 */
export const tutorialSpawn = z.object({
  role: tutorialActorRole,
  ship: configId,
  /** Positional fitting (index = hardpoint index, `null` = empty). Default: nothing fitted. */
  fitting: z.array(z.string().nullable()).optional(),
  /** Bot profile to drive it. Omitted ⇒ an inert, disarmed hulk. */
  profile: configId.optional(),
  /** Placed this many world units along the player's nose. */
  aheadDistance: z.number().positive().default(45),
  /**
   * Starting hull. The point of a TUTORIAL target is that it dies inside a
   * lesson, and the shipped hulls are balanced for an 8–45 s duel — so the hulk
   * comes in pre-wrecked rather than at full health. Omitted ⇒ full hull.
   */
  hull: z.number().positive().optional(),
  /** Team it joins. Anything but the player's team is an enemy. */
  team: z.number().int().nonnegative().default(1),
  /** Name shown on the reticle and in the kill feed. */
  callsign: z.string().optional(),
});
export type TutorialSpawn = z.infer<typeof tutorialSpawn>;

export const tutorialStep = z.object({
  /** Slug, unique within the tutorial. Used by tests and telemetry, never shown. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "step id must be a lowercase slug"),
  stage: tutorialStage,
  /** Short all-caps banner ("GUNS"). */
  title: z.string().min(1),
  /** The instructor's line. Keep it to a breath — this is a coach mark, not a manual. */
  text: z.string().min(1),
  /** Optional second line, quieter: the concrete "do this" when `text` is a joke. */
  hint: z.string().optional(),
  highlight: tutorialHighlight.optional(),
  condition: tutorialCondition,
  spawn: tutorialSpawn.optional(),
  /** Linger this long after the condition fires, so the beat lands. */
  holdMs: z.number().nonnegative().optional(),
});
export type TutorialStep = z.infer<typeof tutorialStep>;

export const tutorialSchema = z.object({
  ...baseShape("tutorial"),
  /** The gamemode its flight stage runs in. */
  gamemode: configId,
  /** Arena override; omitted ⇒ the gamemode's `defaultArena`. */
  arena: configId.optional(),
  /**
   * What the player flies for the lesson — authored, NOT the hangar loadout.
   * The flow teaches a specific heat ring and a specific energy ring, so it has
   * to know a weapon and a shield are actually fitted.
   */
  pilot: z.object({
    ship: configId,
    fitting: z.array(z.string().nullable()).min(1),
  }),
  /** Who is talking. Shown on every coach mark. */
  instructor: z.string().default("ARENA COMMAND"),
  /** Toast raised when the last step completes. */
  completeToast: z.string().min(1),
  steps: z.array(tutorialStep).min(1),
});

export type TutorialConfig = z.infer<typeof tutorialSchema>;

/** The canonical onboarding flow shipped with the default pack. */
export const BASICS_TUTORIAL_ID = "tutorial.basics";
