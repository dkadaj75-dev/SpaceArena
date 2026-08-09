import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import {
  guestBodySchema,
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { withTransaction } from "../db/index.js";
import { profilesRepo, sessionsRepo, usersRepo } from "../db/repos.js";
import { ensureStarterKit, seedNewUser } from "../db/seed.js";
import { asyncHandler, bearerToken, parseBody, requireAuth, sendError, type AuthedRequest } from "../api/http.js";
import { inventoryFor } from "../api/ownership.js";
import { hashPassword, verifyPassword } from "./password.js";
import { issueTokenPair, rotateRefreshToken, verifyAccessToken } from "./tokens.js";
import { generateGuestPilotName } from "./guestNames.js";

/** Public profile payload returned by /me and after auth. */
function profilePayload(userId: string): {
  userId: string;
  displayName: string;
  level: number;
  xp: number;
  credits: number;
  isGuest: boolean;
  role: "player" | "admin";
} | null {
  const profile = profilesRepo.byUser(userId);
  const user = usersRepo.byId(userId);
  if (!profile || !user) return null;
  return {
    userId,
    displayName: profile.display_name,
    level: profile.level,
    xp: profile.xp,
    credits: profile.credits,
    isGuest: user.guest_token !== null,
    // The role rides the profile so the client can GATE admin-only UI (the
    // Constellation entry) without probing an admin endpoint as a player and
    // spraying 403s into the console. The server stays authoritative on use.
    role: user.role,
  };
}

export function createAuthRouter(): Router {
  const router = Router();

  // POST /register — new account, or upgrade the guest named by the bearer token.
  router.post(
    "/register",
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = parseBody(res, registerBodySchema, req.body);
      if (!body) return;

      if (usersRepo.byEmail(body.email)) {
        sendError(res, 409, "email-taken", "an account with this email already exists");
        return;
      }
      const passHash = await hashPassword(body.password);

      // If a bearer token is present it MUST be a valid guest to upgrade in place.
      const token = bearerToken(req);
      if (token) {
        const bearerUserId = verifyAccessToken(token);
        if (!bearerUserId) {
          // Present-but-invalid/expired → 401 so the client refresh path retries
          // (never silently mint a fresh account, which would orphan progress).
          sendError(res, 401, "invalid-token", "authorization token is invalid or expired");
          return;
        }
        const guest = usersRepo.byId(bearerUserId);
        if (!guest || guest.guest_token === null) {
          sendError(res, 409, "already-registered", "this account is already registered");
          return;
        }
        // Upgrade + revoke ALL existing sessions atomically, then issue fresh pair.
        withTransaction(() => {
          usersRepo.upgradeGuest(guest.id, body.email, passHash);
          if (body.displayName) profilesRepo.setDisplayName(guest.id, body.displayName);
          sessionsRepo.deleteForUser(guest.id);
        });
        const pair = issueTokenPair(guest.id);
        res.status(200).json({ ...pair, profile: profilePayload(guest.id) });
        return;
      }

      // Fresh account.
      const userId = randomUUID();
      usersRepo.create({ id: userId, email: body.email, pass_hash: passHash, guest_token: null });
      seedNewUser(getConfigService(), userId, body.displayName ?? emailLocalPart(body.email));
      const pair = issueTokenPair(userId);
      res.status(201).json({ ...pair, profile: profilePayload(userId) });
    }),
  );

  // POST /dev-login — DEV ONLY: instant admin session so local testing can
  // skip the login screen while the real auth stack stays intact. The guard is
  // evaluated at router build time; production never mounts the route at all.
  // Client counterpart: AuthService.devLogin(), called from the DEV bootstrap
  // (opt out with ?login=1 or localStorage sa.devLogin="off").
  if (process.env.NODE_ENV !== "production") {
    router.post(
      "/dev-login",
      asyncHandler(async (_req, res) => {
        const email = "admin@spacearena.local";
        let user = usersRepo.byEmail(email);
        if (!user) {
          const userId = randomUUID();
          // Random throwaway password: dev-login never uses it, and a real one
          // can be set anytime via tools/create-admin.ts.
          const passHash = await hashPassword(randomBytes(24).toString("hex"));
          usersRepo.create({ id: userId, email, pass_hash: passHash, guest_token: null });
          seedNewUser(getConfigService(), userId, "Admin");
          user = usersRepo.byEmail(email);
        }
        if (!user) {
          sendError(res, 500, "dev-login-failed", "could not create the dev admin account");
          return;
        }
        usersRepo.setRole(user.id, "admin");
        ensureStarterKit(getConfigService(), user.id);
        const pair = issueTokenPair(user.id);
        res.json({ ...pair, profile: profilePayload(user.id) });
      }),
    );
  }

  // POST /login — email + password.
  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const body = parseBody(res, loginBodySchema, req.body);
      if (!body) return;
      const user = usersRepo.byEmail(body.email);
      if (!user || !user.pass_hash || !(await verifyPassword(user.pass_hash, body.password))) {
        sendError(res, 401, "invalid-credentials", "email or password is incorrect");
        return;
      }
      const pair = issueTokenPair(user.id);
      ensureStarterKit(getConfigService(), user.id);
      res.json({ ...pair, profile: profilePayload(user.id) });
    }),
  );

  // POST /guest — create (or restore) a guest identity.
  router.post(
    "/guest",
    asyncHandler(async (req, res) => {
      const body = parseBody(res, guestBodySchema, req.body ?? {});
      if (!body) return;

      // Restore an existing guest from its durable token.
      if (body.guestToken) {
        const existing = usersRepo.byGuestToken(body.guestToken);
        if (existing) {
          const pair = issueTokenPair(existing.id);
          ensureStarterKit(getConfigService(), existing.id);
          res.json({ ...pair, guestToken: body.guestToken, profile: profilePayload(existing.id) });
          return;
        }
        // Supplied but unknown → 401 (never mint a new guest for a bad token, which
        // would silently discard whatever progress the client believed it had).
        sendError(res, 401, "invalid-guest-token", "guest token is not recognized");
        return;
      }

      const userId = randomUUID();
      const guestToken = randomBytes(24).toString("hex");
      usersRepo.create({ id: userId, email: null, pass_hash: null, guest_token: guestToken });
      const displayName = generateGuestPilotName((name) => profilesRepo.displayNameExists(name));
      seedNewUser(getConfigService(), userId, displayName);
      const pair = issueTokenPair(userId);
      res.status(201).json({ ...pair, guestToken, profile: profilePayload(userId) });
    }),
  );

  // POST /refresh — rotate the refresh token.
  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      const body = parseBody(res, refreshBodySchema, req.body);
      if (!body) return;
      const rotated = rotateRefreshToken(body.refreshToken);
      if (!rotated) {
        sendError(res, 401, "invalid-refresh", "refresh token is invalid or expired");
        return;
      }
      const { userId, ...pair } = rotated;
      res.json({ ...pair, profile: profilePayload(userId) });
    }),
  );

  // GET /me — current profile + the whole inventory (hulls, modules, paints,
  // equipped paint per hull). ONE read: the Shop and the Hangar need all four
  // together, and a second endpoint could only return a second opinion.
  router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const configs = getConfigService();
      ensureStarterKit(configs, req.userId!);
      const payload = profilePayload(req.userId!);
      if (!payload) {
        sendError(res, 404, "not-found", "profile not found");
        return;
      }
      res.json({ profile: payload, inventory: inventoryFor(configs, req.userId!) });
    }),
  );

  return router;
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
