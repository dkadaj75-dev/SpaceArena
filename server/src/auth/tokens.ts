import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { createLogger } from "@space-arena/shared";
import { sessionsRepo } from "../db/repos.js";

const log = createLogger("Auth");

/** Access-token TTL (15 min) and refresh-token TTL (7 days), in seconds. */
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 7 * 24 * 60 * 60;

let cachedSecret: string | null = null;

/**
 * JWT signing secret from env. Required in production: a missing/empty
 * JWT_SECRET when NODE_ENV==='production' is a hard startup failure. Outside
 * production a dev fallback is used with a one-time boot warning.
 */
export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim() !== "") {
    cachedSecret = fromEnv;
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  } else {
    cachedSecret = "dev-insecure-secret-change-me";
    log.warn("JWT_SECRET not set — using insecure dev fallback. Set JWT_SECRET in production.");
  }
  return cachedSecret;
}

export interface AccessClaims {
  sub: string; // userId
}

/** Sign a short-lived access token for a user. */
export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, getJwtSecret(), { expiresIn: ACCESS_TTL_S });
}

/** Verify an access token; returns the userId or null if invalid/expired. */
export function verifyAccessToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    return typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Issue a new access+refresh pair for a user. The refresh token is opaque
 * (`sessionId.secret`); only `sha256(secret)` is persisted, so a DB leak cannot
 * reconstruct a usable token.
 */
export function issueTokenPair(userId: string): TokenPair {
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  sessionsRepo.create({
    id: sessionId,
    user_id: userId,
    refresh_hash: sha256(secret),
    expires_at: Date.now() + REFRESH_TTL_S * 1000,
  });
  return {
    accessToken: signAccessToken(userId),
    refreshToken: `${sessionId}.${secret}`,
    expiresIn: ACCESS_TTL_S,
  };
}

/**
 * Validate a refresh token and rotate it: the old session is deleted and a fresh
 * pair issued. Returns the new pair + userId, or null if the token is unknown,
 * expired, or malformed.
 */
export function rotateRefreshToken(refreshToken: string): (TokenPair & { userId: string }) | null {
  const dot = refreshToken.indexOf(".");
  if (dot <= 0) return null;
  const sessionId = refreshToken.slice(0, dot);
  const secret = refreshToken.slice(dot + 1);

  const session = sessionsRepo.byId(sessionId);
  if (!session) return null;
  if (session.expires_at < Date.now() || session.refresh_hash !== sha256(secret)) {
    sessionsRepo.delete(sessionId);
    return null;
  }
  sessionsRepo.delete(sessionId);
  const pair = issueTokenPair(session.user_id);
  return { ...pair, userId: session.user_id };
}
