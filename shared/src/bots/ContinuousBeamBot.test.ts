import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import type { SimEvent } from "../sim/events.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";

const DT = 1 / 30;
// 160s: half-damage beams (owner 2026-08-05) already needed a long channel, and
// the damage-type triangle halves them again against plating — the beam is
// ENERGY, so only 0.5 of its DPS reaches an unshielded hull. This test is about
// whether a bot can convert a lock into a kill by channelling at all, not about
// how fast, so the budget grows with the mechanic rather than the mechanic
// bending to the budget.
const SECONDS = 160;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * `decideFire` already produces a level-triggered HELD flag (COMBAT-REWORK.md
 * §7), and a continuous weapon consumes exactly that flag — so a bot needs no
 * new decision code to use one. This is the proof: an ordinary bot profile,
 * driven through the ordinary order path, fitted with ONLY the continuous beam,
 * has to convert its lock into a kill. If channelling ever needed a bespoke bot
 * rule, this fails.
 */
describe("a bot fitted with a continuous beam", () => {
  it("channels its way to a kill against a stationary dummy", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots", 11);
    const profile = configs.get<BotprofileConfig>("botprofile", "bot.aggressive")!;

    // One hardpoint, one weapon: any hull the dummy loses to a ship came from
    // the beam, so the kill is unambiguously attributable to the channel.
    const bot = sim.spawnPlayer("ship.interceptor", ["module.beamlaser-mk1"], 0);
    const dummy = sim.spawnPlayer("ship.interceptor", ["module.laser-mk1"], 1);
    const driver = new BotDriver({ entityId: bot, profile, configs, rng: deriveRng(11, bot) });

    const events: SimEvent[] = [];
    let nowMs = 0;
    let channelledTicks = 0;
    let fireEvents = 0;
    let damageEvents = 0;

    for (let i = 0; i < SECONDS / DT; i++) {
      if (!sim.hasShip(dummy)) break;
      nowMs += DT * 1000;
      const snapshot = sim.snapshot();
      // The dummy is never ordered, so it never moves and never fires.
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(bot, order);
      sim.tick(DT);
      const beam = sim.world.modules.get(bot)?.modules[0];
      if (beam?.channeling) channelledTicks++;
      for (const ev of sim.getEvents()) {
        events.push(ev);
        if (ev.type === "projectileFired") fireEvents++;
        if (ev.type === "damage" && ev.sourceId === bot) damageEvents++;
      }
    }

    const kill = events.find(
      (ev) => ev.type === "entityDestroyed" && !ev.isAsteroid && ev.entityId === dummy,
    );
    expect(kill).toBeDefined();
    expect(kill).toMatchObject({ killerId: bot });

    // It got there by channelling, not by some other path.
    expect(channelledTicks).toBeGreaterThan(30);
    // And the event volume stayed sane: a channel emits one fire event per
    // trigger pull and banks its damage at ~4 Hz, so both counters must be a
    // small fraction of the ticks actually spent channelling.
    expect(fireEvents).toBeLessThan(channelledTicks / 2);
    expect(damageEvents).toBeLessThan(channelledTicks / 2);
  });
});
