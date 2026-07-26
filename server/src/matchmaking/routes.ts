import { Router } from "express";
import { z } from "zod";
import { profilesRepo } from "../db/repos.js";
import { parseBody, requireAuth, sendError, type AuthedRequest } from "../api/http.js";
import { MatchmakingQueue } from "./MatchmakingQueue.js";

const enqueueSchema = z.object({
  mode: z.literal("duel-1v1"),
  shipId: z.string().min(1).max(100).optional(),
  fittingId: z.string().min(1).max(100).optional(),
});

export function createMatchmakingRouter(queue: MatchmakingQueue): Router {
  const router = Router();
  router.use(requireAuth);

  router.post("/enqueue", async (req: AuthedRequest, res) => {
    const body = parseBody(res, enqueueSchema, req.body ?? {});
    if (!body) return;
    const profile = profilesRepo.byUser(req.userId!);
    if (!profile) {
      sendError(res, 404, "profile-not-found", "player profile not found");
      return;
    }
    try {
      const status = await queue.enqueue({
        playerKey: req.userId!,
        displayName: profile.display_name,
        elo: 1000,
        mode: body.mode,
        joinOptions: { shipId: body.shipId, fittingId: body.fittingId },
      });
      res.status(202).json(status);
    } catch {
      sendError(res, 503, "matchmaking-unavailable", "could not reserve a duel room");
    }
  });

  router.get("/status", async (req: AuthedRequest, res) => {
    res.json(await queue.heartbeat(req.userId!));
  });

  router.delete("/", async (req: AuthedRequest, res) => {
    await queue.cancel(req.userId!);
    res.json({ state: "cancelled" });
  });

  return router;
}
