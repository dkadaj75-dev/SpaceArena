import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { loadoutFittingId, setGlobalLogLevel } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { clientMetricsRepo, profilesRepo } from "../db/repos.js";
import { createHttpApp } from "../httpApp.js";
import { MAX_REPORTS_PER_SESSION } from "./telemetry.js";

setGlobalLogLevel("error");

let app: ReturnType<typeof createHttpApp>;

/** Register a fresh user and return its auth header + userId. */
async function newUser(email: string): Promise<{ auth: string; userId: string }> {
  const res = await request(app).post("/api/auth/register").send({ email, password: "password123", displayName: "Tester" });
  return { auth: `Bearer ${res.body.accessToken}`, userId: res.body.profile.userId };
}

beforeAll(async () => {
  setConfigService(await loadContent());
  setDb(openDatabase(":memory:"));
  app = createHttpApp();
});

/**
 * One loadout per hull, addressed by SHIP id (owner 2026-08-22). The row's own
 * id is derived server-side from (user, ship), so a client neither holds one nor
 * can name someone else's.
 */
describe("loadouts API", () => {
  it("upserts a hull's loadout in place, and rejects wrong-family / non-owned modules", async () => {
    const { auth, userId } = await newUser("fit@example.com");

    // A fresh account already HAS a loadout per hull (seeded from the stock fit),
    // so there is never a "create" — only writes to the row that exists.
    const before = await request(app).get("/api/fittings").set("Authorization", auth);
    expect(before.status).toBe(200);
    const forShip = (body: { fittings: { ship_id: string; id: string }[] }, shipId: string) =>
      body.fittings.filter((f) => f.ship_id === shipId);
    expect(forShip(before.body, "ship.interceptor")).toHaveLength(1);
    const rowId = forShip(before.body, "ship.interceptor")[0]!.id;
    expect(rowId).toBe(loadoutFittingId(userId, "ship.interceptor"));

    // Valid: hardpoint 0 accepts laser; laser-mk1 is a starter (owned, level 1).
    const ok = await request(app)
      .put("/api/fittings/ship.interceptor")
      .set("Authorization", auth)
      .send({ hardpointMap: { "0": "module.laser-mk1" } });
    expect(ok.status).toBe(200);
    expect(ok.body.fitting.id).toBe(rowId);
    expect(ok.body.fitting.hardpointMap).toEqual({ "0": "module.laser-mk1" });

    // A second write REPLACES it rather than adding a row: a hull has one fit.
    const again = await request(app)
      .put("/api/fittings/ship.interceptor")
      .set("Authorization", auth)
      .send({ hardpointMap: {} });
    expect(again.status).toBe(200);
    const after = await request(app).get("/api/fittings").set("Authorization", auth);
    expect(forShip(after.body, "ship.interceptor")).toHaveLength(1);
    expect(forShip(after.body, "ship.interceptor")[0]).toMatchObject({ id: rowId, hardpointMap: {} });

    // Wrong family: every hardpoint takes a weapon, a shield or a support
    // module since 2026-08-22, and nothing else — so the passive utilities are
    // what a hardpoint refuses now. The module is a pre-owned starter, so only
    // the family can be what fails here.
    const wrongFamily = await request(app)
      .put("/api/fittings/ship.interceptor")
      .set("Authorization", auth)
      .send({ hardpointMap: { "0": "module.utility-capacitor-battery" } });
    expect(wrongFamily.status).toBe(400);
    expect(wrongFamily.body.error.code).toBe("family-mismatch");

    // Not owned: shield-mk2 fits hardpoint 1 by family but is a priced module the
    // fresh user does not own (mk1 modules are the free, pre-owned starter kit).
    const notOwned = await request(app)
      .put("/api/fittings/ship.interceptor")
      .set("Authorization", auth)
      .send({ hardpointMap: { "1": "module.shield-mk2" } });
    expect(notOwned.status).toBe(400);
    expect(notOwned.body.error.code).toBe("not-owned");

    // A rejected write changes nothing.
    const unchanged = await request(app).get("/api/fittings").set("Authorization", auth);
    expect(forShip(unchanged.body, "ship.interceptor")[0]).toMatchObject({ hardpointMap: {} });
  });

  it("404s a path that is not a ship — an old client's stale row id lands here", async () => {
    const { auth } = await newUser("stalefit@example.com");
    const res = await request(app)
      .put("/api/fittings/8f0c6c2e-0000-4000-8000-000000000000")
      .set("Authorization", auth)
      .send({ hardpointMap: {} });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not-found");
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/fittings");
    expect(res.status).toBe(401);
  });
});

