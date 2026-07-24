import type { NextFunction, Request, Response } from "express";
import { sendError } from "./http.js";

/** Token-bucket tuning constants (per client IP). */
export const RATE_CAPACITY = 30; // max burst
export const RATE_REFILL_PER_SEC = 10; // sustained rate
/** Buckets idle longer than this are evicted to bound memory. */
const IDLE_EVICT_MS = 5 * 60 * 1000;

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * Simple in-memory per-IP token-bucket limiter for /api/*. Not distributed —
 * fine for the single-container MVP. Returns 429 with the standard error
 * envelope when a client exhausts its bucket.
 */
export function createRateLimiter(
  capacity = RATE_CAPACITY,
  refillPerSec = RATE_REFILL_PER_SEC,
): (req: Request, res: Response, next: NextFunction) => void {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";

    // Opportunistic eviction to keep the map bounded.
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) if (now - b.last > IDLE_EVICT_MS) buckets.delete(k);
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, last: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = (now - bucket.last) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
      bucket.last = now;
    }

    if (bucket.tokens < 1) {
      sendError(res, 429, "rate-limited", "too many requests, slow down");
      return;
    }
    bucket.tokens -= 1;
    next();
  };
}
