import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { setGlobalLogLevel } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { createHttpApp } from "../httpApp.js";

setGlobalLogLevel("error");

let app: ReturnType<typeof createHttpApp>;

beforeAll(async () => {
  setConfigService(await loadContent());
  setDb(openDatabase(":memory:"));
  app = createHttpApp();
});

describe("auth API", () => {
  it("registers, returns a token pair + seeded profile", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "a@example.com", password: "password123", displayName: "Alpha" });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.profile).toMatchObject({ displayName: "Alpha", level: 1, isGuest: false });
    // Starter credits from progression config (250).
    expect(res.body.profile.credits).toBe(250);
  });

  it("rejects duplicate email and bad login, accepts good login", async () => {
    await request(app).post("/api/auth/register").send({ email: "b@example.com", password: "password123" });

    const dup = await request(app).post("/api/auth/register").send({ email: "b@example.com", password: "password123" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("email-taken");

    const bad = await request(app).post("/api/auth/login").send({ email: "b@example.com", password: "wrongpass1" });
    expect(bad.status).toBe(401);

    const good = await request(app).post("/api/auth/login").send({ email: "b@example.com", password: "password123" });
    expect(good.status).toBe(200);
    expect(good.body.accessToken).toBeTruthy();
  });

  it("creates a guest, restores it, and /me works with the token", async () => {
    const guest = await request(app).post("/api/auth/guest").send({ displayName: "client name is ignored" });
    expect(guest.status).toBe(201);
    expect(guest.body.guestToken).toBeTruthy();
    expect(guest.body.profile.isGuest).toBe(true);

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${guest.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.profile.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+(?:-\d{3,4})?$/);

    // Restore by durable guest token → same identity.
    const restored = await request(app).post("/api/auth/guest").send({ guestToken: guest.body.guestToken });
    expect(restored.status).toBe(200);
    expect(restored.body.profile.userId).toBe(guest.body.profile.userId);
    expect(restored.body.profile.displayName).toBe(guest.body.profile.displayName);
  });

  it("refreshes and rotates the refresh token", async () => {
    const guest = await request(app).post("/api/auth/guest").send({});
    const refreshed = await request(app).post("/api/auth/refresh").send({ refreshToken: guest.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    // Old refresh token is now invalid (rotated).
    const reuse = await request(app).post("/api/auth/refresh").send({ refreshToken: guest.body.refreshToken });
    expect(reuse.status).toBe(401);
  });

  it("register with a present-but-invalid bearer token → 401, not a new account (4)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ email: "inv@example.com", password: "password123" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid-token");
  });

  it("register with a full-account token cannot re-upgrade → 409", async () => {
    const reg = await request(app).post("/api/auth/register").send({ email: "full@example.com", password: "password123" });
    const res = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${reg.body.accessToken}`)
      .send({ email: "full2@example.com", password: "password123" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already-registered");
  });

  it("guest with a supplied-but-unknown token → 401 invalid-guest-token (6)", async () => {
    const res = await request(app).post("/api/auth/guest").send({ guestToken: "deadbeef-unknown" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid-guest-token");
  });

  it("upgrades a guest in place, keeping credits/level (progress) and revoking old sessions (5)", async () => {
    const guest = await request(app).post("/api/auth/guest").send({ displayName: "Upgrader" });
    const userId = guest.body.profile.userId as string;
    const startCredits = guest.body.profile.credits as number;

    const upgraded = await request(app)
      .post("/api/auth/register")
      .set("Authorization", `Bearer ${guest.body.accessToken}`)
      .send({ email: "up@example.com", password: "password123" });
    expect(upgraded.status).toBe(200);
    // Same user id → progress preserved.
    expect(upgraded.body.profile.userId).toBe(userId);
    expect(upgraded.body.profile.credits).toBe(startCredits);
    expect(upgraded.body.profile.isGuest).toBe(false);

    // Finding 5: the guest's OLD refresh session was revoked by the upgrade.
    const staleRefresh = await request(app).post("/api/auth/refresh").send({ refreshToken: guest.body.refreshToken });
    expect(staleRefresh.status).toBe(401);

    // Can now log in with the new credentials.
    const login = await request(app).post("/api/auth/login").send({ email: "up@example.com", password: "password123" });
    expect(login.status).toBe(200);
    expect(login.body.profile.userId).toBe(userId);
  });
});
