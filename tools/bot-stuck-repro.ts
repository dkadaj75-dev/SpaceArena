import { GameSession } from "../client/src/game/GameSession.js";
import type { BotDecisionSnapshot } from "../shared/src/bots/BotDriver.js";
import type { GamemodeConfig, ShipConfig } from "../shared/src/schemas/index.js";
import type { EntityId } from "../shared/src/sim/components.js";
import { dist3 } from "../shared/src/sim/math.js";
import { loadTestConfigs } from "../shared/src/sim/testutil.js";

const DT = 1 / 30;
const MAX_SEC = Number(process.env.BOT_REPRO_SECONDS ?? 12);
const SEED_COUNT = Number(process.env.BOT_REPRO_SEEDS ?? 5);
const SLOW_SPEED = 0.5;
const STUCK_SEC = 5;
const MODE_ID = process.env.BOT_REPRO_MODE ?? "gamemode.practice-ctf-5v5";
const ROCK_CONFIG_ID = "asteroid.rock-b";

type RosterKind = "heavy-only" | "mixed" | "light-only";
interface BotRow {
  roster: RosterKind;
  seed: number;
  bot: number;
  hull: string;
  class: string;
  colliderRadius: number;
  renderRadius: number;
  colliderClearance: number;
  renderClearance: number;
  clearanceGap: number;
  speed: number;
  throttle: number;
  turn: number;
  pitchStick: number;
  recoveryEntries: number;
  recoveryExits: number;
  stationarySec: number;
  maxStationarySec: number;
  stalled: boolean;
}

const configs = await loadTestConfigs();
const baseMode = configs.get<GamemodeConfig>("gamemode", MODE_ID);
if (!baseMode) throw new Error(`missing shipped CTF mode ${MODE_ID}`);
const ARENA_ID = process.env.BOT_REPRO_ARENA ?? baseMode.defaultArena;
if (!ARENA_ID) throw new Error(`${MODE_ID} needs a defaultArena`);
const layouts: Record<RosterKind, readonly string[]> = {
  "heavy-only": Array(8).fill("ship.brawler"),
  mixed: ["ship.brawler", "ship.interceptor", "ship.support", "ship.brawler", "ship.interceptor", "ship.support", "ship.brawler", "ship.interceptor"],
  "light-only": Array(8).fill("ship.interceptor"),
};
const rows: BotRow[] = [];

for (const [roster, hulls] of Object.entries(layouts) as [RosterKind, readonly string[]][]) {
  const patched: GamemodeConfig = {
    ...baseMode,
    bots: {
      ...baseMode.bots!,
      randomizeLoadouts: false,
      roster: hulls.map((ship, index) => ({ profile: "bot.flagrunner", ship, team: index % 2, count: 1 })),
    },
  };
  const replaced = configs.replace(patched);
  if (!replaced.ok) throw new Error(`could not install ${roster} roster: ${JSON.stringify(replaced)}`);
  for (let seed = 1; seed <= SEED_COUNT; seed++) run(roster, hulls, seed);
}

console.table(rows.map((row) => ({
  roster: row.roster, seed: row.seed, hull: row.hull.replace("ship.", ""), r: row.colliderRadius,
  colliderGap: row.colliderClearance, renderGap: row.renderClearance, visualDelta: row.clearanceGap,
  speed: row.speed, throttle: row.throttle, turn: row.turn, pitch: row.pitchStick, recoverIn: row.recoveryEntries, recoverOut: row.recoveryExits,
  stationary: row.stationarySec, maxStill: row.maxStationarySec, stalled: row.stalled,
})));
const grouped = new Map<string, { bots: number; stalled: number; entries: number; exits: number; maxStill: number }>();
for (const row of rows) {
  const key = `${row.roster}/${row.class}`;
  const value = grouped.get(key) ?? { bots: 0, stalled: 0, entries: 0, exits: 0, maxStill: 0 };
  value.bots++;
  value.stalled += Number(row.stalled);
  value.entries += row.recoveryEntries;
  value.exits += row.recoveryExits;
  value.maxStill = Math.max(value.maxStill, row.maxStationarySec);
  grouped.set(key, value);
}
console.table([...grouped].map(([group, value]) => ({ group, ...value, maxStill: fixed(value.maxStill) })));

