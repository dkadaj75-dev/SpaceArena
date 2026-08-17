import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMAS, CONFIG_TYPES, contentPathFor } from "@space-arena/shared";
import { TEMPLATELESS_TYPES, newConfigId, newConfigOf } from "./newConfig.js";

describe("newConfigId", () => {
  it("picks the first free custom slot for the type", () => {
    expect(newConfigId("ship", [])).toBe("ship.custom-1");
    expect(newConfigId("ship", ["ship.custom-1", "ship.custom-2"])).toBe("ship.custom-3");
    expect(newConfigId("module", ["ship.custom-1"])).toBe("module.custom-1");
  });
});

describe("newConfigOf", () => {
  it("builds a schema-valid config for every type that can exist without references", () => {
    for (const type of CONFIG_TYPES) {
      const config = newConfigOf(type, `${type}.custom-1`);
      if (TEMPLATELESS_TYPES.includes(type)) {
        expect(config, `${type} should defer to duplication`).toBeNull();
        continue;
      }
      expect(config, `${type} should produce a skeleton`).not.toBeNull();
      expect(CONFIG_SCHEMAS[type].safeParse(config).success, `${type} skeleton must validate`).toBe(true);
      expect(config).toMatchObject({ id: `${type}.custom-1`, type, version: 1 });
      // The skeleton must be storable at its canonical content path.
      expect(contentPathFor(config!)).toBe(`${contentPathFor(config!).split("/")[0]}/custom-1.json`);
    }
  });

  it("satisfies constraints a bare schema default cannot reach", () => {
    const ship = newConfigOf("ship", "ship.custom-1") as { sockets: { kind: string }[] };
    expect(ship.sockets.some((socket) => socket.kind === "hardpoint")).toBe(true);

    const arena = newConfigOf("arena", "arena.custom-1") as { spawnPoints: unknown[] };
    expect(arena.spawnPoints.length).toBeGreaterThan(0);

    const upgrade = newConfigOf("upgrade", "upgrade.custom-1") as { levels: unknown[] };
    expect(upgrade.levels.length).toBeGreaterThan(0);
  });

  it("returns null rather than an invalid config when the id is malformed", () => {
    expect(newConfigOf("module", "Not An Id")).toBeNull();
  });
});
