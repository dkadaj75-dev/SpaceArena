import { beforeAll, describe, expect, it } from "vitest";
import { loadoutFittingId, setGlobalLogLevel, hardpointsOf, type ConfigService, type ShipConfig } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { fittingsRepo, ownedModulesRepo, profilesRepo, usersRepo } from "./repos.js";
import { ensureImplicitLoadouts, seedNewUser } from "./seed.js";
import { validateFitting } from "../api/fittingValidation.js";

setGlobalLogLevel("error");

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadContent();
  setConfigService(configs);
  setDb(openDatabase(":memory:"));
});

describe("seedNewUser loadouts (Finding 1)", () => {
  it("seeds one loadout per ship, all valid against ownership + level", () => {
    usersRepo.create({ id: "u-seed", email: null, pass_hash: null, guest_token: "gt-seed" });
    seedNewUser(configs, "u-seed", "Seeded");

    const owned = new Set(ownedModulesRepo.byUser("u-seed").map((r) => r.module_id));
    const level = profilesRepo.byUser("u-seed")!.level;
    const ships = configs.getAll<ShipConfig>("ship");
    const fittings = fittingsRepo.byUser("u-seed");

    // One fitting per ship.
    expect(fittings.length).toBe(ships.length);

    // Every seeded fitting validates (only owned, level-legal, family-legal modules).
    for (const fit of fittings) {
      const result = validateFitting(configs, fit.ship_id, fit.hardpointMap, owned, level);
      expect(result.ok, `fitting for ${fit.ship_id} invalid: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("never seeds a module the user does not own (filters unowned defaultFitting entries)", () => {
    usersRepo.create({ id: "u-seed2", email: null, pass_hash: null, guest_token: "gt-seed2" });
    seedNewUser(configs, "u-seed2", "Seeded2");
    const owned = new Set(ownedModulesRepo.byUser("u-seed2").map((r) => r.module_id));

    for (const fit of fittingsRepo.byUser("u-seed2")) {
      for (const moduleId of Object.values(fit.hardpointMap)) {
        expect(owned.has(moduleId), `seeded unowned module ${moduleId}`).toBe(true);
      }
      // And no fit exceeds the ship's hardpoint count.
      const ship = configs.get<ShipConfig>("ship", fit.ship_id)!;
      const maxIdx = hardpointsOf(ship).length - 1;
      for (const key of Object.keys(fit.hardpointMap)) expect(Number(key)).toBeLessThanOrEqual(maxIdx);
    }
  });
});

/**
 * Owner 2026-08-22: a pilot has ONE loadout per hull, and an account that
 * predates that still carries a pile of named fittings. Those must not wedge
 * anything — the most recent one for each ship becomes that ship's loadout and
 * the rest are ignored. The server cannot know which one the client had
 * SELECTED (that lived in the browser), so "most recent" is its honest rule.
 */
describe("ensureImplicitLoadouts — migrating a pre-2026-08-22 account", () => {
  it("adopts the newest named fitting per hull, drops the rest, and is idempotent", () => {
    usersRepo.create({ id: "u-mig", email: null, pass_hash: null, guest_token: "gt-mig" });
    seedNewUser(configs, "u-mig", "Migrated");

    // Rewind the account to what the old UI left behind: several named rows per
    // hull with random ids, and no well-known row at all.
    for (const row of fittingsRepo.byUser("u-mig")) fittingsRepo.delete(row.id);
    const shipId = "ship.interceptor";
    fittingsRepo.create({ id: "old-1", user_id: "u-mig", ship_id: shipId, name: "Strike", hardpointMap: {}, created_at: 1000 });
    fittingsRepo.create({ id: "old-2", user_id: "u-mig", ship_id: shipId, name: "Brawl", hardpointMap: { "0": "module.laser-mk1" }, created_at: 2000 });
    // Another user's rows must be untouched by any of this.
    usersRepo.create({ id: "u-other", email: null, pass_hash: null, guest_token: "gt-other" });
    seedNewUser(configs, "u-other", "Other");
    const otherBefore = fittingsRepo.byUser("u-other").map((r) => r.id).sort();

    ensureImplicitLoadouts(configs, "u-mig");

    const rows = fittingsRepo.byUserShip("u-mig", shipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(loadoutFittingId("u-mig", shipId));
    // The NEWEST named fitting's content survived; the older one is gone.
    expect(rows[0]!.hardpointMap).toEqual({ "0": "module.laser-mk1" });
    expect(fittingsRepo.byId("old-1")).toBeUndefined();
    expect(fittingsRepo.byId("old-2")).toBeUndefined();
    // Hulls with nothing to inherit still end up with a loadout — their stock fit.
    expect(fittingsRepo.byUser("u-mig")).toHaveLength(configs.getAll<ShipConfig>("ship").length);

    // Running again is a no-op: it must not re-seed over a real loadout.
    ensureImplicitLoadouts(configs, "u-mig");
    expect(fittingsRepo.byUserShip("u-mig", shipId)).toHaveLength(1);
    expect(fittingsRepo.byId(loadoutFittingId("u-mig", shipId))!.hardpointMap).toEqual({ "0": "module.laser-mk1" });

    expect(fittingsRepo.byUser("u-other").map((r) => r.id).sort()).toEqual(otherBefore);
  });

  it("gives a hull added to the pack after signup its stock loadout, without touching the others", () => {
    usersRepo.create({ id: "u-newhull", email: null, pass_hash: null, guest_token: "gt-newhull" });
    seedNewUser(configs, "u-newhull", "New hull");
    const shipId = "ship.interceptor";
    fittingsRepo.upsert({
      id: loadoutFittingId("u-newhull", shipId),
      user_id: "u-newhull",
      ship_id: shipId,
      hardpointMap: { "0": "module.laser-mk1" },
    });
    // Simulate a hull the account has never seen.
    const otherShip = configs.getAll<ShipConfig>("ship").find((s) => s.id !== shipId)!;
    fittingsRepo.delete(loadoutFittingId("u-newhull", otherShip.id));

    ensureImplicitLoadouts(configs, "u-newhull");

    expect(fittingsRepo.byId(loadoutFittingId("u-newhull", otherShip.id))).toBeDefined();
    expect(fittingsRepo.byId(loadoutFittingId("u-newhull", shipId))!.hardpointMap).toEqual({ "0": "module.laser-mk1" });
  });
});
