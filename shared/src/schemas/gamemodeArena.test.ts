import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { arenaSchema } from "./arena.js";
import { gamemodeSchema } from "./gamemode.js";
import { arenaChoicesOf, pickArena } from "./gamemodeArena.js";

const CONTENT = resolve(fileURLToPath(new URL("../../../content", import.meta.url)));

async function json(rel: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(CONTENT, rel), "utf8"));
}

describe("arenaChoicesOf", () => {
  it("returns nothing for a mode that names no arena at all", () => {
    expect(arenaChoicesOf(undefined)).toEqual([]);
    expect(arenaChoicesOf({ defaultArena: undefined, arenaPool: undefined })).toEqual([]);
  });

  it("treats a lone defaultArena as a one-map rotation", () => {
    expect(arenaChoicesOf({ defaultArena: "arena.lunar-rift", arenaPool: undefined })).toEqual(["arena.lunar-rift"]);
  });

  it("includes the pinned map in its own rotation, and never twice", () => {
    // Authoring the default inside the pool as well must not weight it double.
    expect(
      arenaChoicesOf({ defaultArena: "arena.ring-nebula", arenaPool: ["arena.ring-nebula", "arena.parker-point"] }),
    ).toEqual(["arena.ring-nebula", "arena.parker-point"]);
  });

  it("keeps the pinned map first even when the pool omits it", () => {
    expect(arenaChoicesOf({ defaultArena: "arena.ring-nebula", arenaPool: ["arena.parker-point"] })).toEqual([
      "arena.ring-nebula",
      "arena.parker-point",
    ]);
  });
});

describe("pickArena", () => {
  const two = ["arena.ring-nebula", "arena.parker-point"];

  it("splits the unit interval evenly across the choices", () => {
    expect(pickArena(two, 0)).toBe("arena.ring-nebula");
    expect(pickArena(two, 0.49)).toBe("arena.ring-nebula");
    expect(pickArena(two, 0.5)).toBe("arena.parker-point");
    expect(pickArena(two, 0.9999)).toBe("arena.parker-point");
  });

  it("never indexes off the end for a degenerate roll", () => {
    // Math.random() cannot return 1, but a caller-injected roll can.
    expect(pickArena(two, 1)).toBe("arena.parker-point");
    expect(pickArena(two, 1.5)).toBe("arena.parker-point");
    expect(pickArena(two, -3)).toBe("arena.ring-nebula");
    expect(pickArena(two, Number.NaN)).toBe("arena.ring-nebula");
  });

  it("has nothing to pick from an empty rotation", () => {
    expect(pickArena([], 0.5)).toBeUndefined();
  });
});

describe("shipped map rotation (owner 2026-08-21)", () => {
  it("rotates deathmatch between the two nebula arenas and leaves CTF pinned", async () => {
    const dm = ["duel-1v1", "practice-bots-1v1", "practice-bots-5v5", "practice-bots", "practice-duel-titans-1v1"];
    for (const name of dm) {
      const mode = gamemodeSchema.parse(await json(`gamemodes/${name}.json`));
      expect(arenaChoicesOf(mode), name).toEqual(["arena.ring-nebula", "arena.parker-point"]);
    }
    // CTF lives on the rift and must not roll onto an arena with no flag bases.
    const ctf = gamemodeSchema.parse(await json("gamemodes/practice-ctf-5v5.json"));
    expect(arenaChoicesOf(ctf)).toEqual(["arena.lunar-rift"]);
    // The tutorial's scripted steps assume one map.
    const tutorial = gamemodeSchema.parse(await json("gamemodes/tutorial.json"));
    expect(arenaChoicesOf(tutorial)).toEqual(["arena.ring-nebula"]);
  });

  it("gives every rotating arena the flag bases CTF would need if it ever joined them", async () => {
    // Not a CTF requirement today — a guard for the day someone adds the pool
    // to a capture mode: both nebula arenas already author bases, so the
    // rotation cannot strand a flag mode on a map with nowhere to score.
    for (const file of ["arenas/ring-nebula.json", "arenas/parker-point.json"]) {
      const arena = arenaSchema.parse(await json(file));
      expect(arena.flagBases?.length ?? 0, file).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Parker Point", () => {
  it("is Ring Nebula's play space with the sun in place of the gas giant", async () => {
    const parker = arenaSchema.parse(await json("arenas/parker-point.json"));
    const ring = arenaSchema.parse(await json("arenas/ring-nebula.json"));

    // Same fight, different sky: bounds, spawns and rocks are Ring Nebula's.
    expect(parker.bounds).toEqual(ring.bounds);
    expect(parker.spawnPoints).toEqual(ring.spawnPoints);
    expect(parker.asteroidPlacements).toEqual(ring.asteroidPlacements);

    // Its own panorama, and a DRAWN star rather than a painted gas giant.
    expect(parker.render?.skybox.texture).toBe("skyboxes/parker-point.webp");
    expect(parker.render?.star).toBeDefined();
    expect(ring.render?.star).toBeUndefined();

    // The drawn star and the key light must point the same way, or the hull is
    // lit from somewhere the player can see there is no sun.
    expect(parker.render?.star?.dir).toEqual(parker.render?.skybox.sun?.dir);
  });

  it("lights both deathmatch arenas brighter than the pre-2026-08-21 rig", async () => {
    // Ships render with punctual lights only (no IBL), so the DIRECTIONAL key
    // is the number that actually lightens a hull. These were 0.9 / 0.4.
    for (const file of ["arenas/ring-nebula.json", "arenas/parker-point.json"]) {
      const arena = arenaSchema.parse(await json(file));
      expect(arena.lighting?.directionalIntensity ?? 0, file).toBeGreaterThan(0.9);
      expect(arena.lighting?.ambientIntensity ?? 0, file).toBeGreaterThan(0.4);
      expect(arena.render?.skybox.intensity ?? 0, file).toBeGreaterThan(0.92);
    }
  });
});
