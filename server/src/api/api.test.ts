import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { setGlobalLogLevel } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { profilesRepo } from "../db/repos.js";
import { createHttpApp } from "../httpApp.js";

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

describe("fittings API", () => {
  it("accepts a valid fit and rejects wrong-family / non-owned modules", async () => {
    const { auth } = await newUser("fit@example.com");

    // Valid: hardpoint 0 accepts laser; laser-mk1 is a starter (owned, level 1).
    const ok = await request(app)
      .post("/api/fittings")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", name: "Laser only", hardpointMap: { "0": "module.laser-mk1" } });
    expect(ok.status).toBe(201);
    expect(ok.body.fitting.id).toBeTruthy();

    // Wrong family: hardpoint 0 accepts laser/kinetic, not boost.
    const wrongFamily = await request(app)
      .post("/api/fittings")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", name: "Bad", hardpointMap: { "0": "module.boost-mk1" } });
    expect(wrongFamily.status).toBe(400);
    expect(wrongFamily.body.error.code).toBe("family-mismatch");

    // Not owned: shield-mk1 fits hardpoint 2 by family but user does not own it.
    const notOwned = await request(app)
      .post("/api/fittings")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", name: "Bad2", hardpointMap: { "2": "module.shield-mk1" } });
    expect(notOwned.status).toBe(400);
    expect(notOwned.body.error.code).toBe("not-owned");
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/fittings");
    expect(res.status).toBe(401);
  });
});

describe("modules + upgrades API", () => {
  it("buys a module, deducting credits", async () => {
    const { auth, userId } = await newUser("buy@example.com");
    const before = profilesRepo.byUser(userId)!.credits; // 250

    // boost-mk1 costs 100, requiresLevel 1.
    const buy = await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.boost-mk1" });
    expect(buy.status).toBe(200);
    expect(buy.body.credits).toBe(before - 100);

    // Buying again → already owned.
    const again = await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.boost-mk1" });
    expect(again.status).toBe(409);
  });

  it("rejects a module buy with insufficient credits (409, atomic debit)", async () => {
    const { auth, userId } = await newUser("brokebuy@example.com");
    // Drain the starter credits so nothing is left.
    profilesRepo.addCredits(userId, -profilesRepo.byUser(userId)!.credits);
    const res = await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.boost-mk1" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("insufficient-credits");
    // Nothing was granted (debit + grant are atomic).
    const list = await request(app).get("/api/modules").set("Authorization", auth);
    const boost = (list.body.modules as Array<{ id: string; owned: boolean }>).find((m) => m.id === "module.boost-mk1")!;
    expect(boost.owned).toBe(false);
  });

  it("upgrades a ship track, deducting credits and capping at max level", async () => {
    const { auth, userId } = await newUser("upg@example.com");
    // Give plenty of credits for the full hull track (0 + 200 + 500).
    profilesRepo.addCredits(userId, 1000);

    // hull-std has 3 levels (prices 0, 200, 500).
    const l1 = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "hull" });
    expect(l1.status).toBe(200);
    expect(l1.body.level).toBe(1);

    const l2 = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "hull" });
    expect(l2.body.level).toBe(2);
    const l3 = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "hull" });
    expect(l3.body.level).toBe(3);

    // Fourth purchase → max-level rejection.
    const l4 = await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "hull" });
    expect(l4.status).toBe(400);
    expect(l4.body.error.code).toBe("max-level");

    // GET /api/ships reflects the purchased level.
    const ships = await request(app).get("/api/ships").set("Authorization", auth);
    const interceptor = (ships.body.ships as Array<{ id: string; upgrades: { hull: number } }>).find((s) => s.id === "ship.interceptor")!;
    expect(interceptor.upgrades.hull).toBe(3);
  });

  it("rejects an upgrade with insufficient credits", async () => {
    const { auth } = await newUser("poor@example.com");
    // Advance to level 2 price (200) after a free level-1 buy; drain credits first.
    await request(app).post("/api/ships/ship.interceptor/upgrade").set("Authorization", auth).send({ track: "engine" });
    // Now level-2 costs 200 but a fresh user has 250; spend it via a module buy (missile 150 + shield 150 unavailable) — buy boost (100) twice not allowed.
    // Instead directly check: buy two modules to drop below 200.
    await request(app).post("/api/modules/buy").set("Authorization", auth).send({ moduleId: "module.missile-mk1" }); // 150 → 100 left
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
      bounds: { shape: "circle", radius: 60 },
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
