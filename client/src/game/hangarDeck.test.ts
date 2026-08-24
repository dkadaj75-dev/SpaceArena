import { describe, expect, it } from "vitest";
import type { ModuleConfig } from "@space-arena/shared";
import {
  deckCompareRows,
  deckPower,
  groupModuleLines,
  moduleCode,
  moduleLineKey,
  moduleLineName,
  radialLayout,
  radialScale,
  slotLabel,
  RADIAL_STAGGER_MS,
} from "./hangarDeck.js";
import type { HangarStatPanel } from "./hangarStats.js";

/**
 * The loadout deck's arithmetic and string work, driven without a DOM. The
 * screen's own wiring is covered in `screens/Hangar.test.ts`; everything here is
 * the part that has to be right BEFORE a pixel is drawn.
 */

const mod = (id: string, name: string): Pick<ModuleConfig, "id" | "name"> => ({ id, name } as ModuleConfig);

describe("module codes", () => {
  it("takes the initials of the first two significant words", () => {
    expect(moduleCode(mod("module.laser-mk1", "Pulse Laser Mk I"))).toBe("PL");
    expect(moduleCode(mod("module.laser-mk3", "Pulse Laser Mk III"))).toBe("PL");
    expect(moduleCode(mod("module.missile-heavy", "Heavy Seeker Rack"))).toBe("HS");
    expect(moduleCode(mod("module.kinetic-longbarrel", "Long-Barrel Cannon"))).toBe("LB");
  });

  it("drops tier tokens so a mark never becomes the code", () => {
    // "Purity III" is the whole tail of an alloy's name; the line is the module.
    expect(moduleCode(mod("module.alloy-lunar-p3", "Lunar Alloy Purity III"))).toBe("LA");
    expect(moduleCode(mod("module.sensors-sharpshooter-mk2", "Sharpshooter Mark II"))).toBe("SH");
  });

  it("still answers for a one-word name, an empty one, and nothing at all", () => {
    expect(moduleCode(mod("module.autocannon", "Autocannon"))).toBe("AU");
    expect(moduleCode(mod("module.mystery-widget", "Mk II"))).toBe("WI");
    expect(moduleCode(undefined)).toBe("--");
  });

  it("is stable — the same module always reads the same", () => {
    const cfg = mod("module.shield-mk1", "Deflector Shield Mk I");
    expect(moduleCode(cfg)).toBe(moduleCode(cfg));
  });
});

describe("module lines", () => {
  const line = (id: string, name: string, level: number) => ({ id, name, level });

  it("collapses a ladder of marks into one line", () => {
    const lines = groupModuleLines([
      line("module.laser-mk1", "Pulse Laser Mk I", 1),
      line("module.laser-mk3", "Pulse Laser Mk III", 3),
      line("module.laser-mk2", "Pulse Laser Mk II", 2),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ key: "module.laser", name: "Pulse Laser", code: "PL" });
    // Lowest mark first — a line is read as a ladder, not as an alphabet.
    expect(lines[0]!.tiers.map((t) => t.id)).toEqual([
      "module.laser-mk1",
      "module.laser-mk2",
      "module.laser-mk3",
    ]);
  });

  it("reads every tier suffix the content pack uses", () => {
    expect(moduleLineKey({ id: "module.alloy-earth-p4" })).toBe("module.alloy-earth");
    expect(moduleLineKey({ id: "module.engine-earth-eng2" })).toBe("module.engine-earth");
    expect(moduleLineKey({ id: "module.sensors-common-mk3" })).toBe("module.sensors-common");
    // No suffix is a line of one, not a line called "".
    expect(moduleLineKey({ id: "module.kinetic-longbarrel" })).toBe("module.kinetic-longbarrel");
  });

  it("keeps lines that only look alike apart", () => {
    const lines = groupModuleLines([
      line("module.alloy-earth-p1", "Earth Alloy Purity I", 1),
      line("module.alloy-lunar-p1", "Lunar Alloy Purity I", 1),
      line("module.laser-burst", "Burst Pulse Laser", 1),
    ]);
    // Same level, so the order is the name order the picker has always used.
    expect(lines.map((l) => l.key)).toEqual([
      "module.laser-burst",
      "module.alloy-earth",
      "module.alloy-lunar",
    ]);
    expect(lines.map((l) => l.name)).toEqual(["Burst Pulse Laser", "Earth Alloy", "Lunar Alloy"]);
  });

  it("never strips a name down to nothing", () => {
    expect(moduleLineName({ id: "module.mystery", name: "Mk II" })).toBe("Mk II");
  });
});

describe("slot labels", () => {
  it("reads the real socket ids the hulls author", () => {
    expect(slotLabel("hp-nose")).toBe("HP-NOSE");
    expect(slotLabel("hp-wing-l")).toBe("HP-WING L");
    // The CORE / INTERNAL heading already says which bay these are.
    expect(slotLabel("in-engine")).toBe("ENGINE");
    expect(slotLabel("in-countermeasure")).toBe("COUNTERMEASURE");
    expect(slotLabel("odd_socket")).toBe("ODD_SOCKET");
  });
});

// --- compare rows -----------------------------------------------------------

function panel(over: Partial<HangarStatPanel> = {}): HangarStatPanel {
  return {
    hullMax: 145,
    nominalSpeed: 22,
    energyReserve: 0,
    rechargeMult: 1,
    dps: 12,
    sustainedDps: 12,
    ehpApprox: 180,
    resistKinetic: 0.15,
    resistEnergy: 0.2,
    shieldEfficiency: 1,
    powerCapacity: 12,
    powerDrawTotal: 6,
    powerDrawRetracted: 6,
    powerOverSubscribed: false,
    ...over,
  };
}

