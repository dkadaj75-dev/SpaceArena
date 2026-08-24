import { describe, expect, it } from "vitest";
import { TURN_SIGN_FOR_SCREEN_RIGHT } from "../chaseCamera.js";
import type { ConfigService, ModuleSnapshot } from "@space-arena/shared";
import { carriesFlag, firstBoostModuleIndex, isTextEntry } from "./FlightControls.js";
import { resolveHudSlotCounts } from "./ModuleButtons.js";
import {
  flightKeyOf,
  keyAxesFrom,
  mapRelativeSteer,
  pitchFromStick,
  rampThrottle,
  throttleFromPointer,
  throttleFromWheel,
  thumbTopPx,
  turnFromStick,
} from "./flightInput.js";

/**
 * The pure input mappings behind the flight HUD (FLIGHT.md §4). The turn SIGN is
 * cross-checked against the rig's geometry in `chaseCamera.test.ts`; here we pin
 * the shaping (deadzone / expo / clamping) around it.
 */
describe("turnFromStick", () => {
  it("maps a stick pushed right to the screen-right turn sign, and left to its negation", () => {
    expect(Math.sign(turnFromStick(1, 0, 1))).toBe(TURN_SIGN_FOR_SCREEN_RIGHT);
    expect(Math.sign(turnFromStick(-1, 0, 1))).toBe(-TURN_SIGN_FOR_SCREEN_RIGHT);
    expect(turnFromStick(1, 0, 1)).toBe(TURN_SIGN_FOR_SCREEN_RIGHT);
  });

  it("is exactly centred: a stick at rest is a straight line", () => {
    expect(turnFromStick(0, 0.12, 1.35)).toBe(0);
  });

  it("treats deflection inside the deadzone as centre and re-normalizes the rest", () => {
    expect(turnFromStick(0.1, 0.12, 1)).toBe(0);
    expect(turnFromStick(0.12, 0.12, 1)).toBe(0);
    // Halfway through the LIVE travel (0.12 → 1) is half a turn, not 0.56.
    expect(Math.abs(turnFromStick(0.56, 0.12, 1))).toBeCloseTo(0.5, 9);
    // The rim always means the hardest turn, whatever the deadzone.
    expect(Math.abs(turnFromStick(1, 0.12, 1))).toBeCloseTo(1, 9);
  });

  it("shapes magnitude with expo but never flips the sign", () => {
    const linear = Math.abs(turnFromStick(0.5, 0, 1));
    const shaped = Math.abs(turnFromStick(0.5, 0, 2));
    expect(shaped).toBeLessThan(linear);
    expect(Math.sign(turnFromStick(0.5, 0, 2))).toBe(Math.sign(turnFromStick(0.5, 0, 1)));
    expect(Math.abs(turnFromStick(1, 0, 3))).toBeCloseTo(1, 9);
  });

  it("clamps deflection beyond the base ring instead of exceeding full turn", () => {
    expect(Math.abs(turnFromStick(4, 0, 1))).toBe(1);
    expect(Math.abs(turnFromStick(-4, 0, 1))).toBe(1);
  });
});

/**
 * The bubble's third axis (BUBBLE.md §C). Screen y grows DOWNWARD, so every
 * assertion here is really about one thing: pushing the thumb toward the top of
 * the screen must raise the nose.
 */
