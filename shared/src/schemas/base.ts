import { z } from "zod";

/**
 * Every config id follows the `type.slug` convention, e.g. `ship.interceptor`,
 * `module.laser-mk1`, `action.play-sound-laser`. Lowercase, a dotted namespace,
 * then a hyphen/digit slug.
 */
export const ID_PATTERN = /^[a-z][a-z0-9]*\.[a-z0-9][a-z0-9-]*$/;

export const configId = z
  .string()
  .regex(ID_PATTERN, "id must look like `type.slug`, e.g. `ship.interceptor`");

/**
 * Shared base shape for every config object. Spread into each schema's shape so
 * every config carries `{ id, type, version, name? }`.
 */
export function baseShape<T extends string>(type: T) {
  return {
    id: configId,
    type: z.literal(type),
    version: z.number().int().positive(),
    name: z.string().optional(),
  };
}
