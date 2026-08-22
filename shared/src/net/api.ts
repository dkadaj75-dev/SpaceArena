import { z } from "zod";

/**
 * REST API request contracts shared by client and server. The server validates
 * every request body against these; the client reuses them to pre-validate and
 * to type its fetch calls. Keep this the single source of truth for the HTTP API
 * (the Colyseus wire protocol lives in protocol.ts).
 *
 * Response shapes are documented in server/src/api/README.md; only request
 * bodies are schema-validated (responses are server-authored).
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Password policy: keep it simple but non-trivial for the MVP. */
export const passwordSchema = z.string().min(8).max(200);
export const emailSchema = z.string().email().max(200);
export const displayNameSchema = z.string().min(1).max(40);

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const guestBodySchema = z.object({
  displayName: displayNameSchema.optional(),
  /** Restore an existing guest identity (from localStorage) instead of creating one. */
  guestToken: z.string().min(1).max(200).optional(),
});
export type GuestBody = z.infer<typeof guestBodySchema>;

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1).max(4096),
});
export type RefreshBody = z.infer<typeof refreshBodySchema>;

// ---------------------------------------------------------------------------
// Fittings
// ---------------------------------------------------------------------------

/**
 * A fitting's hardpoint map: hardpoint index (as string key) → module id.
 * Missing indices = empty hardpoint. Kept as a record so it round-trips to JSON.
 */
export const hardpointMapSchema = z.record(
  z.string().regex(/^\d+$/, "hardpoint key must be a non-negative integer"),
  z.string(),
);
export type HardpointMap = z.infer<typeof hardpointMapSchema>;

/**
 * A pilot has exactly ONE loadout per hull, and it is whatever is in the slots
 * (owner 2026-08-22: "when a player fits its ship, it becomes the fitting the
 * ship is going to use — we don't need to save fitting names etc").
 *
 * Named fittings are gone: no save, no load, no select, no delete, no names
 * anywhere. What is left is a single implicit row per (user, ship), and this is
 * its well-known id. Deriving it rather than allocating a uuid is what let the
 * change stay inside the existing `/api/fittings` shape — the row is addressable
 * without a lookup table, an upsert needs no "does it exist yet" round trip, and
 * the id itself carries the ownership claim the server re-checks anyway.
 *
 * The user id is part of the key because `fittings.id` is the table's primary
 * key and therefore global: two pilots flying the same hull need two rows.
 */
export const LOADOUT_FITTING_PREFIX = "loadout:";

export function loadoutFittingId(userId: string, shipId: string): string {
  return `${LOADOUT_FITTING_PREFIX}${userId}:${shipId}`;
}

/**
 * `PUT /api/fittings/:shipId` — the whole write surface for a loadout. There is
 * no create/delete pair any more: a hull always has a loadout (its stock fit
 * until the pilot touches a slot), so every write is an upsert of the same row,
 * and "delete" would only mean "put the stock fit back", which is what emptying
 * the slots already does.
 */
export const saveLoadoutBodySchema = z.object({
  hardpointMap: hardpointMapSchema,
});
export type SaveLoadoutBody = z.infer<typeof saveLoadoutBodySchema>;

// ---------------------------------------------------------------------------
// Ships / upgrades / modules
// ---------------------------------------------------------------------------

export const upgradeTrack = z.enum(["hull", "engine", "energy"]);
export type UpgradeTrackName = z.infer<typeof upgradeTrack>;

export const upgradeBodySchema = z.object({
  track: upgradeTrack,
});
export type UpgradeBody = z.infer<typeof upgradeBodySchema>;

export const buyModuleBodySchema = z.object({
  moduleId: z.string().min(1).max(80),
});
export type BuyModuleBody = z.infer<typeof buyModuleBodySchema>;

// ---------------------------------------------------------------------------
// Shop (hulls + cosmetics)
// ---------------------------------------------------------------------------

export const buyShipBodySchema = z.object({
  shipId: z.string().min(1).max(80),
});
export type BuyShipBody = z.infer<typeof buyShipBodySchema>;

export const buyCosmeticBodySchema = z.object({
  cosmeticId: z.string().min(1).max(80),
});
export type BuyCosmeticBody = z.infer<typeof buyCosmeticBodySchema>;

/**
 * Equip a paint on a hull. `cosmeticId: null` clears back to the authored look
 * — the same state an absent selection describes, sent explicitly so unequipping
 * is one request and not a delete route.
 */
export const selectCosmeticBodySchema = z.object({
  shipId: z.string().min(1).max(80),
  cosmeticId: z.string().min(1).max(80).nullable(),
});
export type SelectCosmeticBody = z.infer<typeof selectCosmeticBodySchema>;

/**
 * The whole inventory in one read (returned by `GET /api/auth/me` alongside the
 * profile). Ownership is DERIVED at read time — the starter hull, the free
 * starter modules and the standard paint are never seeded rows — so re-authoring
 * the starter set repairs every existing account instead of stranding it.
 */
export interface ApiInventory {
  ships: string[];
  modules: string[];
  cosmetics: string[];
  /** ship id → equipped cosmetic id. Absent key = the hull's authored look. */
  selections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// User configs
// ---------------------------------------------------------------------------

export const createConfigBodySchema = z.object({
  /** The config JSON object (must carry a valid `type`, validated server-side). */
  json: z.record(z.string(), z.unknown()),
  visibility: z.enum(["private", "public"]).optional(),
});
export type CreateConfigBody = z.infer<typeof createConfigBodySchema>;

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/** Consistent error JSON returned by every API route. */
export interface ApiError {
  error: { code: string; message: string };
}
