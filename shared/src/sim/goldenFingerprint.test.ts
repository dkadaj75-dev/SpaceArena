import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig, GamemodeConfig, ShipConfig } from "../schemas/index.js";
import { BotDriver } from "../bots/BotDriver.js";
import { clearRoleAllocationCache } from "../bots/roleAllocator.js";
import { ArenaSimulation, type Snapshot } from "./ArenaSimulation.js";
import type { EntityId } from "./components.js";
import type { SimEvent } from "./events.js";
import { deriveRng } from "./rng.js";
import { loadTestConfigs } from "./testutil.js";

/**
 * Refactor plan §2a — the golden fingerprint.
 *
 * Every other determinism assertion in this repo is `run(seed) === run(seed)` in
 * one process. That cannot notice a change which alters iteration order
 * identically in both runs — which is exactly what the spatial-hash split, the
 * bot-context memo and the `World` id-accessor cache all risk. This file is the
 * only committed golden value in the suite.
 *
 * ## Two digests, on purpose
 *
 * A single hash over everything answers "did anything move?" and nothing else,
 * so a deliberate balance tune and an accidental reordering are the same red X.
 * Each vector therefore records two:
 *
 *  - **structure** — ids, array order, phases, module/asteroid states, event
 *    types and their id fields. No floats at all. This is the one that catches a
 *    reordering, and it should survive any change that is meant to be
 *    behaviour-identical. **If `structure` moves, the refactor is wrong.**
 *  - **numeric** — the same stream with floats quantized to 1e-3. Sensitive to
 *    genuine math changes, and legitimately re-recorded when combat or flight
 *    tuning changes on purpose.
 *
 * ## Why floats are quantized rather than pinned exactly
 *
 * IEEE-754 `+ - * / sqrt` are exactly specified, but the sim reaches for
 * `Math.sin/cos/atan2/pow/hypot` in ~143 non-test call sites, and ECMAScript
 * leaves those implementation-defined. V8's results are stable for a given V8
 * but are not guaranteed across Node upgrades, so a full-precision literal would
 * be a Node-version tripwire wearing a determinism costume. 1e-3 of a world unit
 * is far below anything gameplay can see and far above that noise.
 *
 * ## What this does NOT cover (measured, not assumed)
 *
 * These vectors do not subsume `spatialHash.test.ts`. Flipping `queryAABB` from
 * a cx-major to a cz-major cell scan — precisely the mistake the planned
 * static/dynamic bucket split can make — fails two assertions in that unit test
 * and leaves BOTH digests here untouched, because the query AABBs these arenas
 * generate rarely span enough cells for the scan order to change an outcome. The
 * fingerprint guards entity ordering and math; the unit test guards cell scan
 * order. Deleting either as redundant would open a hole.
 *
 * ## Re-recording
 *
 *   npx vitest run shared/src/sim/goldenFingerprint.test.ts
 *
 * The failure message prints the observed digest. Before pasting it in, be sure
 * you can name the change that moved it — and if only `numeric` moved, say so in
 * the commit message.
 */

const DT = 1 / 30;
const BENCH_MODE = "gamemode.fingerprint-bench";

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
  // Private mode so a shipped win condition can never cut a vector short. The
  // ARENAS are shipped on purpose: their asteroid fields and prop/navGraph
  // geometry are the very inputs the collision, spatial-hash and static-raycast
  // paths under refactor consume.
  const replaced = configs.replace({
    id: BENCH_MODE,
    type: "gamemode",
    version: 1,
    name: "Fingerprint Bench",
    teams: "5v5",
    launch: "online",
    winCondition: { type: "timeLimit", seconds: 3600 },
    eliminationEndsMatch: false,
    respawn: { enabled: false, delay: 0 },
    boundaryRule: { type: "warning" },
    rewards: { win: 0, loss: 0, perKill: 0 },
    bots: { defaultProfile: "bot.rookie", defaultShip: "ship.interceptor", backfillWaitMs: 10_000 },
  });
  if (!replaced.ok) throw new Error(`bench fixture rejected: ${JSON.stringify(replaced.errors)}`);
});

/** 32-bit FNV-1a. `shared` is browser-consumable, so no `node:crypto` here. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Quantize for the numeric digest. `JSON.stringify` would erase two things this
 * needs to keep: it renders -0 as "0" (velocity and up-vectors flip sign of zero
 * routinely) and both NaN and Infinity as "null" (which would read as a benign
 * diff instead of the breakage it is).
 */
