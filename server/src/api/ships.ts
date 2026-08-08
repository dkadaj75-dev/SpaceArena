import { Router } from "express";
import {
  buyShipBodySchema,
  hardpointsOf,
  shipPrice,
  upgradeBodySchema,
  type ShipConfig,
  type UpgradeConfig,
  type UpgradeTrackName,
} from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { withTransaction } from "../db/index.js";
import { ownedShipsRepo, profilesRepo, shipUpgradesRepo, type ShipUpgradeRow } from "../db/repos.js";
import { ownedShipIds } from "./ownership.js";
import { asyncHandler, parseBody, requireAuth, sendError, type AuthedRequest } from "./http.js";

const TRACK_TO_ROW: Record<UpgradeTrackName, keyof ShipUpgradeRow> = {
  hull: "hull_lvl",
  engine: "engine_lvl",
  energy: "energy_lvl",
  heat: "heat_lvl",
};

/** Current level of a track for a user+ship (0 if never upgraded). */
function trackLevel(userId: string, shipId: string, track: UpgradeTrackName): number {
  const row = shipUpgradesRepo.get(userId, shipId);
  return row ? (row[TRACK_TO_ROW[track]] as number) : 0;
}

export function createShipsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/ships — ships + this user's upgrade levels per track.
  router.get(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      const configs = getConfigService();
      const ships = configs.getAll<ShipConfig>("ship").map((ship) => ({
        id: ship.id,
        name: ship.name,
        class: ship.class,
        // Ordered hardpoint list derived from the socket graph (id + accepts,
        // matching the pre-socket API shape). Emitter sockets are visual-only.
        hardpoints: hardpointsOf(ship).map((h) => ({ id: h.id, accepts: h.accepts })),
        // Full socket graph (transforms + kinds) for the 3D hangar preview / editor.
        sockets: ship.sockets,
        upgrades: {
          hull: trackLevel(req.userId!, ship.id, "hull"),
          engine: trackLevel(req.userId!, ship.id, "engine"),
          energy: trackLevel(req.userId!, ship.id, "energy"),
          heat: trackLevel(req.userId!, ship.id, "heat"),
        },
      }));
      res.json({ ships });
    }),
  );

  // POST /api/ships/buy { shipId } — spend credits to own a hull.
  // Declared before `/:shipId/upgrade` for readability only; the paths cannot
  // collide (that route needs a second segment).
  router.post(
    "/buy",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, buyShipBodySchema, req.body);
      if (!body) return;
      const configs = getConfigService();
      const ship = configs.get<ShipConfig>("ship", body.shipId);
      if (!ship) {
        sendError(res, 404, "unknown-ship", `unknown ship: ${body.shipId}`);
        return;
      }
      const profile = profilesRepo.byUser(req.userId!)!;
      // Idempotent: a second buy is the state the caller asked for, so it is a
      // success with an unchanged balance — never a second debit.
      if (ownedShipIds(configs, req.userId!).has(ship.id)) {
        res.json({ shipId: ship.id, credits: profile.credits });
        return;
      }
      const price = shipPrice(ship);
      // Atomic: guarded debit + grant in one transaction; the funds check IS the
      // conditional UPDATE, so concurrent buys cannot overspend.
      const credits = withTransaction(() => {
        if (!profilesRepo.tryDebit(req.userId!, price)) return null;
        ownedShipsRepo.grant(req.userId!, ship.id);
        return profilesRepo.byUser(req.userId!)!.credits;
      });
      if (credits === null) {
        sendError(res, 409, "insufficient-credits", `need ${price} credits, have ${profile.credits}`);
        return;
      }
      res.json({ shipId: ship.id, credits });
    }),
  );

  // POST /api/ships/:shipId/upgrade { track } — buy the next level of a track.
  router.post(
    "/:shipId/upgrade",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, upgradeBodySchema, req.body);
      if (!body) return;
      const configs = getConfigService();
      const shipId = req.params.shipId as string;
      const ship = configs.get<ShipConfig>("ship", shipId);
      if (!ship) {
        sendError(res, 404, "unknown-ship", `unknown ship: ${shipId}`);
        return;
      }
      const upgradeId = ship.upgradeTracks[body.track];
      const upgrade = configs.get<UpgradeConfig>("upgrade", upgradeId);
      if (!upgrade) {
        sendError(res, 500, "misconfigured", `ship ${shipId} references unknown upgrade ${upgradeId}`);
        return;
      }

      // DB level = number of config levels purchased (0 = base). The next
      // purchasable level is levels[current]; max level = levels.length.
      const current = trackLevel(req.userId!, shipId, body.track);
      const nextConfig = upgrade.levels[current];
      if (!nextConfig) {
        sendError(res, 400, "max-level", `${body.track} track is already at max level (${current})`);
        return;
      }
      const nextLevel = current + 1;

      const profile = profilesRepo.byUser(req.userId!)!;
      // Atomic: guarded debit + level bump in one transaction.
      const newCredits = withTransaction(() => {
        if (!profilesRepo.tryDebit(req.userId!, nextConfig.price)) return null;
        shipUpgradesRepo.setTrackLevel(req.userId!, shipId, body.track, nextLevel);
        return profilesRepo.byUser(req.userId!)!.credits;
      });
      if (newCredits === null) {
        sendError(res, 409, "insufficient-credits", `need ${nextConfig.price} credits, have ${profile.credits}`);
        return;
      }
      res.json({ shipId, track: body.track, level: nextLevel, credits: newCredits });
    }),
  );

  return router;
}
