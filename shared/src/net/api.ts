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

export const fittingNameSchema = z.string().min(1).max(60);

export const createFittingBodySchema = z.object({
  shipId: z.string().min(1).max(80),
  name: fittingNameSchema,
  hardpointMap: hardpointMapSchema,
});
export type CreateFittingBody = z.infer<typeof createFittingBodySchema>;

export const updateFittingBodySchema = z.object({
  name: fittingNameSchema.optional(),
  hardpointMap: hardpointMapSchema.optional(),
});
export type UpdateFittingBody = z.infer<typeof updateFittingBodySchema>;

// ---------------------------------------------------------------------------
// Ships / upgrades / modules
// ---------------------------------------------------------------------------

export const upgradeTrack = z.enum(["hull", "engine", "energy", "heat"]);
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
