import { Router, type Response } from "express";
import { loadoutFittingId, saveLoadoutBodySchema, type HardpointMap, type ShipConfig } from "@space-arena/shared";
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

/**
 * Loadouts (`/api/fittings`, kept at that path so nothing else on the wire had
 * to move). Since 2026-08-22 a pilot has exactly ONE loadout per hull and it is
 * simply whatever is in the slots, so the create/select/rename/delete surface
 * that named fittings needed is gone:
 *
 *  - `GET /` still lists, and now returns at most one row per ship;
 *  - `PUT /:shipId` upserts THAT ship's loadout. The route parameter is a SHIP
 *    id, not a row id — the row's own id is derived server-side from the
 *    authenticated user and the ship ({@link loadoutFittingId}), which is what
 *    keeps a client from having to know, store, or be trusted with a row id at
 *    all. A pilot cannot address another pilot's row because they cannot mint
 *    the user half of the key.
 *
 * `POST /` and `DELETE /:id` are deliberately not here rather than left
 * unwired: creating a second loadout is meaningless now, and deleting one would
 * only mean "put the stock fit back", which emptying the slots already does.
 */
export function createFittingsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/fittings — the user's loadouts, one per hull.
  router.get(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      res.json({ fittings: fittingsRepo.byUser(req.userId!) });
    }),
  );

  // PUT /api/fittings/:shipId — this hull's loadout becomes what was sent.
  router.put(
    "/:shipId",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, saveLoadoutBodySchema, req.body);
      if (!body) return;
      const shipId = req.params.shipId as string;
      // A stale client PUTting a legacy row uuid lands here and gets a clean
      // 404 rather than minting a loadout for a ship that does not exist.
      if (!getConfigService().get<ShipConfig>("ship", shipId)) {
        sendError(res, 404, "not-found", "unknown ship");
        return;
      }
      if (!checkFitting(res, req.userId!, shipId, body.hardpointMap)) return;
      const fitting = fittingsRepo.upsert({
        id: loadoutFittingId(req.userId!, shipId),
        user_id: req.userId!,
        ship_id: shipId,
        hardpointMap: body.hardpointMap,
      });
      res.json({ fitting });
    }),
  );

  return router;
}
