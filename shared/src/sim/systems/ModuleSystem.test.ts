import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld } from "../testutil.js";
import type { World } from "../World.js";
import { moduleSystem } from "./ModuleSystem.js";
import { energySystem } from "./EnergySystem.js";

const DT = 1 / 30;
const LASER = 0;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function shipWorld(): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

function tickModules(world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    for (const m of world.modules.get(world.shipIds()[0]!)!.modules) m.workedThisTick = false;
    moduleSystem(world, DT);
  }
}

describe("ModuleSystem state machine", () => {
  it("cycles retracted → deploying → active → retracting → retracted", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    expect(mod.state).toBe("retracted");

    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    expect(mod.state).toBe("deploying");

    tickModules(world, 45); // deployTime 1.5s
    expect(mod.state).toBe("active");

    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    expect(mod.state).toBe("retracting");

    tickModules(world, 30); // retractTime 1.0s
    expect(mod.state).toBe("retracted");
  });

  it("emits moduleStateChanged with activate action ids", () => {
    const { world, id } = shipWorld();
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    const evt = world.events.find((e) => e.type === "moduleStateChanged" && e.to === "deploying");
    expect(evt).toBeTruthy();
  });

  it("overheats when heat crosses threshold, then cools back to retracted", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    // Bring it to active.
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    tickModules(world, 46);
    expect(mod.state).toBe("active");

    // Push heat just under threshold (55) then run one worked tick via energySystem.
    mod.heat = 54.9;
    mod.workedThisTick = true;
    energySystem(world, DT);
    expect(mod.state).toBe("overheated");
    expect(world.events.some((e) => e.type === "overheated")).toBe(true);

    // Cooldown (5s ≈ 150 ticks; a margin covers float drift) → retracted.
    tickModules(world, 160);
    expect(mod.state).toBe("retracted");
    expect(mod.heat).toBe(0);
  });

  it("ignores toggles while overheated", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    mod.state = "overheated";
    mod.stateTimer = 5;
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    expect(mod.state).toBe("overheated");
  });
});