function run(roster: RosterKind, hulls: readonly string[], seed: number): void {
  const session = new GameSession(configs, ARENA_ID, MODE_ID, seed);
  const rockId = [...session.sim.world.asteroidIds()].find((id) => session.sim.world.asteroids.get(id)?.configId === ROCK_CONFIG_ID);
  // Canyon arenas use authored static terrain rather than a centre asteroid.
  // Keep this diagnostic runnable there: it still reports recovery/stall data,
  // merely without manufacturing an obstacle the shipped map does not contain.
  const obstacle = rockId === undefined
    ? { pos: { x: 0, y: 0, z: 0 }, radius: 0 }
    : { pos: session.sim.world.transforms.get(rockId)!.pos, radius: session.sim.world.colliders.get(rockId)!.radius };
  const rockPos = obstacle.pos;
  const rockRadius = obstacle.radius;
  const states = new Map<EntityId, { hull: ShipConfig; anchor: { x: number; y: number; z: number }; still: number; maxStill: number; entries: number; exits: number; recovering: boolean; decision: BotDecisionSnapshot | null }>();

  [...session.bots.keys()].forEach((id, index) => {
    const hull = configs.get<ShipConfig>("ship", hulls[index]!)!;
    const tf = session.sim.world.transforms.get(id)!;
    const radius = session.sim.world.colliders.get(id)!.radius;
    const angle = index * Math.PI * 2 / hulls.length;
    tf.pos.x = rockPos.x + Math.cos(angle) * (rockRadius + radius - 0.05);
    tf.pos.y = rockPos.y;
    tf.pos.z = rockPos.z + Math.sin(angle) * (rockRadius + radius - 0.05);
    tf.heading = Math.atan2(-Math.sin(angle), -Math.cos(angle));
    tf.pitch = 0;
    const velocity = session.sim.world.velocities.get(id)!;
    velocity.x = velocity.y = velocity.z = 0;
    states.set(id, { hull, anchor: { ...tf.pos }, still: 0, maxStill: 0, entries: 0, exits: 0, recovering: false, decision: null });
  });

  for (let tick = 0; tick < MAX_SEC / DT; tick++) {
    session.tick(DT);
    for (const [id, driver] of session.bots) {
      const state = states.get(id)!;
      const tf = session.sim.world.transforms.get(id);
      const velocity = session.sim.world.velocities.get(id);
      if (!tf || !velocity) continue;
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      const clearance = dist3(tf.pos, rockPos) - rockRadius - state.hull.collider.radius;
      if (clearance <= 0.35 && speed < SLOW_SPEED && dist3(state.anchor, tf.pos) <= 1) state.still++;
      else { state.anchor = { ...tf.pos }; state.still = 0; }
      state.maxStill = Math.max(state.maxStill, state.still);
      const recovering = driver.lastDecision?.surfaceRecovery === true;
      if (recovering && !state.recovering) state.entries++;
      if (!recovering && state.recovering) state.exits++;
      state.recovering = recovering;
      state.decision = driver.lastDecision;
    }
  }

  for (const [id, state] of states) {
    const tf = session.sim.world.transforms.get(id)!;
    const velocity = session.sim.world.velocities.get(id)!;
    const colliderClearance = dist3(tf.pos, rockPos) - rockRadius - state.hull.collider.radius;
    // Content scales the rendered hull independently of physics. This conservative
    // extent makes the mismatch explicit; it is diagnostic, never collision input.
    const renderRadius = state.hull.render.modelScale ?? state.hull.collider.radius;
    const renderClearance = dist3(tf.pos, rockPos) - rockRadius - renderRadius;
    const stationarySec = state.still * DT;
    rows.push({
      roster, seed, bot: id, hull: state.hull.id, class: state.hull.class,
      colliderRadius: state.hull.collider.radius, renderRadius: fixed(renderRadius),
      colliderClearance: fixed(colliderClearance), renderClearance: fixed(renderClearance),
      clearanceGap: fixed(colliderClearance - renderClearance),
      speed: fixed(Math.hypot(velocity.x, velocity.y, velocity.z)),
      throttle: state.decision?.flight?.throttle ?? -1,
      turn: fixed(state.decision?.flight?.turn ?? 0), pitchStick: fixed(state.decision?.flight?.pitchStick ?? 0),
      recoveryEntries: state.entries, recoveryExits: state.exits,
      stationarySec: fixed(stationarySec), maxStationarySec: fixed(state.maxStill * DT),
      stalled: stationarySec >= STUCK_SEC,
    });
  }
}

function fixed(value: number): number { return Number(value.toFixed(3)); }