describe("before / after compare rows", () => {
  it("reads the fit as it stands when nothing is being considered", () => {
    const rows = deckCompareRows(panel(), null);
    expect(rows.map((r) => r.label)).toEqual(["INTEGRITY", "SPEED", "DPS", "POWER"]);
    expect(rows.map((r) => r.value)).toEqual(["145", "22.0", "12.0", "6 / 12"]);
    expect(rows.every((r) => r.projected === null && r.arrow === null)).toBe(true);
  });

  it("marks a candidate that helps as better and one that hurts as worse", () => {
    const rows = deckCompareRows(panel(), panel({ hullMax: 185, dps: 9 }));
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get("INTEGRITY")).toMatchObject({ projected: "185", arrow: "▲", trend: "better" });
    expect(byLabel.get("DPS")).toMatchObject({ projected: "9.0", arrow: "▼", trend: "worse" });
    // Nothing moved SPEED, so it says nothing rather than repeating itself.
    expect(byLabel.get("SPEED")!.projected).toBeNull();
  });

  it("stays quiet about a change its own rounding would hide", () => {
    // A half-point of rail: real, but "5 / 12 ▲ 5 / 12" reads as a bug.
    const rows = deckCompareRows(panel({ powerDrawTotal: 4.6 }), panel({ powerDrawTotal: 5.4 }));
    expect(rows.find((r) => r.label === "POWER")!.projected).toBeNull();
  });

  it("keeps POWER neutral until the fit would break the rail", () => {
    const within = deckCompareRows(panel(), panel({ powerDrawTotal: 9 }));
    expect(within.find((r) => r.label === "POWER")).toMatchObject({
      projected: "9 / 12",
      arrow: "▲",
      trend: "none",
      warn: false,
    });

    const over = deckCompareRows(panel(), panel({ powerDrawTotal: 15, powerOverSubscribed: true }));
    expect(over.find((r) => r.label === "POWER")).toMatchObject({ projected: "15 / 12", warn: true });
  });
});

// --- power pips -------------------------------------------------------------

describe("power pips", () => {
  it("draws one pip per point of capacity, filled to the draw", () => {
    const power = deckPower(panel({ powerCapacity: 12, powerDrawTotal: 5 }));
    expect(power.pips).toHaveLength(12);
    expect(power.pips.filter((p) => p === "filled")).toHaveLength(5);
    expect(power.pips.filter((p) => p === "empty")).toHaveLength(7);
    expect(power.text).toBe("5 / 12");
    expect(power.over).toBe(false);
  });

  it("turns EVERY filled pip red once the fit outruns the rail", () => {
    const power = deckPower(panel({ powerCapacity: 10, powerDrawTotal: 14, powerOverSubscribed: true }));
    expect(power.over).toBe(true);
    // Over-subscription is a property of the whole fit, not of the pips past the
    // line — there are none, the bar is already full.
    expect(power.pips).toEqual(Array.from({ length: 10 }, () => "over"));
    expect(power.text).toBe("14 / 10");
  });

  it("survives a hull with no rail at all", () => {
    expect(deckPower(panel({ powerCapacity: 0, powerDrawTotal: 0 })).pips).toEqual([]);
  });
});

// --- radial geometry --------------------------------------------------------

describe("radial layout", () => {
  it("fans a small menu upward, exactly as the design specifies", () => {
    const { seats, outerRadiusPx } = radialLayout(5);
    expect(seats).toHaveLength(5);
    // radius = max(92, ceil((n + 1) * 76 / π))
    expect(outerRadiusPx).toBe(146);
    // Every seat is ABOVE the centre (screen y grows downward) and they run
    // left to right.
    expect(seats.every((s) => s.yPx <= 0)).toBe(true);
    expect(seats.map((s) => s.xPx)).toEqual([...seats.map((s) => s.xPx)].sort((a, b) => a - b));
    // The middle item sits straight up.
    expect(seats[2]).toMatchObject({ xPx: 0, yPx: -146 });
  });

  it("staggers the entrance by 25ms per item, in order", () => {
    expect(radialLayout(4).seats.map((s) => s.delayMs)).toEqual([0, 25, 50, 75].map((d) => (d / 25) * RADIAL_STAGGER_MS));
  });

  it("keeps adjacent centres at least one item apart", () => {
    for (const n of [2, 3, 5, 8, 9]) {
      const { seats } = radialLayout(n);
      for (let i = 1; i < seats.length; i++) {
        const dx = seats[i]!.xPx - seats[i - 1]!.xPx;
        const dy = seats[i]!.yPx - seats[i - 1]!.yPx;
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(74); // 76px, less rounding
      }
    }
  });

  it("wraps a big menu onto concentric arcs instead of one enormous fan", () => {
    // A hardpoint accepts six families, so the real catalogue can offer twenty
    // candidates — a single fan would want a 508px radius.
    const { seats, outerRadiusPx } = radialLayout(20);
    expect(seats).toHaveLength(20);
    expect(outerRadiusPx).toBeLessThan(508);
    const radii = new Set(seats.map((s) => Math.round(Math.hypot(s.xPx, s.yPx))));
    expect(radii.size).toBeGreaterThan(1);
  });

  it("has nothing to place for an empty menu", () => {
    expect(radialLayout(0).seats).toEqual([]);
  });
});

describe("radial scale", () => {
  it("never blows the design's sizes up, only down to fit", () => {
    expect(radialScale(146, 900, 800)).toBe(1);
    const cramped = radialScale(146, 420, 300);
    expect(cramped).toBeLessThan(1);
    expect(cramped).toBeGreaterThan(0);
  });
});
