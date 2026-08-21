import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { collectReferences, validateConfig, type ConfigRef } from "./index.js";
import { gamemodeSchema } from "./gamemode.js";
import { hardpointsOf, shipSchema } from "./ship.js";
import { moduleSchema, type ModuleConfig } from "./module.js";
import { BASICS_TUTORIAL_ID, tutorialSchema, type TutorialConfig } from "./tutorial.js";

const CONTENT_ROOT = fileURLToPath(new URL("../../../content/", import.meta.url));

function load(relPath: string): unknown {
  return JSON.parse(readFileSync(CONTENT_ROOT + relPath, "utf8")) as unknown;
}

/** The smallest thing the schema will accept — every test below mutates a clone. */
function minimal(): Record<string, unknown> {
  return {
    id: "tutorial.minimal",
    type: "tutorial",
    version: 1,
    gamemode: "gamemode.tutorial",
    pilot: { ship: "ship.interceptor", fitting: ["module.laser-mk1"] },
    completeToast: "Done.",
    steps: [
      {
        id: "throttle",
        stage: "flight",
        title: "THROTTLE",
        text: "Push it up.",
        condition: { kind: "throttle-above", value: 0.5 },
      },
    ],
  };
}

describe("tutorial schema", () => {
  it("accepts a minimal tutorial through the type registry", () => {
    const result = validateConfig(minimal());
    expect(result.success).toBe(true);
    expect(result.type).toBe("tutorial");
  });

  it("defaults the instructor so a pack never has to name one", () => {
    expect(tutorialSchema.parse(minimal()).instructor).toBe("ARENA COMMAND");
  });

  it("rejects a tutorial with no steps at all", () => {
    const empty = { ...minimal(), steps: [] };
    expect(tutorialSchema.safeParse(empty).success).toBe(false);
  });

  it("rejects a step id that is not a slug", () => {
    const draft = minimal();
    (draft["steps"] as Record<string, unknown>[])[0]!["id"] = "Step One";
    expect(tutorialSchema.safeParse(draft).success).toBe(false);
  });

  it("rejects an unknown completion condition", () => {
    const draft = minimal();
    (draft["steps"] as Record<string, unknown>[])[0]!["condition"] = { kind: "vibes" };
    expect(tutorialSchema.safeParse(draft).success).toBe(false);
  });

  it("rejects a highlight the client has no control for", () => {
    const draft = minimal();
    (draft["steps"] as Record<string, unknown>[])[0]!["highlight"] = ".hud-throttle-track";
    expect(tutorialSchema.safeParse(draft).success).toBe(false);
  });

  it("defaults a spawn's distance and team so content only says what it means", () => {
    const draft = minimal();
    (draft["steps"] as Record<string, unknown>[])[0]!["spawn"] = { role: "dummy", ship: "ship.support" };
    const parsed = tutorialSchema.parse(draft);
    expect(parsed.steps[0]!.spawn).toMatchObject({ aheadDistance: 45, team: 1 });
  });
});

describe("tutorial references", () => {
  function refsOf(config: TutorialConfig): ConfigRef[] {
    return collectReferences(config);
  }

  it("resolves the mode, the hull, every fitted module and every spawn", () => {
    const draft = minimal();
    draft["arena"] = "arena.ring-nebula";
    (draft["steps"] as Record<string, unknown>[])[0]!["spawn"] = {
      role: "bot",
      ship: "ship.brawler",
      profile: "bot.tutorial",
      fitting: ["module.laser-mk1", null],
    };
    const refs = refsOf(tutorialSchema.parse(draft));
    expect(refs).toContainEqual({ path: "gamemode", id: "gamemode.tutorial", expects: "gamemode" });
    expect(refs).toContainEqual({ path: "arena", id: "arena.ring-nebula", expects: "arena" });
    expect(refs).toContainEqual({ path: "pilot.ship", id: "ship.interceptor", expects: "ship" });
    expect(refs).toContainEqual({ path: "pilot.fitting[0]", id: "module.laser-mk1", expects: "module" });
    expect(refs).toContainEqual({ path: "steps[0].spawn.ship", id: "ship.brawler", expects: "ship" });
    expect(refs).toContainEqual({ path: "steps[0].spawn.profile", id: "bot.tutorial", expects: "botprofile" });
    expect(refs).toContainEqual({ path: "steps[0].spawn.fitting[0]", id: "module.laser-mk1", expects: "module" });
  });

  it("does not emit a reference for an empty fitting slot", () => {
    const draft = minimal();
    draft["pilot"] = { ship: "ship.interceptor", fitting: [null, "module.laser-mk1"] };
    const paths = refsOf(tutorialSchema.parse(draft)).map((r) => r.path);
    expect(paths).not.toContain("pilot.fitting[0]");
    expect(paths).toContain("pilot.fitting[1]");
  });
});

