import { Router } from "express";
import { createConfigBodySchema, validateConfig } from "@space-arena/shared";
import { withTransaction } from "../db/index.js";
import { userConfigsRepo } from "../db/repos.js";
import { asyncHandler, parseBody, requireAuth, sendError, type AuthedRequest } from "./http.js";

/**
 * Full-uuid user prefix (hyphens stripped) used to namespace saved configs.
 * Using the whole id — not a truncated prefix — makes the namespace globally
 * collision-safe across users.
 */
function userPrefix(userId: string): string {
  return userId.replace(/-/g, "").toLowerCase();
}

/** Sanitize a raw slug candidate to the `[a-z0-9-]` slug charset. */
function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "config";
}

/**
 * Force the collision-proof namespace `user.<uid8>-<slug>`. A single dot is
 * required by the shared config id pattern (`type.slug`), so the userId + slug
 * are joined with a dash after the `user.` prefix rather than dotted.
 */
export function namespaceConfigId(userId: string, rawId: unknown, name: unknown): string {
  let slugSource = "config";
  if (typeof rawId === "string" && rawId.includes(".")) {
    slugSource = rawId.slice(rawId.lastIndexOf(".") + 1);
  } else if (typeof rawId === "string" && rawId) {
    slugSource = rawId;
  } else if (typeof name === "string" && name) {
    slugSource = name;
  }
  return `user.${userPrefix(userId)}-${slugify(slugSource)}`;
}

export function createConfigsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/configs — the user's saved configs (parsed json).
  router.get(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      const configs = userConfigsRepo.byUser(req.userId!).map((row) => ({
        id: row.id,
        type: row.type,
        visibility: row.visibility,
        updatedAt: row.updated_at,
        json: JSON.parse(row.json) as unknown,
      }));
      res.json({ configs });
    }),
  );

  // POST /api/configs { json, visibility? } — validate + save under user namespace.
  router.post(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, createConfigBodySchema, req.body);
      if (!body) return;

      const incoming = body.json as Record<string, unknown>;
      const finalId = namespaceConfigId(req.userId!, incoming.id, incoming.name);
      const candidate = { ...incoming, id: finalId };

      const validation = validateConfig(candidate);
      if (!validation.success) {
        const msg = validation.error ? validation.error.issues[0]?.message : validation.message;
        sendError(res, 400, "invalid-config", msg ?? "config failed schema validation");
        return;
      }

      // Owner-constrained upsert (10): an id owned by another user is never
      // overwritten. The full-uuid namespace makes this near-impossible, but the
      // check inside the transaction closes the race regardless.
      const row = withTransaction(() => {
        const existing = userConfigsRepo.byId(finalId);
        if (existing && existing.user_id !== req.userId!) return null;
        return userConfigsRepo.upsert({
          id: finalId,
          user_id: req.userId!,
          type: validation.type,
          json: JSON.stringify(validation.data),
          visibility: body.visibility,
        });
      });
      if (!row) {
        sendError(res, 409, "id-conflict", "a config with this id belongs to another user");
        return;
      }
      res.status(201).json({
        config: { id: row.id, type: row.type, visibility: row.visibility, updatedAt: row.updated_at, json: validation.data },
      });
    }),
  );

  // DELETE /api/configs/:id — remove one of the user's configs.
  router.delete(
    "/:id",
    asyncHandler(async (req: AuthedRequest, res) => {
      const existing = userConfigsRepo.byId(req.params.id as string);
      if (!existing || existing.user_id !== req.userId!) {
        sendError(res, 404, "not-found", "config not found");
        return;
      }
      userConfigsRepo.delete(existing.id);
      res.json({ ok: true });
    }),
  );

  return router;
}
