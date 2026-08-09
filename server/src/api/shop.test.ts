import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { setGlobalLogLevel, type ApiInventory, type ShipConfig } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, runMigrations, setDb, getDb } from "../db/index.js";
import { ownedShipsRepo, profilesRepo, selectedCosmeticsRepo } from "../db/repos.js";
import { createHttpApp } from "../httpApp.js";

setGlobalLogLevel("error");

let app: ReturnType<typeof createHttpApp>;

async function newUser(email: string): Promise<{ auth: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "password123", displayName: `T-${email.split("@")[0]}` });
  return { auth: `Bearer ${res.body.accessToken}`, userId: res.body.profile.userId };
}

async function inventory(auth: string): Promise<ApiInventory> {
  const res = await request(app).get("/api/auth/me").set("Authorization", auth);
  expect(res.status).toBe(200);
  return res.body.inventory as ApiInventory;
}

beforeAll(async () => {
  setConfigService(await loadContent());
  setDb(openDatabase(":memory:"));
  app = createHttpApp();
});

describe("shop migration", () => {
  it("is idempotent — a second run applies nothing and keeps the rows", () => {
    const db = getDb();
    const before = db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
    runMigrations(db);
    runMigrations(db);
    const after = db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
    expect(after.n).toBe(before.n);
    for (const table of ["owned_ships", "owned_cosmetics", "selected_cosmetics"]) {
      expect(() => db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()).not.toThrow();
    }
  });
});

describe("inventory read (GET /api/auth/me)", () => {
  it("derives the starter grants instead of seeding them", async () => {
    const { auth, userId } = await newUser("inv@example.com");
    const inv = await inventory(auth);

    expect(inv.ships).toEqual(["ship.interceptor"]);
    expect(ownedShipsRepo.byUser(userId)).toHaveLength(0); // derived, never a row
    expect(inv.cosmetics).toEqual(["cosmetic.paint-interceptor-standard"]);
    expect(inv.modules).toContain("module.laser-mk1");
    expect(inv.modules).not.toContain("module.laser-mk2"); // priced: must be bought
    expect(inv.selections).toEqual({ "ship.interceptor": "cosmetic.paint-interceptor-standard" });
  });

  it("requires auth", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });

  it("sanitizes a stored retired cosmetic id to the owned hull's base paint", async () => {
    const { auth, userId } = await newUser("retiredpaint@example.com");
    selectedCosmeticsRepo.set(userId, "ship.interceptor", "cosmetic.paint-standard");
    expect((await inventory(auth)).selections["ship.interceptor"]).toBe("cosmetic.paint-interceptor-standard");
  });
});

