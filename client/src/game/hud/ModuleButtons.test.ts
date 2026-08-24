import { describe, expect, it, vi } from "vitest";
import { tuningSchema, type ConfigService, type EventBus, type ConfigEvents, type ModuleConfig, type Order, type Snapshot, type ThemeConfig } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import {
  MODULE_FAMILY_COLOR_FALLBACKS,
  ModuleButtons,
  formatRemainingSec,
  lowAmmoThreshold,
  moduleHudName,
  moduleSlotTypeLabel,
  resolveHudSlotCounts,
  resolveModuleFamilyColor,
  utilitySlotAssignments,
} from "./ModuleButtons.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { resolveHudLayout } from "./hudLayout.js";
import { BoostButton, BOOST_LABEL, BOOST_SLOT_TYPE } from "./BoostButton.js";
import { JettisonButton, JETTISON_LABEL, JETTISON_SLOT_TYPE } from "./JettisonButton.js";
import { FlightControls } from "./FlightControls.js";

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
    // How every SHIPPED hull actually carries its afterburner: an `engine`
    // internal with a `boost` block. The module schema requires exactly this
    // ("a boost block belongs to the engine that provides it"), and no content
    // authors `family: "boost"` at all — see the Talon fitting below.
    "module.engine-earth-eng1": {
      name: "Earth Engine Engineered I",
      family: "engine",
      ui: { icon: "[ICON: engine]", label: "Engine", shortName: "E-Engine I" },
      activation: { deployTime: 0, retractTime: 0 },
      energy: { capacity: 55, rechargePerSec: 7.4, drawPerSec: 20, rearmAbove: 0.25 },
      boost: { speedMult: 1.7 },
    },
    "module.countermeasure-flare": {
      name: "Flare Pod",
      family: "countermeasure",
      ui: { icon: "[ICON: countermeasure]", label: "Countermeasure", shortName: "Flares" },
      activation: { deployTime: 0, retractTime: 0 },
      jettison: { cooldownSec: 30, decoyLifetimeSec: 6, decoyRadius: 1.2 },
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
    "module.ray-slow-mk1": {
      name: "Tether Ray Mk I",
      family: "disruptor",
      ui: { icon: "D", label: "Slowing Ray", shortName: "Tether Ray" },
      activation: { deployTime: 0.35, retractTime: 0.2 },
      slow: { range: 110, factor: 0.35, durationSec: 4, cooldownSec: 12 },
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
    // An empty magazine says DRY, not "0": the mockup's out-of-ammo state, and
    // a word a pilot can read from the corner of the eye where a zero cannot.
    expect(button.querySelector<HTMLElement>(".rounds")!.textContent).toBe("DRY");
    expect(button.classList).toContain("dry");
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

    // The accessible name leads with the slot number the button prints, and the
    // numbering restarts per cluster: laser is weapon 01, missile weapon 02,
    // and the shield is utility 01.
    const counting = root.querySelector<HTMLElement>('[aria-label="01 Pulse Laser Mk I"]')!;
    const energy = root.querySelector<HTMLElement>('[aria-label="01 Deflector Shield Mk I"]')!;
    const none = root.querySelector<HTMLElement>('[aria-label="02 Seeker Missile Mk I"]')!;
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

    it("releases a trigger held when ITS pointer comes up OUTSIDE the button", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
      ]);
      root.querySelector<HTMLElement>(".hud-module-btn")!.dispatchEvent(pointer("pointerdown", 4));
      expect(buttons.triggerMask()).toBe(1);
      document.dispatchEvent(pointer("pointerup", 4));
      expect(buttons.triggerMask()).toBe(0);
      buttons.dispose();
    });

    it("KEEPS firing when a DIFFERENT pointer is released — the steering thumb", () => {
      // The bug this pins (2026-08-21): a pilot fires with one thumb and steers
      // with the other, and the document-level backstop used to drop every held
      // trigger on any pointerup at all. In a dogfight the steering thumb lifts
      // constantly, so the gun would not hold down for more than an instant.
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
      ]);
      root.querySelector<HTMLElement>(".hud-module-btn")!.dispatchEvent(pointer("pointerdown", 7));
      expect(buttons.triggerMask()).toBe(1);

      // The other thumb comes off the stick, anywhere on the page.
      document.dispatchEvent(pointer("pointerup", 8));
      document.dispatchEvent(pointer("pointercancel", 9));
      expect(buttons.triggerMask()).toBe(1);

      // …and the trigger's own pointer still releases it.
      document.dispatchEvent(pointer("pointerup", 7));
      expect(buttons.triggerMask()).toBe(0);
      buttons.dispose();
    });

    /**
     * Playtest finding 1: with a steering thumb held, a second touch on a
     * `click`-bound control synthesizes NO click, so the shield toggle was dead
     * for the whole of normal flight — confirmed live, the shield never left
     * `state-retracted` across an entire match. The rail's utility buttons are
     * bound to pointer events now, exactly like the weapon triggers beside them.
     */
    it("toggles the shield from a POINTER tap, with a steering finger already down", () => {
      const root = document.createElement("div");
      const order = vi.fn();
      const buttons = new ModuleButtons(
        root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order } as unknown as GameSession, 1,
      );
      buttons.update(snapshotWithModules([
        { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "retracted" },
      ]));
      const shield = root.querySelector<HTMLElement>(".hud-module-btn")!;

      // Pointer 1 is the steering thumb, already down somewhere else entirely.
      document.dispatchEvent(pointer("pointerdown", 1));
      // Pointer 2 taps the shield. No `click` is dispatched at all — which is
      // precisely what the browser does for a second touch point.
      shield.dispatchEvent(pointer("pointerdown", 2));
      shield.dispatchEvent(pointer("pointerup", 2));
      expect(order).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 2 });
      buttons.dispose();
    });

    it("does not fire the shield when the finger DRAGS off across the button", () => {
      const root = document.createElement("div");
      const order = vi.fn();
      const buttons = new ModuleButtons(
        root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order } as unknown as GameSession, 1,
      );
      buttons.update(snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.shield-mk1", state: "retracted" },
      ]));
      const shield = root.querySelector<HTMLElement>(".hud-module-btn")!;
      shield.dispatchEvent(Object.assign(pointer("pointerdown", 3), { clientX: 40, clientY: 300 }));
      shield.dispatchEvent(Object.assign(pointer("pointerup", 3), { clientX: 140, clientY: 300 }));
      expect(order).not.toHaveBeenCalled();
      // …and a tap that stays put still works.
      shield.dispatchEvent(Object.assign(pointer("pointerdown", 4), { clientX: 40, clientY: 300 }));
      shield.dispatchEvent(Object.assign(pointer("pointerup", 4), { clientX: 42, clientY: 302 }));
      expect(order).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 0 });
      buttons.dispose();
    });

    it("refuses a utility TOGGLE while the rail is disabled, like the triggers", () => {
      const root = document.createElement("div");
      const orderSpy = vi.fn();
      const buttons = new ModuleButtons(
        root, fakeConfigs(), {} as EventBus<ConfigEvents>,
        { order: orderSpy } as unknown as GameSession, 1,
      );
      buttons.update(snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.shield-mk1", state: "retracted" },
      ]));
      const shield = root.querySelector<HTMLDivElement>(".hud-module-btn")!;
      buttons.setEnabled(false);
      shield.click();
      expect(orderSpy).not.toHaveBeenCalled();
      buttons.setEnabled(true);
      shield.click();
      expect(orderSpy).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 0 });
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

    /**
     * The pedestal is GONE (owner HUD pass, 2026-08-21). A weapon is a weapon:
     * every slot in a cluster is the same circle, and what separates the primary
     * from the rest is that it is slot 01, nearest the thumb.
     */
    it("splits weapons right and utilities left, all one size, numbered per side", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
        { hardpointIndex: 1, moduleId: "module.shield-mk1", state: "retracted" },
        { hardpointIndex: 2, moduleId: "module.kinetic-mk1", state: "active", rounds: 24 },
      ]);
      buttons.applyFlightLayout(resolveFlightHudLayout(undefined, { width: 900, height: 420 }));

      const weapons = [...root.querySelectorAll<HTMLElement>(
        '.hud-slot-cluster[data-side="weapons"] .hud-module-btn',
      )];
      const utilities = [...root.querySelectorAll<HTMLElement>(
        '.hud-slot-cluster[data-side="utilities"] .hud-module-btn',
      )];
      expect(weapons.map((b) => b.dataset["slot"])).toEqual(["01", "02"]);
      expect(utilities.map((b) => b.dataset["slot"])).toEqual(["01"]);
      expect(weapons.every((b) => b.classList.contains("trigger"))).toBe(true);
      expect(utilities.every((b) => b.classList.contains("trigger"))).toBe(false);
      // No pedestal: both weapons are the same target.
      expect(weapons[0]!.style.width).toBe(weapons[1]!.style.width);
      expect(root.querySelector(".hud-module-btn.primary")).toBeNull();
      // The printed number, the glyph and the short TYPE word are all there.
      expect(weapons[0]!.querySelector(".slot-num")!.textContent).toBe("01");
      expect(weapons[0]!.querySelector(".icon svg")).not.toBeNull();
      expect(weapons[0]!.querySelector(".slot-type")!.textContent).toBe("LASER");
      expect(utilities[0]!.querySelector(".slot-type")!.textContent).toBe("SHIELD");
      // The cluster anchors are what put each side under its own thumb.
      expect(
        root.querySelector<HTMLElement>('.hud-slot-cluster[data-side="weapons"]')!.dataset["anchor"],
      ).toBe("bottom-right");
      expect(
        root.querySelector<HTMLElement>('.hud-slot-cluster[data-side="utilities"]')!.dataset["anchor"],
      ).toBe("bottom-left");
      buttons.dispose();
    });

    it("shrinks the cluster as the side gets busier, never past the touch floor", () => {
      const four = railWith([0, 1, 2, 3].map((i) => ({
        hardpointIndex: i, moduleId: "module.laser-mk1", state: "active" as const,
      })));
      four.buttons.applyFlightLayout(resolveFlightHudLayout(undefined, { width: 900, height: 420 }));
      const two = railWith([0, 1].map((i) => ({
        hardpointIndex: i, moduleId: "module.laser-mk1", state: "active" as const,
      })));
      two.buttons.applyFlightLayout(resolveFlightHudLayout(undefined, { width: 900, height: 420 }));

      const widthOf = (r: HTMLElement) =>
        parseFloat(r.querySelector<HTMLElement>(".hud-module-btn")!.style.width);
      expect(widthOf(two.root)).toBe(82);
      expect(widthOf(four.root)).toBe(70);
      expect(widthOf(four.root)).toBeGreaterThanOrEqual(44);
      two.buttons.dispose();
      four.buttons.dispose();
    });
  });

  /**
   * Mockup state 3, mapped onto the states the sim actually replicates. There is
   * no LINK-group concept and no per-slot "unfitted" entry in a snapshot, so
   * neither is invented here — `unpowered` is the real analogue of unfitted.
   */
  describe("per-slot states", () => {
    function railWith(states: Parameters<typeof snapshotWithModules>[0]) {
      const root = document.createElement("div");
      const buttons = new ModuleButtons(
        root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1,
      );
      buttons.update(snapshotWithModules(states));
      return { root, buttons };
    }

    it("prints the seconds left beside the cooling pie, and clears them when ready", () => {
      const root = document.createElement("div");
      const buttons = new ModuleButtons(
        root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1,
      );
      // The missile's authored cycle is 2.5 s.
      buttons.update(snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.missile-mk1", state: "active", cycleTimer: 1.8 },
      ]));
      const secs = root.querySelector<HTMLElement>(".cooldown-secs")!;
      expect(secs.hidden).toBe(false);
      expect(secs.textContent).toBe("2");

      // Under a second the tenths matter: 0.9 and 0.1 are different decisions.
      buttons.update(snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.missile-mk1", state: "active", cycleTimer: 0.4 },
      ]));
      expect(secs.textContent).toBe("0.4");

      buttons.update(snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.missile-mk1", state: "active", cycleTimer: 0 },
      ]));
      expect(secs.hidden).toBe(true);
      expect(secs.textContent).toBe("");
      buttons.dispose();
    });

    it("warns on a low magazine and only on a magazine-fed weapon", () => {
      // The autocannon's clip is 24, so "low" is the last 6.
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.kinetic-mk1", state: "active", rounds: 6 },
        { hardpointIndex: 1, moduleId: "module.laser-mk1", state: "active" },
      ]);
      const [cannon, laser] = [...root.querySelectorAll<HTMLElement>(".hud-module-btn")];
      expect(cannon!.classList).toContain("low-ammo");
      expect(cannon!.classList).not.toContain("dry");
      expect(cannon!.querySelector<HTMLElement>(".rounds")!.textContent).toBe("6");
      // A laser has no rounds to be low on, so it gets no counter at all rather
      // than an invented one.
      expect(laser!.classList).not.toContain("low-ammo");
      expect(laser!.querySelector<HTMLElement>(".rounds")!.hidden).toBe(true);
      buttons.dispose();
    });

    it("reads a rail-starved weapon as the unfitted slot: dimmed and inert", () => {
      const { root, buttons } = railWith([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "retracted" },
      ]);
      const button = root.querySelector<HTMLElement>(".hud-module-btn")!;
      expect(button.classList).toContain("unpowered");
      expect(button.title).toBe("No rail power for this weapon");
      buttons.dispose();
    });
  });

  describe("slot counts shared across the left cluster", () => {
    it("puts BOOST then JETTISON behind the fitted deployables", () => {
      const configs = fakeConfigs();
      const counts = resolveHudSlotCounts(configs, [
        { hardpointIndex: 0, moduleId: "module.laser-mk1" },
        { hardpointIndex: 1, moduleId: "module.shield-mk1" },
        { hardpointIndex: 2, moduleId: "module.boost-mk1" },
      ] as never);
      expect(counts).toMatchObject({
        weapons: 1,
        utilityModules: 1,
        boostSlot: 1,
        jettisonSlot: null,
        utilities: 2,
      });
      // The shield's circle comes from the same resolution BOOST's does.
      expect([...counts.utilitySlots]).toEqual([[1, 0]]);
      expect([...counts.weaponSlots]).toEqual([[0, 0]]);
    });

    it("counts no left slot for a fitting with neither action", () => {
      const counts = resolveHudSlotCounts(fakeConfigs(), [
        { moduleId: "module.laser-mk1" },
        { moduleId: "module.kinetic-mk1" },
      ] as never);
      expect(counts.weapons).toBe(2);
      expect(counts.utilities).toBe(0);
      expect(counts.boostSlot).toBeNull();
    });

    /**
     * The owner's Talon report (2026-08-23): "when using Jettison, the button
     * mixes up Jettison / Boost" — one bottom-left circle showing the BOOST
     * caption over the jettison glyph, numbered 01.
     *
     * The cause was two questions with two different answers. The BOOST control
     * is rendered when a fitted module has a `boost` BLOCK, but the slot counts
     * asked for `family === "boost"` — a family no shipped module uses, because
     * the afterburner rides the engine. So BOOST appeared, got no slot, kept its
     * constructor default (slot 01 of a one-slot cluster) and landed exactly on
     * top of JETTISON, which the same counts had just put there.
     */
    it("finds the Talon's BOOST on its engine's boost block, not on a family nothing authors", () => {
      const counts = resolveHudSlotCounts(fakeConfigs(), [
        { hardpointIndex: 0, moduleId: "module.laser-mk1" },
        { hardpointIndex: 1, moduleId: "module.missile-mk1" },
        { hardpointIndex: 2, moduleId: "module.engine-earth-eng1" },
        { hardpointIndex: 3, moduleId: "module.countermeasure-flare" },
      ] as never);
      // Both internals: neither gets a module button, but each owns a left slot.
      expect(counts).toMatchObject({
        weapons: 2,
        utilityModules: 0,
        boostSlot: 0,
        jettisonSlot: 1,
        utilities: 2,
      });
      expect([...counts.utilitySlots]).toEqual([]);
    });

    /**
     * The OWNER'S report (2026-08-23), one fitting on from the Talon's: "the
     * SHIELD button is hidden behind the BOOST or JETTISON button". Same
     * disease — two consumers deciding the same circle independently — with the
     * shield as the casualty, because on any hull carrying a deployable the
     * shield owns left slot 01, which is exactly where a control that failed to
     * get an assignment falls back to.
     *
     * The invariant, stated once: for ANY fitting, the left cluster hands out
     * as many DISTINCT circles as it has controls.
     */
    it("never gives two left-cluster controls the same circle, whatever the fitting", () => {
      const configs = fakeConfigs();
      const fittings: { name: string; modules: { hardpointIndex: number; moduleId: string }[] }[] = [
        {
          name: "shield + boost + jettison",
          modules: [
            { hardpointIndex: 0, moduleId: "module.laser-mk1" },
            { hardpointIndex: 1, moduleId: "module.shield-mk1" },
            { hardpointIndex: 2, moduleId: "module.engine-earth-eng1" },
            { hardpointIndex: 3, moduleId: "module.countermeasure-flare" },
          ],
        },
        {
          name: "shield + boost only",
          modules: [
            { hardpointIndex: 0, moduleId: "module.laser-mk1" },
            { hardpointIndex: 1, moduleId: "module.shield-mk1" },
            { hardpointIndex: 2, moduleId: "module.engine-earth-eng1" },
          ],
        },
        {
          name: "shield + jettison only",
          modules: [
            { hardpointIndex: 0, moduleId: "module.shield-mk1" },
            { hardpointIndex: 1, moduleId: "module.countermeasure-flare" },
          ],
        },
        {
          name: "two deployables + boost + jettison, sparse and out of order",
          modules: [
            { hardpointIndex: 4, moduleId: "module.countermeasure-flare" },
            { hardpointIndex: 2, moduleId: "module.ray-slow-mk1" },
            { hardpointIndex: 3, moduleId: "module.engine-earth-eng1" },
            { hardpointIndex: 0, moduleId: "module.shield-mk1" },
            { hardpointIndex: 1, moduleId: "module.kinetic-mk1" },
          ],
        },
      ];
      for (const fitting of fittings) {
        const assignments = utilitySlotAssignments(resolveHudSlotCounts(configs, fitting.modules as never));
        const circles = [...assignments.values()];
        expect(new Set(circles).size, `${fitting.name} stacked two controls`).toBe(circles.length);
      }
    });

    it("numbers the sparse, out-of-order fitting by HARDPOINT, deployables before the two actions", () => {
      const counts = resolveHudSlotCounts(fakeConfigs(), [
        { hardpointIndex: 4, moduleId: "module.countermeasure-flare" },
        { hardpointIndex: 2, moduleId: "module.ray-slow-mk1" },
        { hardpointIndex: 3, moduleId: "module.engine-earth-eng1" },
        { hardpointIndex: 0, moduleId: "module.shield-mk1" },
      ] as never);
      // Shield at hardpoint 0 keeps circle 01 and the tether ray takes 02,
      // whatever order the snapshot replicated them in.
      expect([...counts.utilitySlots].sort()).toEqual([[0, 0], [2, 1]]);
      expect(counts.boostSlot).toBe(2);
      expect(counts.jettisonSlot).toBe(3);
    });
  });

  /**
   * The two dedicated left-cluster controls are separate components fed from one
   * {@link resolveHudSlotCounts}, exactly as `FlightControls.refreshActionArc`
   * does it. These pin the invariant the Talon bug broke: each button's number,
   * glyph and caption describe ONE control, and they never share a circle.
   */
  describe("BOOST and JETTISON identity on the shared left cluster", () => {
    const TALON = [
      { moduleId: "module.laser-mk1" },
      { moduleId: "module.missile-mk1" },
      { moduleId: "module.engine-earth-eng1" },
      { moduleId: "module.countermeasure-flare" },
    ] as never;

    function place(): { boost: BoostButton; jettison: JettisonButton; root: HTMLElement } {
      const root = document.createElement("div");
      const layout = resolveFlightHudLayout(undefined, { width: 390, height: 740 });
      const boost = new BoostButton(root, layout, () => {});
      const jettison = new JettisonButton(root, layout, () => {});
      const counts = resolveHudSlotCounts(fakeConfigs(), TALON);
      boost.applySlotLayout(layout, counts.utilities, counts.boostSlot!);
      jettison.applySlotLayout(layout, counts.utilities, counts.jettisonSlot!);
      return { boost, jettison, root };
    }

    function identityOf(button: HTMLElement): Record<string, string> {
      return {
        slot: button.dataset["slot"] ?? "",
        number: button.querySelector(".slot-num")!.textContent ?? "",
        type: button.querySelector(".slot-type")!.textContent ?? "",
        label: button.querySelector(".label")!.textContent ?? "",
        left: button.style.left,
        top: button.style.top,
      };
    }

    it("gives each control its own numbered circle instead of stacking them on slot 01", () => {
      const { boost, jettison, root } = place();
      const boostBtn = root.querySelector<HTMLElement>(".hud-boost-btn")!;
      const jettisonBtn = root.querySelector<HTMLElement>(".hud-jettison-btn")!;
      expect(identityOf(boostBtn)).toMatchObject({ slot: "01", number: "01", type: BOOST_SLOT_TYPE, label: BOOST_LABEL });
      expect(identityOf(jettisonBtn)).toMatchObject({ slot: "02", number: "02", type: JETTISON_SLOT_TYPE, label: JETTISON_LABEL });
      // The regression itself: two controls, one circle.
      expect(boostBtn.style.top).not.toBe(jettisonBtn.style.top);
      boost.dispose();
      jettison.dispose();
    });

    /**
     * The owner's report of 2026-08-23, as the DOM: a Brawler-shaped fitting
     * that carries a shield AND an afterburner AND a pod, all three drawn by
     * three different components onto one cluster. Every one of them must own a
     * numbered circle of its own.
     */
    it("gives SHIELD, BOOST and JETTISON three distinct circles on one left cluster", () => {
      const configs = fakeConfigs();
      const viewport = { width: 915, height: 412 };
      const root = document.createElement("div");
      const layout = resolveFlightHudLayout(undefined, viewport);
      const rail = new ModuleButtons(
        root, configs, {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1,
      );
      rail.applyLayout(resolveHudLayout(undefined, viewport));
      const boost = new BoostButton(root, layout, () => {});
      const jettison = new JettisonButton(root, layout, () => {});

      const fitting = [
        { hardpointIndex: 0, moduleId: "module.kinetic-mk1", state: "active" as const },
        { hardpointIndex: 1, moduleId: "module.laser-mk1", state: "active" as const },
        { hardpointIndex: 2, moduleId: "module.shield-mk1", state: "retracted" as const },
        { hardpointIndex: 3, moduleId: "module.engine-earth-eng1", state: "retracted" as const },
        { hardpointIndex: 4, moduleId: "module.countermeasure-flare", state: "active" as const },
      ];
      rail.update(snapshotWithModules(fitting));
      const counts = resolveHudSlotCounts(configs, snapshotWithModules(fitting).ships[0]!.modules);
      boost.applySlotLayout(layout, counts.utilities, counts.boostSlot!);
      jettison.applySlotLayout(layout, counts.utilities, counts.jettisonSlot!);

      const shieldBtn = root.querySelector<HTMLElement>(
        '.hud-slot-cluster[data-side="utilities"] .hud-module-btn',
      )!;
      const boostBtn = root.querySelector<HTMLElement>(".hud-boost-btn")!;
      const jettisonBtn = root.querySelector<HTMLElement>(".hud-jettison-btn")!;

      // Three controls, three numbers, in the documented running order:
      // deployables first, then BOOST, then JETTISON.
      expect(shieldBtn.querySelector(".slot-type")!.textContent).toBe("SHIELD");
      expect([shieldBtn, boostBtn, jettisonBtn].map((b) => b.dataset["slot"])).toEqual(["01", "02", "03"]);
      expect([shieldBtn, boostBtn, jettisonBtn].map((b) => b.querySelector(".slot-num")!.textContent))
        .toEqual(["01", "02", "03"]);

      // …and three boxes. The bug was three controls on ONE circle, so the
      // positions are what actually has to differ, not only the captions.
      const boxes = [shieldBtn, boostBtn, jettisonBtn].map((b) => `${b.style.left}|${b.style.top}`);
      expect(new Set(boxes).size).toBe(3);
      // All one cluster: same diameter, sized for three mounts, not for one.
      expect(new Set([shieldBtn, boostBtn, jettisonBtn].map((b) => b.style.width)).size).toBe(1);

      rail.dispose();
      boost.dispose();
      jettison.dispose();
    });

    /**
     * The path the owner actually walked into it on a phone. A rotation, a
     * collapsing URL bar or a theme hot-reload re-lays the flight HUD out — and
     * `applyLayout` used to hand BOOST and JETTISON their CONSTRUCTOR default,
     * slot 01 of a ONE-slot cluster, trusting the next live frame to put them
     * back. Slot 01 of the left cluster is the shield's circle, and there is no
     * next live frame while the pilot is dead, paused, or reading the results.
     */
    it("keeps BOOST and JETTISON off the shield's circle across a re-layout", () => {
      const configs = fakeConfigs();
      const root = document.createElement("div");
      const surface = document.createElement("div");
      const flight = new FlightControls(
        root,
        configs,
        { order: vi.fn(), displayNameFor: () => "x", shipConfigIdFor: () => undefined } as unknown as GameSession,
        1,
        {
          inputSurface: surface,
          project: () => false,
          cameraView: (out) => { out.fovRad = 0.8; out.betaRad = Math.PI / 2; },
        },
        resolveFlightHudLayout(undefined, { width: 915, height: 412 }),
      );
      const shot = snapshotWithModules([
        { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
        { hardpointIndex: 1, moduleId: "module.shield-mk1", state: "retracted" },
        { hardpointIndex: 2, moduleId: "module.engine-earth-eng1", state: "retracted" },
        { hardpointIndex: 3, moduleId: "module.countermeasure-flare", state: "active" },
      ]);
      flight.update(shot, shot, 1, 16, 0);
      const boostBtn = root.querySelector<HTMLElement>(".hud-boost-btn")!;
      const jettisonBtn = root.querySelector<HTMLElement>(".hud-jettison-btn")!;
      expect([boostBtn.dataset["slot"], jettisonBtn.dataset["slot"]]).toEqual(["02", "03"]);

      // The phone rotates. Nothing calls `update` before the next paint.
      flight.applyLayout(resolveFlightHudLayout(undefined, { width: 412, height: 915 }));
      expect([boostBtn.dataset["slot"], jettisonBtn.dataset["slot"]]).toEqual(["02", "03"]);
      // Portrait is a different geometry, so the boxes move — but never onto
      // each other, and never onto the shield's slot-01 box.
      expect(boostBtn.style.top).not.toBe(jettisonBtn.style.top);
      flight.dispose();
    });

    it("holds both identities while the jettison pod is used and cools down", () => {
      const { boost, jettison, root } = place();
      const boostBtn = root.querySelector<HTMLElement>(".hud-boost-btn")!;
      const jettisonBtn = root.querySelector<HTMLElement>(".hud-jettison-btn")!;
      const before = [identityOf(boostBtn), identityOf(jettisonBtn)];
      boost.update({ hardpointIndex: 2, active: false, energy: 30, energyCapacity: 55, blocked: false });
      jettison.update({ fitted: true, cooldownSec: 0, cooldownTotalSec: 30 });
      // Pod away: the jettison button spends the next 30 s on cooldown, which is
      // the state change the owner saw the two controls swap identity across.
      jettisonBtn.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
      jettison.update({ fitted: true, cooldownSec: 15, cooldownTotalSec: 30 });
      expect(jettisonBtn.classList).toContain("disabled");
      // BOOST is untouched by any of it, and neither button has borrowed the
      // other's number, glyph slot or position.
      expect(boostBtn.classList).not.toContain("disabled");
      expect([identityOf(boostBtn), identityOf(jettisonBtn)]).toEqual(before);
      boost.dispose();
      jettison.dispose();
    });
  });

  describe("slot captions and countdown formatting", () => {
    it("names the KIND on the button, falling back to the family when a word is too long", () => {
      expect(moduleSlotTypeLabel({ name: "Pulse Laser Mk I", family: "laser", ui: { icon: "L", label: "Laser", shortName: "Pulse Mk1" } }, "x")).toBe("PULSE");
      // "Deflector" does not fit, and a clipped "DEFLECT" says less than the
      // family word does.
      expect(moduleSlotTypeLabel({ name: "Deflector Shield Mk I", family: "shield", ui: { icon: "S", label: "Shield" } }, "x")).toBe("SHIELD");
    });

    it("prints whole seconds above one and tenths below it", () => {
      expect(formatRemainingSec(2.1)).toBe("3");
      expect(formatRemainingSec(1)).toBe("1");
      expect(formatRemainingSec(0.94)).toBe("0.9");
    });

    it("calls the last quarter of a magazine low, never fewer than one round", () => {
      expect(lowAmmoThreshold(24)).toBe(6);
      expect(lowAmmoThreshold(4)).toBe(1);
      expect(lowAmmoThreshold(1)).toBe(1);
    });
  });

  it("draws a SUPPORT PULSE's cooldown on the same ring a weapon and a collapsed shield use", () => {
    // The pulse (2026-08-22) banks its cooldown on the same replicated
    // `cycleTimer`, so the rail needs no fourth kind of ring — but it does need
    // to know the module's cooldown TOTAL, or the sweep would be a fraction of
    // a cycle time the module does not have.
    const root = document.createElement("div");
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order: vi.fn() } as unknown as GameSession, 1);
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.ray-slow-mk1", state: "retracted", cycleTimer: 3 },
    ]));
    const ray = root.querySelector<HTMLElement>('[aria-label="01 Tether Ray Mk I"]')!;
    // 3 s left of a 12 s cooldown ⇒ three quarters of the way back to ready.
    expect(ray.classList).toContain("ring-cooldown");
    expect(ray.classList).toContain("on-cooldown");
    expect(ray.style.getPropertyValue("--ring")).toBe("75");
    expect(root.querySelector<HTMLElement>(".cooldown-secs")!.textContent).toBe("3");

    // Cold to ready: the ring and the countdown both clear, and the button goes
    // back to having no ring at all (a pulse carries no energy tank).
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.ray-slow-mk1", state: "retracted", cycleTimer: 0 },
    ]));
    expect(ray.classList).not.toContain("ring-cooldown");
    expect(ray.classList).not.toContain("on-cooldown");
    expect(root.querySelector<HTMLElement>(".cooldown-secs")!.hidden).toBe(true);
    buttons.dispose();
  });

  it("gives a support pulse a UTILITY-cluster button whose tap is one moduleToggle", () => {
    const root = document.createElement("div");
    const order = vi.fn();
    const buttons = new ModuleButtons(root, fakeConfigs(), {} as EventBus<ConfigEvents>, { order } as unknown as GameSession, 1);
    buttons.update(snapshotWithModules([
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: "active" },
      { hardpointIndex: 3, moduleId: "module.ray-slow-mk1", state: "retracted" },
    ]));
    const ray = root.querySelector<HTMLElement>('[aria-label="01 Tether Ray Mk I"]')!;
    expect(ray.dataset["side"]).toBe("utilities");
    ray.dispatchEvent(new Event("click", { bubbles: true }));
    // ONE toggle, carrying the true hardpoint index — the pulse rides the order
    // the deployables already send (see AbilitySystem for why).
    expect(order).toHaveBeenCalledTimes(1);
    expect(order).toHaveBeenCalledWith({ kind: "moduleToggle", hardpointIndex: 3 });
    buttons.dispose();
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
