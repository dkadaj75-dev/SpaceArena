import { Router } from "express";
import {
  buyCosmeticBodySchema,
  cosmeticAppliesTo,
  selectCosmeticBodySchema,
  STANDARD_COSMETIC_ID,
  type CosmeticConfig,
  type ShipConfig,
} from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { withTransaction } from "../db/index.js";
import { ownedCosmeticsRepo, profilesRepo, selectedCosmeticsRepo } from "../db/repos.js";
import { asyncHandler, parseBody, requireAuth, sendError, type AuthedRequest } from "./http.js";
import { ownedCosmeticIds, ownedShipIds } from "./ownership.js";

/**
 * Cosmetic purchase + equip. The catalog is NOT served here: cosmetics are
 * content, and every client already holds the pack — a second copy over REST
 * could only disagree with it.
 */
export function createCosmeticsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // POST /api/cosmetics/buy { cosmeticId } — spend credits to own a paint.
  router.post(
    "/buy",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, buyCosmeticBodySchema, req.body);
      if (!body) return;
      const configs = getConfigService();
      const cosmetic = configs.get<CosmeticConfig>("cosmetic", body.cosmeticId);
      if (!cosmetic) {
        sendError(res, 404, "unknown-cosmetic", `unknown cosmetic: ${body.cosmeticId}`);
        return;
      }
      const profile = profilesRepo.byUser(req.userId!)!;
      // Idempotent, exactly like the hull buy: already owning it is the outcome
      // the caller wanted, at an unchanged balance.
      if (ownedCosmeticIds(configs, req.userId!).has(cosmetic.id)) {
        res.json({ cosmeticId: cosmetic.id, credits: profile.credits });
        return;
      }
      const credits = withTransaction(() => {
        if (!profilesRepo.tryDebit(req.userId!, cosmetic.price)) return null;
        ownedCosmeticsRepo.grant(req.userId!, cosmetic.id);
        return profilesRepo.byUser(req.userId!)!.credits;
      });
      if (credits === null) {
        sendError(res, 409, "insufficient-credits", `need ${cosmetic.price} credits, have ${profile.credits}`);
        return;
      }
      res.json({ cosmeticId: cosmetic.id, credits });
    }),
  );

  // POST /api/cosmetics/select { shipId, cosmeticId } — equip a paint on a hull.
  router.post(
    "/select",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, selectCosmeticBodySchema, req.body);
      if (!body) return;
      const configs = getConfigService();
      const ship = configs.get<ShipConfig>("ship", body.shipId);
      if (!ship) {
        sendError(res, 404, "unknown-ship", `unknown ship: ${body.shipId}`);
        return;
      }
      if (!ownedShipIds(configs, req.userId!).has(ship.id)) {
        sendError(res, 403, "not-owned", "you do not own this ship");
        return;
      }

      // null / the standard id both mean the authored look, which is stored as
      // the ABSENCE of a row (see migration 005).
      if (body.cosmeticId === null || body.cosmeticId === STANDARD_COSMETIC_ID) {
        selectedCosmeticsRepo.clear(req.userId!, ship.id);
        res.json({ shipId: ship.id, cosmeticId: null });
        return;
      }

      const cosmetic = configs.get<CosmeticConfig>("cosmetic", body.cosmeticId);
      if (!cosmetic) {
        sendError(res, 404, "unknown-cosmetic", `unknown cosmetic: ${body.cosmeticId}`);
        return;
      }
      if (!ownedCosmeticIds(configs, req.userId!).has(cosmetic.id)) {
        sendError(res, 403, "not-owned", "you do not own this cosmetic");
        return;
      }
      if (!cosmeticAppliesTo(cosmetic, ship.id)) {
        sendError(res, 400, "not-applicable", `${cosmetic.id} cannot be equipped on ${ship.id}`);
        return;
      }
      selectedCosmeticsRepo.set(req.userId!, ship.id, cosmetic.id);
      res.json({ shipId: ship.id, cosmeticId: cosmetic.id });
    }),
  );

  return router;
}
