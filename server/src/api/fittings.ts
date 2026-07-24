import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { createFittingBodySchema, updateFittingBodySchema, type HardpointMap } from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { fittingsRepo, ownedModulesRepo, profilesRepo } from "../db/repos.js";
import { asyncHandler, parseBody, requireAuth, sendError, type AuthedRequest } from "./http.js";
import { validateFitting } from "./fittingValidation.js";

/** Build the set of module ids a user owns. */
export function ownedSet(userId: string): Set<string> {
  return new Set(ownedModulesRepo.byUser(userId).map((r) => r.module_id));
}

/** Validate a fitting body against config + ownership + level; 400 on failure. */
function checkFitting(res: Response, userId: string, shipId: string, map: HardpointMap): boolean {
  const profile = profilesRepo.byUser(userId);
  const result = validateFitting(getConfigService(), shipId, map, ownedSet(userId), profile?.level ?? 1);
  if (!result.ok) {
    sendError(res, 400, result.code, result.message);
    return false;
  }
  return true;
}

export function createFittingsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/fittings — the user's fittings.
  router.get(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      res.json({ fittings: fittingsRepo.byUser(req.userId!) });
    }),
  );

  // POST /api/fittings — create a validated fitting.
  router.post(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, createFittingBodySchema, req.body);
      if (!body) return;
      if (!checkFitting(res, req.userId!, body.shipId, body.hardpointMap)) return;
      const fitting = fittingsRepo.create({
        id: randomUUID(),
        user_id: req.userId!,
        ship_id: body.shipId,
        name: body.name,
        hardpointMap: body.hardpointMap,
      });
      res.status(201).json({ fitting });
    }),
  );

  // PUT /api/fittings/:id — rename and/or re-fit.
  router.put(
    "/:id",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, updateFittingBodySchema, req.body);
      if (!body) return;
      const existing = fittingsRepo.byId(req.params.id as string);
      if (!existing || existing.user_id !== req.userId!) {
        sendError(res, 404, "not-found", "fitting not found");
        return;
      }
      if (body.hardpointMap && !checkFitting(res, req.userId!, existing.ship_id, body.hardpointMap)) return;
      fittingsRepo.update(existing.id, body);
      res.json({ fitting: fittingsRepo.byId(existing.id) });
    }),
  );

  // DELETE /api/fittings/:id
  router.delete(
    "/:id",
    asyncHandler(async (req: AuthedRequest, res) => {
      const existing = fittingsRepo.byId(req.params.id as string);
      if (!existing || existing.user_id !== req.userId!) {
        sendError(res, 404, "not-found", "fitting not found");
        return;
      }
      fittingsRepo.delete(existing.id);
      res.json({ ok: true });
    }),
  );

  return router;
}
