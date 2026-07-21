import { z } from "zod";
import { baseShape } from "./base.js";

/**
 * The content manifest: a flat list of config file paths (relative to the
 * content/ root) that ConfigService loads and validates.
 */
export const manifestSchema = z.object({
  ...baseShape("manifest"),
  files: z.array(z.string()).min(1),
});

export type ManifestConfig = z.infer<typeof manifestSchema>;
