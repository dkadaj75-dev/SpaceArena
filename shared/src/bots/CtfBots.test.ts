import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig, GamemodeConfig, ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import type { SimEvent } from "../sim/events.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";

const DT = 1 / 30;
const CTF = "gamemode.practice-ctf-5v5";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * A full 5v5 capture match driven entirely by bots. This is the proof that the
 * `objective` behaviour actually plays the mode rather than merely existing: no
 * assertion here inspects a bot's internals, only what the match produced.
 */
function playCtf(seed: number, seconds: number) {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", CTF, seed);
  const gamemode = configs.get<GamemodeConfig>("gamemode", CTF)!;
  const profile = configs.get<BotprofileConfig>("botprofile", "bot.flagrunner")!;
  const fitting = configs.get<ShipConfig>("ship", "ship.interceptor")!.defaultFitting;

  const drivers: { id: EntityId; driver: BotDriver }[] = [];
  const enlist = (team: number): void => {
    const id = sim.spawnPlayer("ship.interceptor", fitting, team);
    drivers.push({ id, driver: new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id) }) });
  };
  for (const slot of gamemode.bots?.roster ?? []) {
    for (let i = 0; i < (slot.count ?? 1); i++) enlist(slot.team);
  }
  enlist(0); // the seat a human would take, filled so both sides are five

  const events: SimEvent[] = [];
  let nowMs = 0;
  for (let i = 0; i < Math.round(seconds / DT) && !sim.isEnded; i++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    for (const { id, driver } of drivers) {
      if (!sim.hasShip(id)) continue;
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
    }
    sim.tick(DT);
    events.push(...sim.getEvents());
  }
  return { sim, events };
}

describe("bots play capture the flag (owner 2026-07-31)", () => {
  it("get the flag off its stand and run with it", () => {
    const { events } = playCtf(42, 120);
    const taken = events.filter((e) => e.type === "flagTaken");
    expect(taken.length).toBeGreaterThan(0);
    // A carrier is always an ENEMY of the flag's owner — nobody picks up their
    // own flag off its base.
    for (const ev of taken) {
      if (ev.type !== "flagTaken") continue;
      expect(ev.carrierTeam).not.toBe(ev.flagTeam);
    }
  });

  it("actually score, rather than circling the objective forever", () => {
    const { sim, events } = playCtf(42, 300);
    const captures = events.filter((e) => e.type === "flagCaptured");
    expect(captures.length).toBeGreaterThan(0);
    const scores = sim.snapshot().teamScores;
    expect(scores.reduce((n, s) => n + s.captures, 0)).toBeGreaterThan(0);
  });

  it("leave every flag in a legal state at the end of the run", () => {
    const { sim } = playCtf(11, 120);
    for (const flag of sim.snapshot().flags) {
      if (flag.state === "carried") {
        expect(flag.carrierId).not.toBeNull();
        // A carrier is a live ship on the other side.
        expect(sim.hasShip(flag.carrierId!)).toBe(true);
        expect(sim.teamOf(flag.carrierId!)).not.toBe(flag.team);
      } else {
        expect(flag.carrierId).toBeNull();
      }
      if (flag.state === "home") expect(flag.pos).toEqual(flag.home);
      if (flag.state === "dropped") expect(flag.dropRemaining).toBeGreaterThan(0);
    }
  });

  it("is deterministic — the same seed fields the same match", () => {
    const a = playCtf(5, 60);
    const b = playCtf(5, 60);
    expect(a.sim.snapshot().flags).toEqual(b.sim.snapshot().flags);
    expect(a.sim.snapshot().teamScores).toEqual(b.sim.snapshot().teamScores);
  });
});