describe("pitchFromStick", () => {
  it("climbs when the stick is pushed UP the screen and dives when pushed down", () => {
    expect(pitchFromStick(-1, 0, 1)).toBe(1);
    expect(pitchFromStick(1, 0, 1)).toBe(-1);
  });

  it("is exactly centred: a stick at rest commands no pitch change at all", () => {
    // Not "levels out" — pitch is HELD state in the sim, so 0 means the nose
    // stays where the player left it.
    expect(pitchFromStick(0, 0.12, 1.35)).toBe(0);
  });

  it("mirrors both directions when the player inverts the axis", () => {
    expect(pitchFromStick(-1, 0, 1, true)).toBe(-1);
    expect(pitchFromStick(1, 0, 1, true)).toBe(1);
    // Invert is a pure sign flip: the magnitude (deadzone + expo shaping) is
    // untouched, so the stick feels identical, just the other way up.
    for (const y of [-0.9, -0.4, 0.3, 0.75]) {
      expect(pitchFromStick(y, 0.12, 1.35, true)).toBeCloseTo(-pitchFromStick(y, 0.12, 1.35), 12);
    }
  });

  it("shares the deadzone and re-normalizes the live travel, exactly like turn", () => {
    expect(pitchFromStick(-0.1, 0.12, 1)).toBe(0);
    expect(pitchFromStick(-0.12, 0.12, 1)).toBe(0);
    expect(Math.abs(pitchFromStick(-0.56, 0.12, 1))).toBeCloseTo(0.5, 9);
    expect(pitchFromStick(-1, 0.12, 1)).toBeCloseTo(1, 9);
    // Inside the deadzone there is nothing to invert.
    expect(pitchFromStick(0.1, 0.12, 1, true)).toBe(0);
  });

  it("shapes magnitude with expo but never flips the sign", () => {
    const linear = Math.abs(pitchFromStick(-0.5, 0, 1));
    const shaped = Math.abs(pitchFromStick(-0.5, 0, 2));
    expect(shaped).toBeLessThan(linear);
    expect(Math.sign(pitchFromStick(-0.5, 0, 2))).toBe(1);
    expect(Math.abs(pitchFromStick(-1, 0, 3))).toBeCloseTo(1, 9);
  });

  it("clamps deflection beyond the base ring instead of exceeding full pitch", () => {
    expect(pitchFromStick(-4, 0, 1)).toBe(1);
    expect(pitchFromStick(4, 0, 1)).toBe(-1);
  });

  it("agrees with turnFromStick on the shaping of an equal deflection", () => {
    // One thumb, one ring: a 0.6 push should be the same magnitude of command
    // whichever axis it lands on, or the stick feels lopsided.
    expect(Math.abs(pitchFromStick(0.6, 0.12, 1.35))).toBeCloseTo(
      Math.abs(turnFromStick(0.6, 0.12, 1.35)),
      12,
    );
  });
});

describe("throttleFromPointer", () => {
  const TOP = 100;
  const HEIGHT = 200;

  it("puts 0 % at the bottom of the track and 100 % at the top", () => {
    expect(throttleFromPointer(TOP + HEIGHT, TOP, HEIGHT)).toBe(0);
    expect(throttleFromPointer(TOP, TOP, HEIGHT)).toBe(1);
    expect(throttleFromPointer(TOP + HEIGHT / 2, TOP, HEIGHT)).toBeCloseTo(0.5, 9);
  });

  it("clamps a drag past either end rather than losing the grab", () => {
    expect(throttleFromPointer(TOP - 500, TOP, HEIGHT)).toBe(1);
    expect(throttleFromPointer(TOP + 500, TOP, HEIGHT)).toBe(0);
  });

  it("is inert on a zero-height track (pre-layout)", () => {
    expect(throttleFromPointer(50, 0, 0)).toBe(0);
  });
});

describe("thumbTopPx", () => {
  it("puts the thumb at the bottom of its travel for 0 and the top for 1", () => {
    expect(thumbTopPx(0, 200, 26)).toBe(174);
    expect(thumbTopPx(1, 200, 26)).toBe(0);
    expect(thumbTopPx(0.5, 200, 26)).toBe(87);
  });

  it("never leaves the track when the thumb is taller than the track", () => {
    expect(thumbTopPx(0, 20, 40)).toBe(0);
  });
});

