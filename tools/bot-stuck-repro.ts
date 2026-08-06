import { GameSession } from "../client/src/game/GameSession.js";
import type { BotDecisionSnapshot } from "../shared/src/bots/BotDriver.js";
import type { GamemodeConfig } from "../shared/src/schemas/index.js";
import type { EntityId } from "../shared/src/sim/components.js";
import { dist3 } from "../shared/src/sim/math.js";
import { loadTestConfigs } from "../shared/src/sim/testutil.js";

const DT = 1 / 30;
const MAX_SEC = Number(process.env.BOT_REPRO_SECONDS ?? 600);
const SEED_COUNT = Number(process.env.BOT_REPRO_SEEDS ?? 20);
const SLOW_SPEED = 0.5;
const NO_PROGRESS_RADIUS = 1;
const STUCK_SEC = 5;

interface SurfaceSample {
  kind: "floor" | "collider" | "none";
  clearance: number;
  normal: { x: number; y: number; z: number };
}

interface BotRow {
  arena: string;
  mode: string;
  seed: number;
  bot: number;
  minAltitude: number;
  minSurface: number;
  maxStillSec: number;
  stuckSec: number;
  speed: number;
  throttle: number;
  noseDotNormal: number;
  recovery: string;
  surface: string;
}

const configs = await loadTestConfigs();
const modes = configs.getAll<GamemodeConfig>("gamemode").filter((mode) => mode.bots?.roster?.length);
const rows: BotRow[] = [];

for (const mode of modes) {
  if (!mode.defaultArena) continue;
  for (let seed = 1; seed <= SEED_COUNT; seed++) run(mode, mode.defaultArena, seed);
}

const stuck = rows.filter((row) => row.stuckSec >= STUCK_SEC);
console.table((stuck.length ? stuck : rows)
  .sort((a, b) => b.stuckSec - a.stuckSec || b.maxStillSec - a.maxStillSec)
  .slice(0, 80));
console.log(JSON.stringify({ runs: modes.length * SEED_COUNT, bots: rows.length, stuckBots: stuck.length }, null, 2));

function run(mode: GamemodeConfig, arena: string, seed: number): void {
  const session = new GameSession(configs, arena, mode.id, seed);
  const states = new Map<EntityId, {
    anchor: { x: number; y: number; z: number };
    stillTicks: number;
    maxStillTicks: number;
    stuckTicks: number;
    minAltitude: number;
    minSurface: number;
    lastSpeed: number;
    lastSurface: SurfaceSample;
    lastDecision: BotDecisionSnapshot | null;
    lastDot: number;
  }>();
  for (const id of session.bots.keys()) {
    const pos = session.sim.world.transforms.get(id)!.pos;
    states.set(id, {
      anchor: { ...pos }, stillTicks: 0, maxStillTicks: 0, stuckTicks: 0,
      minAltitude: Infinity, minSurface: Infinity, lastSpeed: 0,
      lastSurface: { kind: "none", clearance: Infinity, normal: { x: 0, y: 1, z: 0 } },
      lastDecision: null, lastDot: 0,
    });
  }
  for (let tick = 0; tick < MAX_SEC / DT && !session.sim.isEnded; tick++) {
    session.tick(DT);
    for (const [id, driver] of session.bots) {
      const tf = session.sim.world.transforms.get(id);
      const velocity = session.sim.world.velocities.get(id);
      const collider = session.sim.world.colliders.get(id);
      const state = states.get(id)!;
      if (!tf || !velocity || !collider) continue;
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      const sample = nearestSurface(session, id);
      const floorY = session.sim.world.arena.bounds.shape === "sphere" ? session.sim.world.arena.bounds.floorY : undefined;
      const altitude = floorY === undefined ? Infinity : tf.pos.y - floorY - collider.radius;
      state.minAltitude = Math.min(state.minAltitude, altitude);
      state.minSurface = Math.min(state.minSurface, sample.clearance);
      const nearSurface = sample.clearance <= 0.1;
      if (nearSurface && speed < SLOW_SPEED && dist3(state.anchor, tf.pos) <= NO_PROGRESS_RADIUS) {
        state.stillTicks++;
        if (state.stillTicks >= STUCK_SEC / DT) state.stuckTicks++;
      } else {
        state.anchor = { ...tf.pos };
        state.stillTicks = 0;
      }
      state.maxStillTicks = Math.max(state.maxStillTicks, state.stillTicks);
      const cp = Math.cos(tf.pitch);
      state.lastDot = cp * Math.cos(tf.heading) * sample.normal.x + Math.sin(tf.pitch) * sample.normal.y
        + cp * Math.sin(tf.heading) * sample.normal.z;
      state.lastSpeed = speed;
      state.lastSurface = sample;
      state.lastDecision = driver.lastDecision;
    }
  }
  for (const [id, state] of states) rows.push({
    arena, mode: mode.id, seed, bot: id,
    minAltitude: finite(state.minAltitude), minSurface: finite(state.minSurface),
    maxStillSec: state.maxStillTicks * DT, stuckSec: state.stuckTicks * DT,
    speed: state.lastSpeed, throttle: state.lastDecision?.flight?.throttle ?? -1,
    noseDotNormal: state.lastDot,
    recovery: state.lastDecision?.floorRecovery ? "floor" : "none",
    surface: state.lastSurface.kind,
  });
}

function nearestSurface(session: GameSession, id: EntityId): SurfaceSample {
  const world = session.sim.world;
  const pos = world.transforms.get(id)!.pos;
  const radius = world.colliders.get(id)!.radius;
  let best: SurfaceSample = { kind: "none", clearance: Infinity, normal: { x: 0, y: 1, z: 0 } };
  if (world.arena.bounds.shape === "sphere" && world.arena.bounds.floorY !== undefined) {
    best = { kind: "floor", clearance: pos.y - world.arena.bounds.floorY - radius, normal: { x: 0, y: 1, z: 0 } };
  }
  for (const other of [...world.asteroidIds(), ...world.shipIds()]) {
    if (other === id || !world.transforms.has(other) || !world.colliders.has(other)) continue;
    const at = world.transforms.get(other)!.pos;
    const dx = pos.x - at.x;
    const dy = pos.y - at.y;
    const dz = pos.z - at.z;
    const length = Math.hypot(dx, dy, dz) || 1;
    const clearance = length - radius - world.colliders.get(other)!.radius;
    if (clearance < best.clearance) best = {
      kind: "collider", clearance,
      normal: { x: dx / length, y: dy / length, z: dz / length },
    };
  }
  return best;
}

function finite(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : -1;
}
