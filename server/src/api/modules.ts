import { Router } from "express";
import { buyModuleBodySchema, type ModuleConfig } from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { withTransaction } from "../db/index.js";
import { ownedModulesRepo, profilesRepo } from "../db/repos.js";
import { asyncHandler, parseBody, requireAuth, sendError, type AuthedRequest } from "./http.js";

export function createModulesRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/modules — catalog + which the user owns.
  router.get(
    "/",
    asyncHandler(async (req: AuthedRequest, res) => {
      const owned = new Set(ownedModulesRepo.byUser(req.userId!).map((r) => r.module_id));
      const modules = getConfigService()
        .getAll<ModuleConfig>("module")
        .map((m) => ({
          id: m.id,
          name: m.name,
          family: m.family,
          level: m.level,
          price: m.price,
          requiresLevel: m.requiresLevel,
          owned: owned.has(m.id),
        }));
      res.json({ modules });
    }),
  );

  // POST /api/modules/buy { moduleId } — spend credits to own a module.
  router.post(
    "/buy",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, buyModuleBodySchema, req.body);
      if (!body) return;
      const mod = getConfigService().get<ModuleConfig>("module", body.moduleId);
      if (!mod) {
        sendError(res, 404, "unknown-module", `unknown module: ${body.moduleId}`);
        return;
      }
      const profile = profilesRepo.byUser(req.userId!)!;
      if (mod.requiresLevel > profile.level) {
        sendError(res, 403, "level-locked", `module requires level ${mod.requiresLevel} (you are level ${profile.level})`);
        return;
      }
      if (ownedModulesRepo.owns(req.userId!, mod.id)) {
        sendError(res, 409, "already-owned", "you already own this module");
        return;
      }
      // Atomic: debit (guarded) + grant in one transaction; funds check is the
      // conditional UPDATE, so concurrent buys cannot overspend.
      const result = withTransaction(() => {
        if (!profilesRepo.tryDebit(req.userId!, mod.price)) return null;
        ownedModulesRepo.grant(req.userId!, mod.id, 1);
        return profilesRepo.byUser(req.userId!)!.credits;
      });
      if (result === null) {
        sendError(res, 409, "insufficient-credits", `need ${mod.price} credits, have ${profile.credits}`);
        return;
      }
      res.json({ moduleId: mod.id, credits: result });
    }),
  );

  return router;
}
