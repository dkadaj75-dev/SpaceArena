import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { verifyAccessToken } from "../auth/tokens.js";

/** Express request augmented with the authenticated userId (set by requireAuth). */
export interface AuthedRequest extends Request {
  userId?: string;
}

/** Send a consistent error envelope: `{ error: { code, message } }`. */
export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Extract a Bearer token from the Authorization header, if present. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

/** Middleware: require a valid access token; sets req.userId or 401s. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (!token) {
    sendError(res, 401, "unauthorized", "missing bearer token");
    return;
  }
  const userId = verifyAccessToken(token);
  if (!userId) {
    sendError(res, 401, "unauthorized", "invalid or expired token");
    return;
  }
  req.userId = userId;
  next();
}

/**
 * Validate `req.body` against a Zod schema, returning the parsed value or
 * responding 400 and returning null. Callers should `if (!data) return;`.
 */
export function parseBody<T>(res: Response, schema: z.ZodType<T>, body: unknown): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    sendError(res, 400, "invalid-body", `${path ? path + ": " : ""}${first?.message ?? "invalid request body"}`);
    return null;
  }
  return result.data;
}

/** Wrap an async route handler so rejected promises become 500s, not crashes. */
export function asyncHandler(
  fn: (req: AuthedRequest, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req as AuthedRequest, res).catch(next);
  };
}