function num(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  const rounded = Math.round(value * 1000) / 1000;
  if (rounded === 0) return Object.is(rounded, -0) ? "-0" : "0";
  return rounded.toFixed(3);
}

/** Discrete-only view: ids, ordering, enums. No float ever reaches this. */
function structureOf(snap: Snapshot, events: readonly SimEvent[]): string {
  const parts: string[] = [
    `t${snap.tick}`,
    `phase=${snap.phase}`,
    `winner=${String(snap.winnerTeam)}`,
    `scores=${snap.teamScores.map((s) => `${s.team}:${s.kills}:${s.captures}`).join(",")}`,
    // Array ORDER is the assertion — `World`'s id accessors sort ascending, so a
    // cache that returned a shared/unsorted array would surface right here.
    `ships=${snap.ships.map((s) => `${s.id}/${s.team}/${String(s.targetId)}/${s.locked ? 1 : 0}` +
      `/${s.modules.map((m) => `${m.hardpointIndex}:${m.moduleId}:${m.state}:${m.rounds ?? 0}:${m.channeling ? 1 : 0}`).join("|")}`).join(",")}`,
    `rocks=${snap.asteroids.map((a) => `${a.id}/${a.configId}/${a.state}`).join(",")}`,
    `proj=${snap.projectiles.map((p) => `${p.id}/${p.kind}`).join(",")}`,
    `decoys=${snap.decoys.map((d) => `${d.id}/${d.team}`).join(",")}`,
    `flags=${snap.flags.map((f) => `${f.id}/${f.team}/${f.state}/${String(f.carrierId)}`).join(",")}`,
    // Optional keys are omitted by JSON.stringify, so presence is spelled out.
    `lobby=${snap.lobbyRemainingSec === undefined ? "absent" : "present"}`,
  ];
  for (const ev of events) {
    const ids = Object.entries(ev)
      .filter(([k, v]) => k !== "type" && (typeof v === "string" || typeof v === "boolean" || Number.isInteger(v)))
      .map(([k, v]) => `${k}=${String(v)}`)
      .sort()
      .join(";");
    parts.push(`e:${ev.type}{${ids}}`);
  }
  return parts.join("\n");
}

/** Quantized float view: the same stream, numbers only. */
function numericOf(snap: Snapshot, events: readonly SimEvent[]): string {
  const parts: string[] = [`elapsed=${num(snap.elapsed)}`, `countdown=${num(snap.countdownRemaining)}`];
  for (const s of snap.ships) {
    parts.push(
      `s${s.id}=${num(s.pos.x)},${num(s.pos.y)},${num(s.pos.z)},${num(s.heading)},${num(s.pitch)},` +
        `${num(s.up.x)},${num(s.up.y)},${num(s.up.z)},${num(s.hull)},${num(s.throttle)},${num(s.lockProgress)}`,
    );
    for (const m of s.modules) {
      parts.push(`  m${m.hardpointIndex}=${num(m.heat)},${num(m.energy)},${num(m.stateTimer)},${num(m.cycleTimer)},${num(m.shieldPool)}`);
    }
  }
  for (const p of snap.projectiles) parts.push(`p${p.id}=${num(p.pos.x)},${num(p.pos.y)},${num(p.pos.z)}`);
  for (const ev of events) {
    const nums = Object.entries(ev)
      .filter(([k, v]) => k !== "type" && typeof v === "number" && !Number.isInteger(v))
      .map(([k, v]) => `${k}=${num(v as number)}`)
      .sort()
      .join(";");
    if (nums) parts.push(`e:${ev.type}{${nums}}`);
  }
  return parts.join("\n");
}

interface Fingerprint {
  structure: string;
  numeric: string;
  /** Cheap corroboration, so a digest collision cannot hide a change. */
  events: number;
  ticks: number;
}

function fingerprint(snap: Snapshot, events: readonly SimEvent[], ticks: number): Fingerprint {
  const structure = structureOf(snap, events);
  const numeric = numericOf(snap, events);
  // A NaN anywhere is breakage, not drift — say so plainly rather than letting
  // it ride inside a digest nobody can read.
  expect(structure, "structure stream went non-finite").not.toContain("NaN");
  expect(numeric, "numeric stream went non-finite").not.toMatch(/NaN|Inf/);
  return { structure: fnv1a(structure), numeric: fnv1a(numeric), events: events.length, ticks };
}

