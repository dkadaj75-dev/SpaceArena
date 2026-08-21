import { describe, expect, it, vi } from "vitest";
import { tuningSchema, type ConfigService, type EventBus, type ConfigEvents, type ModuleConfig, type Order, type Snapshot, type ThemeConfig } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { MODULE_FAMILY_COLOR_FALLBACKS, ModuleButtons, moduleHudName, resolveModuleFamilyColor } from "./ModuleButtons.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";

function fakeConfigs(): ConfigService {
  const tuning = tuningSchema.parse({
    id: "tuning.test",
    type: "tuning",
    version: 1,
    targetingPolicy: "nearest",
    globalDamageMult: 1,
  });
  const modules: Record<string, Partial<ModuleConfig>> = {
    "module.laser-mk1": {
      name: "Pulse Laser Mk I",
      family: "laser",
      ui: { icon: "L", label: "Laser", shortName: "Laser Mk1" },
      activation: { deployTime: 1, retractTime: 1 },
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
    "module.boost-mk1": {
      name: "Afterburner Mk I",
      family: "boost",
      ui: { icon: "[ICON: boost]", label: "Boost", shortName: "Boost Mk1" },
      activation: { deployTime: 0.25, retractTime: 0.25 },
      energy: { capacity: 60, rechargePerSec: 8, drawPerSec: 20, rearmAbove: 0.25 },
      boost: { speedMult: 1.8 },
    },
    "module.shield-mk1": { name: "Deflector Shield Mk I", family: "shield", ui: { icon: "S", label: "Shield" }, activation: { deployTime: 1, retractTime: 1 }, energy: { capacity: 40, rechargePerSec: 4, drawPerSec: 4, rearmAbove: 0.25 }, mitigation: { damageReduction: 0.5, collapseCooldownSec: 8 } },
    "module.missile-mk1": {
      name: "Seeker Missile Mk I",
      family: "missile",
      ui: { icon: "M", label: "Missile", shortName: "Missile Mk1" },
      activation: { deployTime: 1, retractTime: 1 },
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
    "module.kinetic-mk1": {
      name: "Autocannon Mk I",
      family: "kinetic",
      ui: { icon: "K", label: "Autocannon", shortName: "Cannon Mk1" },
      activation: { deployTime: 0.4, retractTime: 0.3 },
      fire: {
        mode: "held", range: 75, cycleTime: 0.3, damage: 5.9, damageType: "kinetic",
        projectile: { speed: 60, lifetime: 1.5 }, requiresLineOfSight: true,
        clip: { size: 24, reloadSec: 2.6 },
      },
    },
  };
  return {
    get: (_type: string, id: string) => modules[id] as ModuleConfig | undefined,
    getAll: (type: string) => type === "tuning" ? [tuning] : [],
  } as unknown as ConfigService;
}

function snapshotWithModules(
  modules: {
    hardpointIndex: number;
    moduleId: string;
    state: "retracted" | "active" | "reloading";
    stateTimer?: number;
    energy?: number;
    energyCapacity?: number;
    cycleTimer?: number;
    channeling?: boolean;
    rounds?: number;
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
        targetId: null,
        throttle: 0,
        lockProgress: 0,
        locked: options.locked ?? false,
        modules: modules.map((m) => ({
          ...m,
          stateTimer: m.stateTimer ?? 0,
          rounds: m.rounds ?? 0,
          energy: m.energy ?? 0,
          energyCapacity: m.energyCapacity ?? 0,
          cycleTimer: m.cycleTimer ?? 0,
          channeling: m.channeling ?? false,
          shieldPool: 0,
        })),
      },
    ],
    asteroids: [],
    projectiles: [],
    decoys: [],
      flags: [],
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

  it("wires each DEPLOYABLE button's click to its true hardpointIndex, not its array position", () => {
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
    // The caption is present but screen-reader only since 2026-08-21: the glyph
    // is what the button shows.
    expect(rendered[0]!.querySelector(".label")!.textContent).toBe("Laser Mk1");
    expect(rendered[0]!.querySelector(".label")!.classList).toContain("sr-only");
    expect(rendered[1]!.querySelector(".label")!.textContent).toBe("Deflector Sh");

    // Click the second rendered button (the shield, at array position 1) and
    // assert the order carries its REAL hardpointIndex (2), not its render position (1).
    (rendered[1] as HTMLDivElement).click();
    expect(orderSpy).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 2 });

    // …while the WEAPON sends no toggle at all: its button is a trigger now, and
    // a weapon that could be switched off would be one a mis-tap could silence.
    orderSpy.mockClear();
    (rendered[0] as HTMLDivElement).click();
    expect(orderSpy).not.toHaveBeenCalled();

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

  /**
   * Boost has its own control in the flight HUD (BoostButton) — a tester
   * reported the boost system as absent from the UI precisely because, as a
   * generic hex in this arc, it was indistinguishable from a weapon and could
   * not show that a flag carrier has no afterburner. It must not be built twice.
   */
  it("leaves the boost family to its dedicated control instead of clustering it", () => {
    const root = document.createElement("div");
    const buttons = new ModuleButtons(
      root,
      fakeConfigs(),
      {} as EventBus<ConfigEvents>,
      { order: vi.fn() } as unknown as GameSession,
      1,
    );

    buttons.update(
      snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "retracted" },
        { hardpointIndex: 1, moduleId: "module.boost-mk1", state: "active" },
        { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "retracted" },
      ]),
    );

    const labels = [...root.querySelectorAll(".hud-module-btn .label")].map((el) => el.textContent);
    expect(labels).toEqual(["Laser Mk1", "Deflector Sh"]);
    // …and the arc is laid out for the buttons that remain, not for a gap.
    const rendered = [...root.querySelectorAll<HTMLElement>(".hud-module-btn")];
    expect(rendered.every((btn) => btn.style.left !== "")).toBe(true);

    buttons.dispose();
  });

  it("reflects armed/counting-down/no-energy/unarmable weapon states without applying them to shields", () => {
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
    expect(laser!.classList).toContain("on-cooldown");
    // Straight-fire weapons (2026-07-31) shoot without a lock — never greyed.
    expect(laser!.classList).not.toContain("unarmable");
    // The cooldown ring FILLS as the cycle burns off: 0.4 s left of a 1 s
    // cycle is 60% of the way back to ready.
    expect(laser!.style.getPropertyValue("--ring")).toBe("60");
    // Homing missiles still hard-require the lock, so THEY grey out.
    expect(missile!.classList).toContain("unarmable");
    expect(shield!.classList).not.toContain("armed");
    expect(shield!.classList).not.toContain("on-cooldown");
    expect(shield!.classList).not.toContain("unarmable");

    buttons.update(
      snapshotWithModules(
        [{ hardpointIndex: 0, moduleId: "module.shield-mk1", state: "retracted", energy: 0, energyCapacity: 50 }],
        { locked: false },
      ),
    );
    const retracted = root.querySelector(".hud-module-btn")!;
    expect(retracted.classList).toContain("no-energy");
    expect(retracted.classList).not.toContain("on-cooldown");
    expect(retracted.classList).not.toContain("unarmable");
    buttons.dispose();
  });

  it("shows live clip rounds and a reload sweep", () => {
    const root = document.createElement("div");
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1);
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.kinetic-mk1", state: "active", rounds: 17 },
    ]));
    const button = root.querySelector<HTMLElement>(".hud-module-btn")!;
    expect(button.querySelector<HTMLElement>(".rounds")!.textContent).toBe("17");
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.kinetic-mk1", state: "reloading", rounds: 0, stateTimer: 1.3 },
    ]));
    expect(button.querySelector<HTMLElement>(".rounds")!.textContent).toBe("0");
    expect(button.classList).toContain("state-reloading");
    expect(button.classList).toContain("ring-reload");
    expect(button.style.getPropertyValue("--ring")).toBe("50");
    buttons.dispose();
  });

  it("renders a weapon COOLDOWN ring and an energy ring from replicated module state", () => {
    const root = document.createElement("div");
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1);
    // The laser's authored cycleTime is 1 s, so 0.75 s left reads as a quarter
    // of the way back to ready — the ring FILLS as the countdown burns off.
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active", cycleTimer: 0.75 },
      { hardpointIndex: 1, moduleId: "module.shield-mk1", state: "active", energy: 30, energyCapacity: 60 },
      { hardpointIndex: 2, moduleId: "module.missile-mk1", state: "active" },
    ]));

    const counting = root.querySelector<HTMLElement>('[aria-label="Pulse Laser Mk I"]')!;
    const energy = root.querySelector<HTMLElement>('[aria-label="Deflector Shield Mk I"]')!;
    const none = root.querySelector<HTMLElement>('[aria-label="Seeker Missile Mk I"]')!;
    expect(counting.classList).toContain("ring-cooldown");
    expect(counting.style.getPropertyValue("--ring")).toBe("25");
    expect(energy.classList).toContain("ring-energy");
    expect(energy.style.getPropertyValue("--ring")).toBe("50");
    // A ready weapon with no tank has no ring at all.
    expect(none.classList).not.toContain("ring-cooldown");
    expect(none.classList).not.toContain("ring-energy");
    expect(none.querySelector<HTMLElement>(".ring")!.hidden).toBe(true);
    buttons.dispose();
  });

  /**
   * WEAPON TRIGGERS (2026-08-21). The FIRE button is gone: a weapon's button is
   * a momentary trigger whose held state rides the flight order as a bitmask,
   * and a deployable's button keeps the toggle it always had.
   */
  describe("weapon triggers", () => {
    function pointer(type: string, pointerId = 1): Event {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId, pointerType: "touch", button: 0 });
      return event;
    }

    function railWith(states: Parameters<typeof snapshotWithModules>[0]) {
      const root = document.createElement("div");
      const buttons = new ModuleButtons(
        root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1,
      );
      buttons.update(snapshotWithModules(states));
      return { root, buttons };
    }

    it("sets the held weapon's BIT, and clears it on release", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
        { hardpointIndex: 3, moduleId: "module.missile-mk1", state: "active" },
      ]);
      const [laser, missile] = [...root.querySelectorAll<HTMLElement>(".hud-module-btn")];
      expect(buttons.triggerMask()).toBe(0);

      laser!.dispatchEvent(pointer("pointerdown"));
      expect(buttons.triggerMask()).toBe(1 << 0);
      expect(laser!.classList).toContain("firing");

      // The mask is per HARDPOINT, not per render position: the missile sits at
      // hardpoint 3 and must set bit 3.
      missile!.dispatchEvent(pointer("pointerdown", 2));
      expect(buttons.triggerMask()).toBe((1 << 0) | (1 << 3));

      laser!.dispatchEvent(pointer("pointerup"));
      expect(buttons.triggerMask()).toBe(1 << 3);
      expect(laser!.classList).not.toContain("firing");
      buttons.dispose();
    });

    it("releases a trigger held when the pointer comes up OUTSIDE the button", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
      ]);
      root.querySelector<HTMLElement>(".hud-module-btn")!.dispatchEvent(pointer("pointerdown"));
      expect(buttons.triggerMask()).toBe(1);
      document.dispatchEvent(pointer("pointerup"));
      expect(buttons.triggerMask()).toBe(0);
      buttons.dispose();
    });

    it("drops every held trigger when the rail is disabled", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
      ]);
      root.querySelector<HTMLElement>(".hud-module-btn")!.dispatchEvent(pointer("pointerdown"));
      expect(buttons.anyTriggerHeld).toBe(true);
      buttons.setEnabled(false);
      expect(buttons.triggerMask()).toBe(0);
      expect(buttons.anyTriggerHeld).toBe(false);
      buttons.dispose();
    });

    it("gives the PRIMARY weapon the FIRE pedestal and leaves deployables on the arc", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
        { hardpointIndex: 1, moduleId: "module.shield-mk1", state: "retracted" },
      ]);
      // The pedestal only exists when the theme authors the FIRE-hugging action
      // arc, which the shipped theme does.
      buttons.applyFlightLayout(
        resolveFlightHudLayout(
          { hud: { flight: { actions: { arc: { radiusPx: 127, startDeg: -102, sweepDeg: -77, buttonDiameterPx: 48, captionGapPx: 5 } } } } } as never,
          { width: 900, height: 420 },
        ),
      );
      const [primary, shield] = [...root.querySelectorAll<HTMLElement>(".hud-module-btn")];
      expect(primary!.classList).toContain("primary");
      expect(primary!.classList).toContain("trigger");
      expect(shield!.classList).not.toContain("primary");
      expect(shield!.classList).not.toContain("trigger");
      // The pedestal is the bigger target — that is the whole point of it.
      expect(parseFloat(primary!.style.width)).toBeGreaterThan(parseFloat(shield!.style.width));
      buttons.dispose();
    });
  });

  it("clears the cooldown ring the moment the weapon is ready again", () => {
    const root = document.createElement("div");
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1);
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active", cycleTimer: 0.5 },
    ]));
    const button = root.querySelector<HTMLElement>(".hud-module-btn")!;
    expect(button.classList).toContain("ring-cooldown");
    expect(button.style.getPropertyValue("--ring")).toBe("50");

    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active", cycleTimer: 0 },
    ]));
    expect(button.classList).not.toContain("ring-cooldown");
    expect(button.querySelector<HTMLElement>(".ring")!.hidden).toBe(true);
    buttons.dispose();
  });
});
