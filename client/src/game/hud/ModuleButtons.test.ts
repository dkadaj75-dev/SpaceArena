import { describe, expect, it, vi } from "vitest";
import type { ConfigService, EventBus, ConfigEvents, ModuleConfig, Order, Snapshot, ThemeConfig } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { MODULE_FAMILY_COLOR_FALLBACKS, ModuleButtons, moduleHudName, resolveModuleFamilyColor } from "./ModuleButtons.js";

function fakeConfigs(): ConfigService {
  const modules: Record<string, Partial<ModuleConfig>> = {
    "module.laser-mk1": {
      name: "Pulse Laser Mk I",
      family: "laser",
      ui: { icon: "L", label: "Laser", shortName: "Laser Mk1" },
      activation: { deployTime: 1, retractTime: 1 },
      energy: { drawIdle: 3, drawActive: 11 },
      heat: { perSecondActive: 6, overheatThreshold: 55, overheatCooldown: 5, overheatSelfDamage: 0 },
      fire: {
        mode: "held",
        range: 38,
        cycleTime: 1,
        damage: 1,
        damageType: "energy",
        projectile: null,
        requiresLineOfSight: true,
      },
    },
    "module.shield-mk1": { name: "Deflector Shield Mk I", family: "shield", ui: { icon: "S", label: "Shield" }, activation: { deployTime: 1, retractTime: 1 }, energy: { drawIdle: 8, drawActive: 14 }, heat: { perSecondActive: 3, overheatThreshold: 60, overheatCooldown: 5, overheatSelfDamage: 0 } },
    "module.missile-mk1": {
      name: "Seeker Missile Mk I",
      family: "missile",
      ui: { icon: "M", label: "Missile", shortName: "Missile Mk1" },
      activation: { deployTime: 1, retractTime: 1 },
      energy: { drawIdle: 0, drawActive: 6 },
      heat: { perSecondActive: 4, overheatThreshold: 50, overheatCooldown: 3, overheatSelfDamage: 0 },
      fire: {
        mode: "semi",
        range: 55,
        cycleTime: 2.5,
        damage: 22,
        damageType: "kinetic",
        projectile: { speed: 40, turnRate: 2.2, lifetime: 4.5 },
        requiresLineOfSight: true,
      },
    },
  };
  return { get: (_type: string, id: string) => modules[id] as ModuleConfig | undefined } as unknown as ConfigService;
}

function snapshotWithModules(
  modules: {
    hardpointIndex: number;
    moduleId: string;
    state: "retracted" | "active";
    stateTimer?: number;
    heat?: number;
    cycleTimer?: number;
    channeling?: boolean;
  }[],
  options: { locked?: boolean; energy?: number } = {},
): Snapshot {
  return {
    tick: 0,
    elapsed: 0,
    phase: "live",
    countdownRemaining: 0,
    teamScores: [],
    winnerTeam: null,
    ships: [
      {
        id: 1,
        team: 0,
        pos: { x: 0, y: 0, z: 0 },
        heading: 0,
        pitch: 0,
        up: { x: 0, y: 1, z: 0 },
        hull: 100,
        hullMax: 100,
        energy: { cur: options.energy ?? 100, max: 100 },
        heat: { cur: 0, capacity: 100 },
        targetId: null,
        throttle: 0,
        lockProgress: 0,
        locked: options.locked ?? false,
        modules: modules.map((m) => ({
          ...m,
          stateTimer: m.stateTimer ?? 0,
          heat: m.heat ?? 0,
          cycleTimer: m.cycleTimer ?? 0,
          channeling: m.channeling ?? false,
          shieldPool: 0,
        })),
      },
    ],
    asteroids: [],
    projectiles: [],
    decoys: [],
  };
}

/**
 * Sol review Finding 2 (HIGH): buttons must be keyed by hardpointIndex, not
 * array position — a sparse fitting like {0: laser, 2: shield} must produce a
 * button whose moduleToggle order carries hardpointIndex 2, not 1.
 */
describe("ModuleButtons (sparse fitting, keyed by hardpointIndex)", () => {
  it("uses ui.shortName, then a 12-character truncation of the module display name", () => {
    expect(moduleHudName({ name: "Pulse Laser Mk I", ui: { icon: "L", label: "Laser", shortName: "Laser Mk1" } }, "fallback")).toBe("Laser Mk1");
    expect(moduleHudName({ name: "Deflector Shield Mk I", ui: { icon: "S", label: "Shield" } }, "fallback")).toBe("Deflector Sh");
  });

  it("resolves family colors from the theme with a per-family fallback", () => {
    const custom = {
      hud: { modules: { familyColors: { laser: "#abcdef" } } },
    } as ThemeConfig;
    expect(resolveModuleFamilyColor(custom, "laser")).toBe("#abcdef");
    expect(resolveModuleFamilyColor(custom, "shield")).toBe(MODULE_FAMILY_COLOR_FALLBACKS.shield);
    expect(resolveModuleFamilyColor(undefined, "missile")).toBe(MODULE_FAMILY_COLOR_FALLBACKS.missile);
  });

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
    expect(rendered[0]!.classList).toContain("hex-action");
    expect((rendered[0] as HTMLElement).style.getPropertyValue("--hud-module-family-color")).toBe(
      MODULE_FAMILY_COLOR_FALLBACKS.laser,
    );
    expect(rendered[0]!.querySelector(".label")!.textContent).toBe("Laser Mk1");
    expect(rendered[1]!.querySelector(".label")!.textContent).toBe("Deflector Sh");

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

  it("reflects armed/cooling/no-energy/unarmable weapon states without applying them to shields", () => {
    const root = document.createElement("div");
    const buttons = new ModuleButtons(
      root,
      fakeConfigs(),
      {} as EventBus<ConfigEvents>,
      { order: vi.fn() } as unknown as GameSession,
      1,
    );

    buttons.update(
      snapshotWithModules(
        [
          { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active", cycleTimer: 0.4 },
          { hardpointIndex: 1, moduleId: "module.missile-mk1", state: "active" },
          { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "active" },
        ],
        { locked: false },
      ),
    );
    const [laser, missile, shield] = [...root.querySelectorAll<HTMLElement>(".hud-module-btn")];
    expect(laser!.classList).toContain("armed");
    expect(laser!.classList).toContain("cooling");
    // Straight-fire weapons (2026-07-31) shoot without a lock — never greyed.
    expect(laser!.classList).not.toContain("unarmable");
    expect(laser!.style.getPropertyValue("--ring")).toBe("40");
    // Homing missiles still hard-require the lock, so THEY grey out.
    expect(missile!.classList).toContain("unarmable");
    expect(shield!.classList).not.toContain("armed");
    expect(shield!.classList).not.toContain("cooling");
    expect(shield!.classList).not.toContain("unarmable");

    buttons.update(
      snapshotWithModules(
        [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: "retracted", cycleTimer: 0.4 }],
        { locked: false, energy: 0 },
      ),
    );
    const retracted = root.querySelector(".hud-module-btn")!;
    expect(retracted.classList).toContain("no-energy");
    expect(retracted.classList).not.toContain("cooling");
    expect(retracted.classList).not.toContain("unarmable");
    buttons.dispose();
  });
});
