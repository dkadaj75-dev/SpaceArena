import { z } from "zod";
import { baseShape } from "./base.js";

/** Trigger names that fire an event's actions. Extensible. */
export const eventTrigger = z.enum([
  "on_shield_down",
  "on_overheat",
  "on_enter_zone",
  "on_kill",
  "on_match_start",
  "on_low_energy",
]);
export type EventTrigger = z.infer<typeof eventTrigger>;

export const eventSchema = z.object({
  ...baseShape("event"),
  trigger: eventTrigger,
  /** Action ids dispatched when the trigger fires. */
  actions: z.array(z.string()),
});

export type EventConfig = z.infer<typeof eventSchema>;
