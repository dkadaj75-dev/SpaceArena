import { z } from "zod";
import { baseShape } from "./base.js";
import { collisionMeshSchema, validateCollisionMesh } from "./collisionMesh.js";
import { renderRecipe } from "./common.js";

export const propRenderRecipe = renderRecipe;

export const propSchema = z
  .object({
    ...baseShape("prop"),
    category: z.enum(["terrain", "structure", "rock", "decor"]),
    impactDamage: z.number().nonnegative().default(0),
    render: propRenderRecipe,
    collision: collisionMeshSchema.optional(),
  })
  .superRefine((prop, ctx) => {
    if (prop.collision) validateCollisionMesh(prop.collision, ctx);
  });

export type PropConfig = z.infer<typeof propSchema>;