/**
 * VECTOR 1 — scripted, bot-free, on the shipped asteroid field. No RNG consumer
 * runs, so this is pure sim sequencing: spawn order, spatial-hash query order,
 * collision resolution order, projectile stepping.
 */
function scriptedVector(ticks: number): Fingerprint {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", BENCH_MODE, 20_260_816);
  const fitting = configs.get<ShipConfig>("ship", "ship.interceptor")!.defaultFitting;
  const ids: EntityId[] = [];
  for (let team = 0; team < 2; team++) {
    for (let slot = 0; slot < 3; slot++) ids.push(sim.spawnPlayer("ship.interceptor", fitting, team));
  }
  const events: SimEvent[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    // A fixed, per-ship-distinct order script: closed form, no RNG, and it turns
    // the ships into each other so weapons actually fire and collide.
    for (let i = 0; i < ids.length; i++) {
      sim.applyOrder(ids[i]!, {
        kind: "flight",
        throttle: i % 2 === 0 ? 1 : 0.6,
        turn: ((i + 1) % 3) - 1,
        pitchStick: tick % 90 < 45 ? 0.25 : -0.25,
        boost: false,
        fire: tick % 7 === 0,
      });
    }
    sim.tick(DT);
    events.push(...sim.getEvents());
  }
  return fingerprint(sim.snapshot(), events, ticks);
}

/**
 * VECTOR 2 — ten bots on the CTF terrain. Adds everything vector 1 cannot see:
 * bot decision ordering, `buildBotContext`, the recovery/rest-surface path, and
 * `StaticWorld.raycast` against real prop geometry (which is where the slab-test
 * unroll lives).
 */
function botVector(ticks: number): Fingerprint {
  clearRoleAllocationCache();
  const seed = 20_260_816;
  const mode = "gamemode.practice-ctf-5v5";
  const sim = new ArenaSimulation(configs, "arena.lunar-rift", mode, seed);
  const gamemode = configs.get<GamemodeConfig>("gamemode", mode)!;
  const profiles = ["bot.flagrunner", "bot.aggressive", "bot.cautious", "bot.rookie"]
    .map((id) => configs.get<BotprofileConfig>("botprofile", id)!);
  const ship = configs.get<ShipConfig>("ship", gamemode.bots!.defaultShip!)!;
  const drivers: Array<{ id: EntityId; driver: BotDriver }> = [];
  for (let team = 0; team < 2; team++) {
    for (let slot = 0; slot < 5; slot++) {
      const id = sim.spawnPlayer(ship.id, ship.defaultFitting, team);
      drivers.push({
        id,
        driver: new BotDriver({
          entityId: id,
          profile: profiles[(team * 5 + slot) % profiles.length]!,
          configs,
          rng: deriveRng(seed, id),
          arenaBounds: sim.world.arena.bounds,
          staticWorld: sim.world.staticWorld,
          navRoute: sim.world.navRoute,
          visualRadius: Math.max(ship.collider.radius, (ship.render.modelScale ?? ship.collider.radius * 2) / 2),
        }),
      });
    }
  }
  const events: SimEvent[] = [];
  let nowMs = 0;
  for (let tick = 0; tick < ticks && !sim.isEnded; tick++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    for (const entry of drivers) {
      if (!sim.hasShip(entry.id)) continue;
      for (const order of entry.driver.update(snapshot, nowMs)) sim.applyOrder(entry.id, order);
    }
    sim.tick(DT);
    events.push(...sim.getEvents());
  }
  return fingerprint(sim.snapshot(), events, ticks);
}

describe("golden sim fingerprint", () => {
  it("pins the scripted asteroid-field vector", () => {
    const fp = scriptedVector(600);
    expect(fp).toEqual({
      structure: "0fc425ff",
      numeric: "9c924fa2",
      events: 303,
      ticks: 600,
    });
  });

  // 900 ticks = 30 s of sim. Long enough for the bots to close, engage and take
  // damage, so the vector actually carries an event stream rather than a static
  // opening formation; still under three seconds of wall time.
  it("pins the ten-bot lunar-rift vector", () => {
    const fp = botVector(900);
    expect(fp).toEqual({
      structure: "56c81595",
      numeric: "59639879",
      events: 451,
      ticks: 900,
    });
  }, 120_000);

  it("is reproducible within a process, which is the weaker property", () => {
    expect(scriptedVector(60)).toEqual(scriptedVector(60));
  });
});
