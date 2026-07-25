/**
 * Admin content-pack API — `/api/admin/content` (ROADMAP §11 6.7, criterion S6).
 *
 * Three verbs, and together they are the entire "new arena live without a
 * redeploy" story:
 *
 *   GET  /export    → the live pack as one JSON bundle
 *   POST /import    → validate a bundle, swap it in, reload — atomically
 *   POST /rollback  → put the previous pack back
 *
 * Everything here is admin-only (`users.role = 'admin'`), on a **separate, much
 * stricter rate limiter** than the game API, and behind its own body-size cap.
 * The cap is why this router is mounted before the global 64 kb `express.json`
 * in httpApp.ts: a real pack is ~120 kb, so it needs its own parser, and
 * body-parser skips a request another parser already consumed.
 *
 * The import endpoint deliberately does no validation of its own — it hands the
 * body to {@link ContentPackStore.importBundle}, which hands it to
 * ConfigService. One gate, shared by CI (`validate:content`), server boot, and
 * this endpoint.
 */
import express, { Router } from "express";
import { DEFAULT_IMPORT_MAX_BYTES, PROTOCOL_VERSION } from "@space-arena/shared";
import { getPackStore } from "../content/packStore.js";
import { createRateLimiter } from "./rateLimit.js";
import { asyncHandler, requireAdmin, sendError, type AuthedRequest } from "./http.js";

/**
 * Two buckets, because the routes are not alike.
 *
 * `/export` and `/status` are cheap reads; their limiter exists mainly so an
 * unauthenticated flood cannot hammer the token verify + role lookup. `/import`
 * and `/rollback` swap directories on disk and reload the whole registry — the
 * normal rate for those is "a few a day", so they get a second, far stricter
 * bucket on top: 6 in a burst, refilling one per 10 s.
 */
export const ADMIN_RATE_CAPACITY = 20;
export const ADMIN_RATE_REFILL_PER_SEC = 1;
export const ADMIN_MUTATE_RATE_CAPACITY = 6;
export const ADMIN_MUTATE_RATE_REFILL_PER_SEC = 0.1;

/** Body cap for `POST /import`, overridable per deployment. */
export function importMaxBytes(): number {
  const raw = process.env.CONTENT_IMPORT_MAX_BYTES;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_IMPORT_MAX_BYTES;
}

export function createAdminContentRouter(): Router {
  const router = Router();

  router.use(createRateLimiter(ADMIN_RATE_CAPACITY, ADMIN_RATE_REFILL_PER_SEC));
  router.use(requireAdmin);

  /** Extra budget for the two routes that actually touch the filesystem. */
  const mutateLimiter = createRateLimiter(ADMIN_MUTATE_RATE_CAPACITY, ADMIN_MUTATE_RATE_REFILL_PER_SEC);

  // GET /export — the active pack as a downloadable bundle.
  router.get(
    "/export",
    asyncHandler(async (_req: AuthedRequest, res) => {
      const bundle = await getPackStore().exportBundle();
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${sanitizeFilename(bundle.packId)}-v${bundle.packVersion}.pack.json"`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(bundle);
    }),
  );

  // GET /status — what is live right now, and whether a rollback is available.
  router.get(
    "/status",
    asyncHandler(async (_req: AuthedRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ protocolVersion: PROTOCOL_VERSION, pack: await getPackStore().packInfo() });
    }),
  );

  // POST /import — the whole point of 6.7.
  router.post(
    "/import",
    mutateLimiter,
    express.json({ limit: importMaxBytes() }),
    asyncHandler(async (req: AuthedRequest, res) => {
      const result = await getPackStore().importBundle(req.body);
      if (!result.ok) {
        // 422, not 400: the request was well-formed JSON that the server
        // understood — the *content* is what failed. The standard error envelope
        // carries a summary; `errors` alongside it is the same
        // `{ file, path, message }` list the editors and `validate:content` print,
        // so an operator can paste it straight back to whoever authored the pack.
        res.status(422).json({
          error: {
            code: `pack-${result.stage}-failed`,
            message: `content pack rejected at ${result.stage} (${result.errors.length} problem(s)) — nothing was changed`,
          },
          stage: result.stage,
          errors: result.errors,
        });
        return;
      }
      res.json({
        ok: true,
        packId: result.packId,
        packVersion: result.packVersion,
        sourceHash: result.sourceHash,
        files: result.files,
        counts: result.counts,
        rollbackAvailable: result.rollbackAvailable,
      });
    }),
  );

  // POST /rollback — restore the pack the last import replaced.
  router.post(
    "/rollback",
    mutateLimiter,
    asyncHandler(async (_req: AuthedRequest, res) => {
      const result = await getPackStore().rollback();
      if (!result.ok) {
        res.status(409).json({
          error: { code: "rollback-failed", message: result.errors[0]?.message ?? "rollback failed" },
          errors: result.errors,
        });
        return;
      }
      res.json({
        ok: true,
        packId: result.packId,
        packVersion: result.packVersion,
        sourceHash: result.sourceHash,
        files: result.files,
        rollbackAvailable: result.rollbackAvailable,
      });
    }),
  );

  // body-parser signals an over-cap body by throwing `entity.too.large` with
  // status 413. Without this, Express's default handler answers with an HTML
  // page; every other error on this API is the JSON envelope, so this one is too.
  router.use(
    (
      err: NodeJS.ErrnoException & { type?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      if (err?.type === "entity.too.large") {
        sendError(
          res,
          413,
          "pack-too-large",
          `content pack exceeds the ${importMaxBytes()} byte import limit (raise CONTENT_IMPORT_MAX_BYTES if this is legitimate)`,
        );
        return;
      }
      if (err?.type === "entity.parse.failed") {
        sendError(res, 400, "invalid-json", "request body is not valid JSON");
        return;
      }
      next(err);
    },
  );

  return router;
}

function sanitizeFilename(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "content";
}
