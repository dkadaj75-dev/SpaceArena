import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, dist3, facingVec, setGlobalLogLevel, type SimEvent } from "@space-arena/shared";
import { GameSession } from "./GameSession.js";

setGlobalLogLevel("error");

/**
 * `GameSession.spawnScripted` — the seam the tutorial's director uses to put a
 * hulk and then a drone in front of the player, one lesson at a time.
 *
 * Run against the SHIPPED pack rather than fixtures: the whole risk here is that
 * a real hull's sockets reject an authored fitting, or that a hull's resolved
 * stats make the target unkillable inside a lesson. Neither shows up against a
 * synthetic ship.
 */
function contentDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "content", "manifest.json"))) return path.join(dir, "content");
    dir = path.dirname(dir);
  }
  throw new Error(`content/manifest.json not found above ${process.cwd()}`);
}

let configs: ConfigService;
beforeAll(async () => {
  const dir = contentDir();
  configs = new ConfigService((rel) => Promise.resolve(JSON.parse(readFileSync(path.join(dir, rel), "utf8"))));
  const result = await configs.load("manifest.json");
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
});

const DT = 1 / 30;

function tutorialSession(): GameSession {
  return new GameSession(configs, "arena.ring-nebula", "gamemode.tutorial", 1, {
    playerShipId: "ship.interceptor",
    playerFitting: ["module.laser-mk1", "module.shield-mk1"],
  });
}

/** Run the sim for `seconds`, returning everything it emitted. */
function run(session: GameSession, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds / DT; i++) {
    session.tick(DT);
    events.push(...session.drainFrameEvents());
    session.clearFrameEvents();
  }
  return events;
}

describe("scripted spawn", () => {
  it("puts the actor on the player's nose at the authored distance", () => {
    const session = tutorialSession();
    const player = session.curSnapshot.ships.find((s) => s.id === session.playerId)!;
    const id = session.spawnScripted({ shipId: "ship.support", aheadDistance: 48 });
    expect(id).not.toBeNull();
    const actor = session.curSnapshot.ships.find((s) => s.id === id)!;
    expect(dist3(player.pos, actor.pos)).toBeCloseTo(48, 3);
    // …on the nose, not merely 48 units away in some direction.
    const nose = facingVec(player.heading, player.pitch, { x: 0, y: 0, z: 0 });
    expect(actor.pos.x - player.pos.x).toBeCloseTo(nose.x * 48, 3);
    expect(actor.pos.y - player.pos.y).toBeCloseTo(nose.y * 48, 3);
    expect(actor.pos.z - player.pos.z).toBeCloseTo(nose.z * 48, 3);
  });

  it("is visible in the snapshot immediately, without waiting a tick", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support" });
    expect(session.curSnapshot.ships.some((s) => s.id === id)).toBe(true);
  });

  it("starts on the authored hull without touching the hull the class resolves", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support", hull: 10 });
    const actor = session.curSnapshot.ships.find((s) => s.id === id)!;
    expect(actor.hull).toBe(10);
    expect(actor.hullMax).toBeGreaterThan(10);
  });

  it("an actor with no profile is inert: no driver, no movement, no shots", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support", hull: 40, team: 1 })!;
    expect(session.bots.has(id)).toBe(false);
    const before = session.curSnapshot.ships.find((s) => s.id === id)!.pos;
    const events = run(session, 6);
    const after = session.curSnapshot.ships.find((s) => s.id === id)!.pos;
    expect(dist3(before, after)).toBeCloseTo(0, 6);
    expect(events.some((e) => e.type === "projectileFired" && e.ownerId === id)).toBe(false);
  });

  it("an actor WITH a profile gets a driver and flies", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({
      shipId: "ship.interceptor",
      profile: "bot.tutorial",
      fitting: ["module.laser-mk1", null, "module.engine-civ"],
      team: 1,
      hull: 34,
    })!;
    expect(session.bots.has(id)).toBe(true);
    const before = { ...session.curSnapshot.ships.find((s) => s.id === id)!.pos };
    run(session, 8);
    const after = session.curSnapshot.ships.find((s) => s.id === id)!.pos;
    expect(dist3(before, after)).toBeGreaterThan(1);
  });

  it("names the actor for the reticle and the kill feed", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support", displayName: "DERELICT" })!;
    expect(session.displayNameFor(id)).toBe("DERELICT");
  });

  it("refuses a hull this pack does not have, rather than throwing into a match", () => {
    const session = tutorialSession();
    expect(session.spawnScripted({ shipId: "ship.nope" })).toBeNull();
  });

  it("spawns inert even when the named profile is missing", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support", profile: "bot.nope" })!;
    expect(id).not.toBeNull();
    expect(session.bots.has(id)).toBe(false);
  });

  it("the pre-wrecked hulk dies inside a lesson, not inside a duel", () => {
    // The tutorial's own numbers: a stock laser, a stationary target, and the
    // authored 22 hull. If a balance change makes this take longer than the
    // step it belongs to, this is where it shows up.
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support", hull: 10, team: 1, aheadDistance: 30 })!;
    session.order({ kind: "flight", throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: true });
    const events = run(session, 12);
    const kill = events.find((e) => e.type === "entityDestroyed" && e.entityId === id);
    expect(kill, "the hulk must die under sustained fire inside 12 s — it is a step, not a duel").toBeDefined();
  });

  it("the tutorial match never ends itself — the director owns the ending", () => {
    const session = tutorialSession();
    const id = session.spawnScripted({ shipId: "ship.support", hull: 10, team: 1, aheadDistance: 30 })!;
    session.order({ kind: "flight", throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: true });
    run(session, 12);
    expect(session.curSnapshot.ships.some((s) => s.id === id)).toBe(false);
    // Elimination is off and the frag target is unreachable, so killing every
    // scripted target does NOT raise the results screen over the coach mark.
    expect(session.isEnded).toBe(false);
  });
});
