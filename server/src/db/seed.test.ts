import { beforeAll, describe, expect, it } from "vitest";
import { setGlobalLogLevel, hardpointsOf, type ConfigService, type ShipConfig } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { fittingsRepo, ownedModulesRepo, profilesRepo, usersRepo } from "./repos.js";
import { seedNewUser } from "./seed.js";
import { validateFitting } from "../api/fittingValidation.js";

setGlobalLogLevel("error");

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadContent();
  setConfigService(configs);
  setDb(openDatabase(":memory:"));
});

describe("seedNewUser fittings (Finding 1)", () => {
  it("seeds a Default fitting for every ship, all valid against ownership + level", () => {
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