describe("POST /api/ships/buy", () => {
  it("buys a hull, debits its price, and is idempotent on a rebuy", async () => {
    const { auth, userId } = await newUser("shipbuy@example.com");
    const before = profilesRepo.byUser(userId)!.credits;

    const buy = await request(app).post("/api/ships/buy").set("Authorization", auth).send({ shipId: "ship.brawler" });
    expect(buy.status).toBe(200);
    expect(buy.body).toEqual({ shipId: "ship.brawler", credits: before }); // every hull ships free today
    expect((await inventory(auth)).ships).toContain("ship.brawler");
    expect((await inventory(auth)).cosmetics).toContain("cosmetic.paint-brawler-standard");

    const again = await request(app).post("/api/ships/buy").set("Authorization", auth).send({ shipId: "ship.brawler" });
    expect(again.status).toBe(200);
    expect(profilesRepo.byUser(userId)!.credits).toBe(before); // no second debit
    expect(ownedShipsRepo.byUser(userId).filter((r) => r.ship_id === "ship.brawler")).toHaveLength(1);
  });

  it("rejects an unknown hull", async () => {
    const { auth } = await newUser("shipbuy404@example.com");
    const res = await request(app).post("/api/ships/buy").set("Authorization", auth).send({ shipId: "ship.nope" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown-ship");
  });

  it("rejects a hull the pilot cannot afford, granting nothing", async () => {
    const { auth, userId } = await newUser("shipbroke@example.com");
    profilesRepo.setProgress(userId, 1, 0, 0);
    // Price the hull through content: the buy step is real, only the cost is not.
    const configs = (await import("../configService.js")).getConfigService();
    const brawler = configs.get<ShipConfig>("ship", "ship.brawler")!;
    const replaced = configs.replace({ ...brawler, price: 500 });
    expect(replaced.ok, JSON.stringify(replaced.errors)).toBe(true);

    const res = await request(app).post("/api/ships/buy").set("Authorization", auth).send({ shipId: "ship.brawler" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("insufficient-credits");
    expect((await inventory(auth)).ships).not.toContain("ship.brawler");

    configs.replace(brawler); // restore the shipped (free) hull
  });
});

describe("POST /api/cosmetics/buy", () => {
  it("buys a paint and is idempotent on a rebuy", async () => {
    const { auth, userId } = await newUser("paintbuy@example.com");
    const before = profilesRepo.byUser(userId)!.credits;

    const buy = await request(app)
      .post("/api/cosmetics/buy")
      .set("Authorization", auth)
      .send({ cosmeticId: "cosmetic.paint-interceptor-crimson" });
    expect(buy.status).toBe(200);
    expect(buy.body).toEqual({ cosmeticId: "cosmetic.paint-interceptor-crimson", credits: before });
    expect((await inventory(auth)).cosmetics).toContain("cosmetic.paint-interceptor-crimson");

    const again = await request(app)
      .post("/api/cosmetics/buy")
      .set("Authorization", auth)
      .send({ cosmeticId: "cosmetic.paint-interceptor-crimson" });
    expect(again.status).toBe(200);
    expect(profilesRepo.byUser(userId)!.credits).toBe(before);
  });

  it("rejects an unknown paint", async () => {
    const { auth } = await newUser("paint404@example.com");
    const res = await request(app)
      .post("/api/cosmetics/buy")
      .set("Authorization", auth)
      .send({ cosmeticId: "cosmetic.paint-nope" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown-cosmetic");
  });
});

describe("POST /api/cosmetics/select", () => {
  it("equips an owned, applicable paint and reports it in the one inventory read", async () => {
    const { auth } = await newUser("equip@example.com");
    await request(app).post("/api/cosmetics/buy").set("Authorization", auth).send({ cosmeticId: "cosmetic.paint-interceptor-crimson" });

    const res = await request(app)
      .post("/api/cosmetics/select")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-interceptor-crimson" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-interceptor-crimson" });
    expect((await inventory(auth)).selections).toEqual({ "ship.interceptor": "cosmetic.paint-interceptor-crimson" });
  });

  it("rejects a paint the pilot does not own", async () => {
    const { auth, userId } = await newUser("equipunowned@example.com");
    const res = await request(app)
      .post("/api/cosmetics/select")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-interceptor-violet" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not-owned");
    expect(selectedCosmeticsRepo.get(userId, "ship.interceptor")).toBeUndefined();
  });

  it("rejects a paint that does not apply to the hull, even when owned", async () => {
    const { auth } = await newUser("equipwronghull@example.com");
    await request(app)
      .post("/api/cosmetics/buy")
      .set("Authorization", auth)
      .send({ cosmeticId: "cosmetic.paint-brawler-ironclad" });
    const res = await request(app)
      .post("/api/cosmetics/select")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-brawler-ironclad" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("not-applicable");
  });

  it("rejects equipping onto a hull the pilot does not own", async () => {
    const { auth } = await newUser("equipunownedship@example.com");
    await request(app).post("/api/cosmetics/buy").set("Authorization", auth).send({ cosmeticId: "cosmetic.paint-support-jade" });
    const res = await request(app)
      .post("/api/cosmetics/select")
      .set("Authorization", auth)
      .send({ shipId: "ship.support", cosmeticId: "cosmetic.paint-support-jade" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not-owned");
  });

  it("clears back to the hull's derived base paint", async () => {
    const { auth, userId } = await newUser("unequip@example.com");
    await request(app).post("/api/cosmetics/buy").set("Authorization", auth).send({ cosmeticId: "cosmetic.paint-interceptor-arctic" });
    await request(app)
      .post("/api/cosmetics/select")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-interceptor-arctic" });

    const cleared = await request(app)
      .post("/api/cosmetics/select")
      .set("Authorization", auth)
      .send({ shipId: "ship.interceptor", cosmeticId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.cosmeticId).toBeNull();
    expect(selectedCosmeticsRepo.get(userId, "ship.interceptor")).toBeUndefined();

    expect((await inventory(auth)).selections["ship.interceptor"]).toBe("cosmetic.paint-interceptor-standard");
  });

  it("requires auth", async () => {
    expect((await request(app).post("/api/cosmetics/buy").send({ cosmeticId: "cosmetic.paint-jade" })).status).toBe(401);
  });
});
