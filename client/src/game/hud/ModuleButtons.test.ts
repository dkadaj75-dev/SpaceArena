import { describe, expect, it, vi } from "vitest";
import type { ConfigService, EventBus, ConfigEvents, ModuleConfig, Order, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { ModuleButtons } from "./ModuleButtons.js";

function fakeConfigs(): ConfigService {
  const modules: Record<string, Partial<ModuleConfig>> = {
    "module.laser-mk1": { ui: { icon: "L", label: "Laser" }, activation: { deployTime: 1, retractTime: 1 }, energy: { drawIdle: 3, drawActive: 11 }, heat: { perSecondActive: 6, overheatThreshold: 55, overheatCooldown: 5, overheatSelfDamage: 0 } },
    "module.shield-mk1": { ui: { icon: "S", label: "Shield" }, activation: { deployTime: 1, retractTime: 1 }, energy: { drawIdle: 8, drawActive: 14 }, heat: { perSecondActive: 3, overheatThreshold: 60, overheatCooldown: 5, overheatSelfDamage: 0 } },
  };
  return { get: (_type: string, id: string) => modules[id] as ModuleConfig | undefined } as unknown as ConfigService;
}

function snapshotWithModules(modules: { hardpointIndex: number; moduleId: string; state: "retracted" | "active"; stateTimer?: number; heat?: number }[]): Snapshot {
  return {
    tick: 0,
    elapsed: 0,
    phase: "live",
    winnerTeam: null,
    ships: [
      {
        id: 1,
        team: 0,
        pos: { x: 0, y: 0, z: 0 },
        heading: 0,
        pitch: 0,
        hull: 100,
        hullMax: 100,
        energy: { cur: 100, max: 100 },
        heat: { cur: 0, capacity: 100 },
        targetId: null,
        throttle: 0,
        lockProgress: 0,
        locked: false,
        modules: modules.map((m) => ({ ...m, stateTimer: m.stateTimer ?? 0, heat: m.heat ?? 0, cycleTimer: 0, shieldPool: 0 })),
      },
    ],
    asteroids: [],
    projectiles: [],
  };
}

/**
 * Sol review Finding 2 (HIGH): buttons must be keyed by hardpointIndex, not
 * array position — a sparse fitting like {0: laser, 2: shield} must produce a
 * button whose moduleToggle order carries hardpointIndex 2, not 1.
 */
describe("ModuleButtons (sparse fitting, keyed by hardpointIndex)", () => {
  it("wires each button's click to its true hardpointIndex, not its array position", () => {
    const root = document.createElement("div");
    const orderSpy = vi.fn();
    const session = { order: orderSpy as (order: Order) => void } as unknown as GameSession;
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, session, 1);

    // Sparse fit: hardpoint 0 = laser, hardpoint 2 = shield (hardpoint 1 empty/unfitted).
    buttons.update(
      snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "retracted" },
        { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "retracted" },
      ]),
    );

    const rendered = [...root.querySelectorAll(".hud-module-btn")];
    expect(rendered).toHaveLength(2);

    // Click the second rendered button (the shield, at array position 1) and
    // assert the order carries its REAL hardpointIndex (2), not its render position (1).
    (rendered[1] as HTMLDivElement).click();
    expect(orderSpy).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 2 });

    (rendered[0] as HTMLDivElement).click();
    expect(orderSpy).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 0 });

    buttons.dispose();
  });

  it("matches per-frame state updates (deploy ring / active class) to the module at the same hardpointIndex", () => {
    const root = document.createElement("div");
    const session = { order: vi.fn() } as unknown as GameSession;
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, session, 1);

    buttons.update(
      snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "retracted" },
        { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "retracted" },
      ]),
    );
    // Hardpoint 2 (shield) goes active; hardpoint 0 (laser) stays retracted.
    buttons.update(
      snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "retracted" },
        { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "active" },
      ]),
    );

    const rendered = [...root.querySelectorAll(".hud-module-btn")];
    // rendered[0] is hardpoint 0 (laser, still retracted), rendered[1] is hardpoint 2 (shield, now active).
    expect(rendered[0]!.classList.contains("state-active")).toBe(false);
    expect(rendered[1]!.classList.contains("state-active")).toBe(true);

    buttons.dispose();
  });
});