describe("modules + upgrades API", () => {
  it("buys a module, deducting credits", async () => {
    const { auth, userId } = await newUser("buy@example.com");
    profilesRepo.addCredits(userId, 1000); // afford a priced mk2
    const before = profilesRepo.byUser(userId)!.credits;

    // laser-mk2 costs 350, requiresLevel 2 (mk1 variants are free/pre-owned).
    profilesRepo.setProgress(userId, 2, 0, before);
    const buy = await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.laser-mk2" });
    expect(buy.status).toBe(200);
    expect(buy.body.credits).toBe(before - 350);

    // Buying again → already owned.
    const again = await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.laser-mk2" });
    expect(again.status).toBe(409);
  });

  it("rejects a module buy with insufficient credits (409, atomic debit)", async () => {
    const { auth, userId } = await newUser("brokebuy@example.com");
    // Level 2 so the gate passes; drain the starter credits so nothing is left.
    profilesRepo.setProgress(userId, 2, 0, 0);
    const res = await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.laser-mk2" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("insufficient-credits");
    // Nothing was granted (debit + grant are atomic).
    const list = await request(app).get("/api/modules").set("Authorization", auth);
    const priced = (list.body.modules as Array<{ id: string; owned: boolean }>).find((m) => m.id === "module.laser-mk2")!;
    expect(priced.owned).toBe(false);
  });

  it("upgrades a ship track, deducting credits and capping at max level", async () => {
    const { auth, userId } = await newUser("upg@example.com");
    // Give plenty of credits for the full hull track (0 + 200 + 500 + 900 + 1400).
    profilesRepo.addCredits(userId, 4000);

    // hull-std has 5 levels (prices 0, 200, 500, 900, 1400); buy each in order.
    for (let expected = 1; expected <= 5; expected++) {
      const res = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "hull" });
      expect(res.status).toBe(200);
      expect(res.body.level).toBe(expected);
    }

    // Sixth purchase → max-level rejection.
    const past = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "hull" });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe("max-level");

    // GET /api/ships reflects the purchased level.
    const ships = await request(app).get("/api/ships").set("Authorization", auth);
    const interceptor = (ships.body.ships as Array<{ id: string; upgrades: { hull: number } }>).find((s) => s.id === "ship.interceptor")!;
    expect(interceptor.upgrades.hull).toBe(5);
  });

  it("rejects an upgrade with insufficient credits", async () => {
    const { auth, userId } = await newUser("poor@example.com");
    // Free level-1 engine buy, then set the balance below the level-2 price (200).
    await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "engine" });
    profilesRepo.setProgress(userId, 1, 0, 150);
    const broke = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "engine" });
    expect(broke.status).toBe(409);
    expect(broke.body.error.code).toBe("insufficient-credits");
  });
});

describe("user configs API", () => {
  it("forces the user namespace and validates the config", async () => {
    const { auth, userId } = await newUser("cfg@example.com");
    const arena = {
      id: "arena.my-custom",
      type: "arena",
      version: 1,
      name: "Mine",
      bounds: { shape: "sphere", radius: 60 },
      spawnPoints: [{ id: "sp1", team: 0, position: { x: 0, z: 0 }, heading: 0 }],
      asteroidPlacements: [],
    };
    const res = await request(app).post("/api/configs").set("Authorization", auth).send({ json: arena });
    expect(res.status).toBe(201);
    const prefix = userId.replace(/-/g, "");
    expect(res.body.config.id).toBe(`user.${prefix}-my-custom`);
    expect(res.body.config.type).toBe("arena");

    const list = await request(app).get("/api/configs").set("Authorization", auth);
    expect(list.body.configs.length).toBe(1);
  });

  it("rejects an invalid config", async () => {
    const { auth } = await newUser("cfg2@example.com");
    const res = await request(app).post("/api/configs").set("Authorization", auth).send({ json: { type: "arena", name: "broken" } });
    expect(res.status).toBe(400);
  });
});

describe("telemetry API (6.8)", () => {
  const body = {
    sessionHash: "0123456789abcdef0123456789abcdef",
    fpsBucket: "45-60",
    deviceClass: "desktop",
    qualityTier: "high",
  };

  it("accepts an anonymous report with no auth and stores it", async () => {
    const res = await request(app).post("/api/telemetry/client").send(body);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    const rows = clientMetricsRepo.since(0).filter((r) => r.session_hash === body.sessionHash);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fps_bucket: "45-60", device_class: "desktop", quality_tier: "high" });
    // Privacy: the stored row must carry nothing that identifies a user.
    expect(Object.keys(rows[0]!)).toEqual(["id", "session_hash", "fps_bucket", "device_class", "quality_tier", "created_at"]);
  });

  it("rejects a malformed body", async () => {
    const bad = await request(app).post("/api/telemetry/client").send({ ...body, fpsBucket: "1000+" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid-body");

    const shortHash = await request(app).post("/api/telemetry/client").send({ ...body, sessionHash: "abc" });
    expect(shortHash.status).toBe(400);
  });

  it("rejects a body carrying an extra identifier field", async () => {
    const res = await request(app)
      .post("/api/telemetry/client")
      .send({ ...body, sessionHash: "1111111111111111111111111111aaaa", userId: "u-1" });
    expect(res.status).toBe(400);
  });

  it("caps how many reports one session may file", async () => {
    const sessionHash = "abcdef0123456789abcdef0123456789";
    const now = Date.now();
    for (let i = 0; i < MAX_REPORTS_PER_SESSION; i++) {
      clientMetricsRepo.create({
        id: `cap-${i}`,
        session_hash: sessionHash,
        fps_bucket: "60+",
        device_class: "desktop",
        quality_tier: "high",
        created_at: now,
      });
    }
    const res = await request(app).post("/api/telemetry/client").send({ ...body, sessionHash });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate-limited");
  });
});
