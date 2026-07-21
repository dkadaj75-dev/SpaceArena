import { z } from "zod";
import { baseShape } from "./base.js";

export const notificationSchema = z.object({
  ...baseShape("notification"),
  text: z.string(),
  style: z.enum(["info", "warning", "critical", "success"]),
  durationMs: z.number().positive(),
  /** Optional event id whose firing shows this notification. */
  triggerEvent: z.string().optional(),
});

export type NotificationConfig = z.infer<typeof notificationSchema>;
