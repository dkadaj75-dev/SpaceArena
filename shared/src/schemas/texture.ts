import { z } from "zod";
import { baseShape } from "./base.js";

/**
 * The project's texture library — the "database of every texture in the
 * project" the Skins tool picks from.
 *
 * A texture is a CONFIG, not a loose file path, for the same reason a ship
 * model is reached through a render recipe: the file can move, the maps that go
 * with it (normal, metallic-roughness) travel as one unit, and a skin refers to
 * something with a name a designer chose rather than to `props/textures/game/
 * aerial_ground_rock_diff_1k.jpg`.
 *
 * Paths are content-relative, exactly like `render.model` and `skybox.texture`.
 */
export const textureSchema = z.object({
  ...baseShape("texture"),
  /** Content-relative albedo/base-colour image (`textures/hull-plate.jpg`). */
  source: z.string().min(1),
  /** Content-relative tangent-space normal map, if the set has one. */
  normal: z.string().optional(),
  /** Content-relative glTF-convention metallic-roughness map (B = metal, G = rough). */
  metallicRoughness: z.string().optional(),
  /**
   * UV repeats across one tile. A hull plate authored at 1 m scale needs to
   * repeat several times over a wing; a bespoke unwrapped skin needs exactly 1.
   */
  scale: z.number().positive().max(64).optional(),
  /**
   * Free-text grouping for the picker ("hull", "camo", "industrial"). Not an
   * enum: this is a browsing aid for a growing library, not a contract, and a
   * closed list would be wrong the first time art arrives that does not fit it.
   */
  category: z.string().optional(),
});

export type TextureConfig = z.infer<typeof textureSchema>;

/** What the picker shows. Falls back to the id's slug, per the base-shape law. */
export function textureDisplayName(texture: Pick<TextureConfig, "id" | "name">): string {
  return texture.name ?? texture.id.split(".").pop() ?? texture.id;
}