/**
 * The shipped flow, checked against the pack it flies in. A tutorial is the one
 * content config whose failure mode is invisible to the schema AND to reference
 * resolution: a fitting that the hull's sockets refuse throws at spawn, and a
 * lesson about a shield on a ship with no shield simply cannot be completed.
 */
describe("shipped tutorial — flight school", () => {
  const parsed = tutorialSchema.safeParse(load("tutorials/basics.json"));
  expect(parsed.success, "tutorials/basics.json must validate").toBe(true);
  if (!parsed.success) throw parsed.error;
  const tutorial = parsed.data;

  it("is the id the client reaches for", () => {
    expect(tutorial.id).toBe(BASICS_TUTORIAL_ID);
  });

  it("is the shipped offline gamemode", () => {
    const mode = gamemodeSchema.parse(load("gamemodes/tutorial.json"));
    expect(mode.launch).toBe("offline");
    // No roster: every ship in flight school is spawned by the step that needs it.
    expect(mode.bots?.roster ?? []).toHaveLength(0);
    // No rewards, no clock, and nothing that can end the match under the
    // director's feet.
    expect(mode.rewards).toEqual({ win: 0, loss: 0, perKill: 0 });
    expect(mode.timeLimitCapSec).toBeUndefined();
    expect(mode.eliminationEndsMatch).toBe(false);
    expect(mode.respawn.enabled).toBe(false);
  });

  it("puts the student in a fitting the hull actually accepts", () => {
    const ship = shipSchema.parse(load("ships/interceptor.json"));
    expect(tutorial.pilot.ship).toBe(ship.id);
    const hardpoints = hardpointsOf(ship);
    expect(tutorial.pilot.fitting.length).toBeLessThanOrEqual(hardpoints.length);
    tutorial.pilot.fitting.forEach((moduleId, index) => {
      if (!moduleId) return;
      const slug = moduleId.slice("module.".length);
      const mod = moduleSchema.parse(load(`modules/${slug}.json`)) as ModuleConfig;
      expect(hardpoints[index]!.accepts, `${moduleId} in slot ${index}`).toContain(mod.family);
    });
  });

  it("actually fits what its lessons talk about", () => {
    const families = tutorial.pilot.fitting
      .filter((id): id is string => Boolean(id))
      .map((id) => moduleSchema.parse(load(`modules/${id.slice("module.".length)}.json`)).family);
    // The gunnery lesson needs a weapon, the energy lesson a shield.
    expect(families).toContain("laser");
    expect(families).toContain("shield");
  });

  it("teaches the audited gaps in order: throttle, steering, guns, energy, lock", () => {
    const kinds = tutorial.steps.map((s) => s.condition.kind);
    expect(kinds.indexOf("throttle-above")).toBe(0);
    expect(kinds.indexOf("heading-changed")).toBeGreaterThan(kinds.indexOf("throttle-above"));
    expect(kinds.indexOf("fired")).toBeGreaterThan(kinds.indexOf("heading-changed"));
    expect(kinds.indexOf("module-toggled")).toBeGreaterThan(kinds.indexOf("fired"));
    expect(kinds.indexOf("lock-acquired")).toBeGreaterThan(kinds.indexOf("module-toggled"));
  });

  it("spawns the disarmed hulk first and the live drone second", () => {
    const spawns = tutorial.steps.flatMap((s) => (s.spawn ? [s.spawn] : []));
    expect(spawns.map((s) => s.role)).toEqual(["dummy", "bot"]);
    // The hulk is disarmed by ABSENCE: no profile means no driver, and no
    // driver means it never manoeuvres and never pulls a trigger.
    expect(spawns[0]!.profile).toBeUndefined();
    expect(spawns[0]!.fitting).toBeUndefined();
    expect(spawns[1]!.profile).toBe("bot.tutorial");
    // Both come in pre-wrecked: the shipped hulls are balanced for an 8–45 s
    // duel, which is longer than the whole tutorial is meant to be.
    for (const spawn of spawns) expect(spawn.hull).toBeLessThan(60);
  });

  it("ends on the shop, and only the last step can be clicked past", () => {
    const last = tutorial.steps[tutorial.steps.length - 1]!;
    expect(last.stage).toBe("shop");
    expect(last.condition.kind).toBe("acknowledged");
    const clickable = tutorial.steps.filter((s) => s.condition.kind === "acknowledged");
    expect(clickable).toHaveLength(1);
  });

  it("walks the stages forward: flight, then the menu, the hangar and the shop", () => {
    const stages = [...new Set(tutorial.steps.map((s) => s.stage))];
    expect(stages).toEqual(["flight", "lobby", "hangar", "shop"]);
  });

  it("stays short — every step is a beat, not a syllabus", () => {
    expect(tutorial.steps.length).toBeLessThanOrEqual(12);
    for (const step of tutorial.steps) {
      expect(step.text.length, `${step.id} instruction`).toBeLessThanOrEqual(180);
    }
  });
});
