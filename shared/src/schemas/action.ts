import { z } from "zod";
import { baseShape } from "./base.js";

/** Generic data-driven action primitives (composed, not coded). */
export const actionKind = z.enum([
  "apply_damage",
  "spawn_entity",
  "apply_buff",
  "impulse",
  "play_sound",
  "show_notification",
  "change_asset_state",
  "grant_reward",
]);
export type ActionKind = z.infer<typeof actionKind>;

export const actionSchema = z.object({
  ...baseShape("action"),
  kind: actionKind,
  /**
   * Free-form params bag interpreted by the runtime per `kind`. Cross-reference
   * fields (e.g. `notification`, `sound`) are plain strings here; reference
   * resolution happens in ConfigService.
   */
  params: z.record(z.string(), z.unknown()).optional(),
});

export type ActionConfig = z.infer<typeof actionSchema>;