describe("keyAxesFrom / flightKeyOf", () => {
  const NONE = { throttleRamp: 0, fire: false };

  it("binds W/S to held throttle and Space/E to held fire, but not Shift to held boost", () => {
    expect(keyAxesFrom(new Set(["w"]))).toEqual({ ...NONE, throttleRamp: 1 });
    expect(keyAxesFrom(new Set(["s"]))).toEqual({ ...NONE, throttleRamp: -1 });
    expect(keyAxesFrom(new Set(["shift"]))).toEqual(NONE);
    expect(keyAxesFrom(new Set([" "])).fire).toBe(true);
    expect(keyAxesFrom(new Set(["e"])).fire).toBe(true);
  });

  it("retires A/D, arrows, and R/F completely", () => {
    for (const key of ["a", "d", "r", "f", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(flightKeyOf(key)).toBeNull();
      expect(keyAxesFrom(new Set([key.toLowerCase()]))).toEqual(NONE);
    }
  });

  it("cancels opposite keys instead of letting the last press win", () => {
    expect(keyAxesFrom(new Set(["w", "s"])).throttleRamp).toBe(0);
  });

  it("normalizes keys case-insensitively and ignores unbound ones", () => {
    expect(flightKeyOf("W")).toBe("w");
    expect(flightKeyOf("S")).toBe("s");
    expect(flightKeyOf("Shift")).toBe("shift");
    expect(flightKeyOf(" ")).toBe(" ");
    expect(flightKeyOf("E")).toBe("e");
    expect(flightKeyOf("q")).toBeNull();
    expect(flightKeyOf("Enter")).toBeNull();
  });

  it("keeps E out of flight input while the event target is a text editor", () => {
    expect(isTextEntry(document.createElement("input"))).toBe(true);
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    expect(isTextEntry(document.createElement("select"))).toBe(true);
    expect(isTextEntry(document.createElement("canvas"))).toBe(false);
  });

  it("maps E keydown/up through the same normalized held-key path as Space", () => {
    const held = new Set<string>();
    held.add(flightKeyOf("E")!);
    expect(keyAxesFrom(held).fire).toBe(true);
    held.delete(flightKeyOf("e")!);
    expect(keyAxesFrom(held).fire).toBe(false);
  });
});

describe("Shift boost-module lookup", () => {
  const module = (hardpointIndex: number, moduleId: string): ModuleSnapshot => ({
    hardpointIndex,
    moduleId,
    state: "retracted",
    energy: 0,
    energyCapacity: 0,
    stateTimer: 0,
    cycleTimer: 0,
    channeling: false,
    shieldPool: 0,
  });
  const configs = {
    get: (_type: string, id: string) => id.startsWith("module.boost") ? { boost: { speedMult: 1.8 } } : {},
  } as unknown as ConfigService;

  it("selects the first fitted boost module and has no target when none is fitted", () => {
    expect(firstBoostModuleIndex(configs, [
      module(0, "module.laser-mk1"),
      module(3, "module.boost-mk1"),
      module(5, "module.boost-mk2"),
    ])).toBe(1);
    expect(firstBoostModuleIndex(configs, [module(0, "module.laser-mk1")])).toBe(-1);
  });

  /**
   * The shipped afterburner is an `engine` carrying a `boost` block, never a
   * `boost` family. This lookup and `resolveHudSlotCounts` must agree on that or
   * the control is drawn without a slot — the Talon mix-up (2026-08-23).
   */
  it("agrees with the slot counts about which fitted module is the afterburner", () => {
    const engineConfigs = {
      get: (_type: string, id: string) =>
        id.startsWith("module.engine")
          ? { family: "engine", boost: { speedMult: 1.7 } }
          : { family: "laser", fire: { cycleTime: 1 } },
    } as unknown as ConfigService;
    const fitting = [module(0, "module.laser-mk1"), module(2, "module.engine-earth-eng1")];
    expect(firstBoostModuleIndex(engineConfigs, fitting)).toBe(1);
    expect(resolveHudSlotCounts(engineConfigs, fitting).boostSlot).toBe(0);
  });
});

/**
 * The BOOST control greys out for exactly the reason the sim refuses the speed
 * multiplier: a flag carrier has no afterburner (NavigationSystem's
 * `resolveBoostMult`). The HUD reads that off the snapshot's flags, never off a
 * flag on the ship.
 */
describe("carriesFlag", () => {
  const flag = (carrierId: number | null) => ({ carrierId }) as never;

  it("is true only for the ship that is actually holding a flag", () => {
    const snapshot = { flags: [flag(null), flag(7)] };
    expect(carriesFlag(snapshot, 7)).toBe(true);
    expect(carriesFlag(snapshot, 3)).toBe(false);
  });

  it("is false in every mode with no flags at all", () => {
    expect(carriesFlag({ flags: [] }, 7)).toBe(false);
  });
});

describe("mapRelativeSteer", () => {
  it("maps the drag vector radially through deadzone and max radius", () => {
    expect(mapRelativeSteer(5, 0, 10, 100)).toEqual({ turn: 0, pitchStick: 0 });
    expect(Math.abs(mapRelativeSteer(55, 0, 10, 100).turn)).toBeCloseTo(0.5, 9);
    expect(Math.abs(mapRelativeSteer(500, 0, 10, 100).turn)).toBe(1);
  });

  it("preserves circular direction and applies expo to the shared magnitude", () => {
    const linear = mapRelativeSteer(50, -50, 0, 100, 1);
    const curved = mapRelativeSteer(50, -50, 0, 100, 2);
    expect(Math.hypot(linear.turn, linear.pitchStick)).toBeCloseTo(Math.SQRT1_2, 9);
    expect(Math.hypot(curved.turn, curved.pitchStick)).toBeCloseTo(0.5, 9);
    expect(linear.pitchStick).toBeGreaterThan(0);
  });

  it("inverts pitch only", () => {
    const normal = mapRelativeSteer(40, -60, 8, 72, 1.35, false);
    const inverted = mapRelativeSteer(40, -60, 8, 72, 1.35, true);
    expect(inverted.turn).toBe(normal.turn);
    expect(inverted.pitchStick).toBeCloseTo(-normal.pitchStick, 12);
  });
});

describe("rampThrottle", () => {
  it("ramps at the configured rate per second while a key is held", () => {
    expect(rampThrottle(0, 1, 0.9, 1000)).toBeCloseTo(0.9, 9);
    expect(rampThrottle(0.5, -1, 0.9, 500)).toBeCloseTo(0.05, 9);
  });

  it("HOLDS the value when no key is held — the throttle is a lever, not a spring", () => {
    expect(rampThrottle(0.42, 0, 0.9, 1000)).toBe(0.42);
  });

  it("clamps at both ends", () => {
    expect(rampThrottle(0.9, 1, 0.9, 1000)).toBe(1);
    expect(rampThrottle(0.1, -1, 0.9, 1000)).toBe(0);
  });
});

describe("throttleFromWheel", () => {
  it("opens the throttle scrolling up and closes it scrolling down", () => {
    expect(throttleFromWheel(0.5, -100, 0.06)).toBeCloseTo(0.56, 9);
    expect(throttleFromWheel(0.5, 100, 0.06)).toBeCloseTo(0.44, 9);
  });

  it("uses only the SIGN of the delta — one notch is one step on any device", () => {
    // Browsers report a physical notch as anything from 3 to 300; a trackpad
    // streams dozens of tiny events. A proportional mapping would make the step
    // depend on the hardware.
    expect(throttleFromWheel(0.5, -1, 0.06)).toBeCloseTo(throttleFromWheel(0.5, -1200, 0.06), 12);
  });

  it("holds still on a zero delta and clamps at both ends", () => {
    expect(throttleFromWheel(0.42, 0, 0.06)).toBe(0.42);
    expect(throttleFromWheel(1, -100, 0.06)).toBe(1);
    expect(throttleFromWheel(0, 100, 0.06)).toBe(0);
  });
});
