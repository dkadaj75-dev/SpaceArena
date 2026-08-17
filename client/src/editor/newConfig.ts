import { z } from "zod";
import { CONFIG_SCHEMAS, type AnyConfig, type ConfigType } from "@space-arena/shared";
import { defaultFor, type JsonSchema } from "./SchemaFormGen.js";

/**
 * Content a schema-default skeleton cannot invent: `.min(1)` lists, ids that
 * must resolve, and numbers whose only valid value is a domain fact rather than
 * a bound. Everything else is derived from the Zod schema, so a new field on a
 * schema needs no change here.
 */
const TEMPLATES: Partial<Record<ConfigType, Record<string, unknown>>> = {
  arena: {
    bounds: { shape: "sphere", radius: 150 },
    // `spawnPoints` is `.min(1)` and each must sit inside the bounds.
    spawnPoints: [
      { id: "spawn-1", team: 0, position: { x: -40, y: 0, z: 0 }, heading: 0 },
      { id: "spawn-2", team: 1, position: { x: 40, y: 0, z: 0 }, heading: Math.PI },
    ],
    asteroidPlacements: [],
  },
  ship: {
    // At least one hardpoint, or the schema's own refinement rejects the hull.
    sockets: [
      { id: "hp-1", kind: "hardpoint", accepts: ["laser", "kinetic"], transform: { pos: [0, 0, 1.5] } },
      { id: "int-1", kind: "internal", accepts: ["engine"], transform: { pos: [0, 0, -1.5] } },
    ],
  },
  upgrade: {
    levels: [{ level: 1, price: 0 }],
  },
  progression: {
    xpCurve: [100],
  },
  botprofile: {
    preferredRange: [10, 40],
  },
};

/**
 * Types whose required fields are cross-references: a blank one would be born
 * dangling, so Constellation duplicates an existing config instead.
 */
export const TEMPLATELESS_TYPES: readonly ConfigType[] = ["cosmetic", "tutorial"];

/** First free `<type>.custom-N` id, matching the bespoke panels' New/Duplicate naming. */
export function newConfigId(type: ConfigType, existing: readonly string[]): string {
  let n = 1;
  while (existing.includes(`${type}.custom-${n}`)) n++;
  return `${type}.custom-${n}`;
}

/**
 * A minimal config of `type` built from its Zod schema's own defaults, with the
 * per-type template above filling in what the schema cannot derive.
 *
 * Returns null when the result does not validate — the caller then falls back to
 * duplicating an existing config of that type, which always works.
 */
export function newConfigOf(type: ConfigType, id: string): AnyConfig | null {
  let skeleton: unknown;
  try {
    const json = z.toJSONSchema(CONFIG_SCHEMAS[type]) as JsonSchema;
    skeleton = defaultFor(json, json.$defs);
  } catch {
    return null;
  }
  if (!skeleton || typeof skeleton !== "object") return null;
  const seed = { ...(skeleton as Record<string, unknown>), ...TEMPLATES[type], id, type, version: 1, name: id };
  const parsed = CONFIG_SCHEMAS[type].safeParse(seed);
  return parsed.success ? (parsed.data as AnyConfig) : null;
}
