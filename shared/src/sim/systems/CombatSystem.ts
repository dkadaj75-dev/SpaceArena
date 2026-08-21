import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId, ModuleRuntime, TargetRef, Transform3D } from "../components.js";
import { applyDamageToAsteroid, applyDamageToShip } from "../damage.js";
import { headingOf, len3, pitchOf, segmentIntersectsSphere, sphereEntryAlong } from "../math.js";
import { hasLineOfSightBetween } from "../los.js";
import { spawnProjectile } from "../spawn.js";
import type { World } from "../World.js";
import { transition } from "./ModuleSystem.js";

/**
 * Cadence (seconds) at which a channelling `continuous` weapon flushes its
 * banked `damage`/`shieldAbsorb` events — 4 per second. This is an EVENT knob
 * only: the damage itself lands every tick regardless, so moving this number
 * changes HUD/audio granularity and nothing about balance. Deliberately not a
 * tuning field for that reason (and because a content knob here would let an
 * author reintroduce the 30-events/second problem this exists to avoid).
 */
export const CHANNEL_EVENT_INTERVAL_SEC = 0.25;

/**
 * CombatSystem (1.7) — active discrete weapon modules repeat on their authored
 * cycle while the trigger is held.
 * WITH a lock (FLIGHT.md §2) shots are aimed at the locked target: range, LoS
 * (if required) and the cycle gate all apply, exactly as before. Weapons cost NO
 * energy: a weapon's cycle time is the only thing that limits it.
 * WITHOUT a lock, non-homing weapons fire STRAIGHT along the ship's nose
 * (owner request 2026-07-31): beams raycast out to `fire.range` and damage the
 * first enemy ship or asteroid on the line, kinetics launch a dumb projectile
 * down the nose. Homing missiles are the exception — they need a target to
 * home on, so `turnRate` weapons keep the hard lock requirement.
 *   - beam (`projectile: null`): instant damage (projectileFired + damage events)
 *   - kinetic: dumb projectile aimed at the target's *current* position (leads
 *     nothing, so it can miss a mover — intentional)
 *   - missile: homing projectile carrying the target id (LoS checked at launch)
 * Firing marks the module worked-this-tick for EnergySystem.
 *
 * `fire.mode: "continuous"` weapons take a separate path ({@link channelStep}):
 * no cycle timer, no shots, no per-tick events — while the trigger is held and
 * the same gates pass they apply `fire.damage * dt` every tick.
 */
export function combatSystem(world: World, dt: number): void {
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    const ref = world.targets.get(id);
    const fs = world.flightStates.get(id);
    const myTeam = world.teams.get(id)!.team;
    const myTf = world.transforms.get(id)!;

    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg?.fire) continue;

      // Continuous weapons never touch the cycle timer, and must be visited even
      // while inactive so a retract stops the channel on the same tick.
      if (cfg.fire.mode === "continuous") {
        channelStep(world, { id, m, cfg, ref, firing: fs?.fire === true, myTf, dt });
        continue;
      }

      if (m.state !== "active") continue;

      if (m.cycleTimer > 0) {
        m.cycleTimer -= dt;
        if (m.cycleTimer > 0) continue;
        m.cycleTimer = 0;
      }

      // Discrete weapons are level-triggered. `semi` remains accepted in old
      // content for compatibility, but no longer turns a held trigger into a
      // one-shot edge: a ready rack fires again as long as fire is still held.
      const triggered = fs?.fire === true;
      if (!triggered) continue;

      // Lock gate (checked after the cycle timer: a weapon keeps counting down
      // whether or not the pilot is holding a lock). Homing weapons hard-require
      // it; the rest fall through to the straight-fire path below.
      const targetId = lockedLiveTarget(world, ref);
      const homing = cfg.fire.projectile?.turnRate !== undefined;
      if (homing && targetId === null) continue;

      if (targetId === null) {
        // No lock: fire straight along the nose. Nothing else gates a shot —
        // a weapon costs no energy since the 2026-08-07 overhaul, and a shot
        // into empty space still spends its cycle.
        m.cycleTimer = cfg.fire.cycleTime;
        m.workedThisTick = true;
        spendRound(world, id, m, cfg);

        if (cfg.fire.projectile === null) {
          const hit = raycastNose(world, id, myTeam, myTf, cfg.fire.range);
          if (hit !== null) {
            if (hit.isStatic) {
              // Props block beams but are not damageable entities.
            } else if (hit.isAsteroid) applyDamageToAsteroid(world, hit.id, id, cfg.fire.damage, cfg.fire.damageType);
            else applyDamageToShip(world, hit.id, id, cfg.fire.damage, cfg.fire.damageType);
          }
          world.emit({
            type: "projectileFired",
            ownerId: id,
            moduleId: m.moduleId,
            kind: "beam",
            targetId: hit?.isStatic ? null : hit?.id ?? null,
            actions: cfg.onFire,
          });
        } else {
          const proj = cfg.fire.projectile;
          const pid = spawnProjectile(world, {
            kind: "kinetic",
            damage: cfg.fire.damage,
            damageType: cfg.fire.damageType,
            speed: proj.speed,
            lifetime: proj.lifetime,
            ownerId: id,
            ownerTeam: myTeam,
            pos: { x: myTf.pos.x, y: myTf.pos.y, z: myTf.pos.z },
            heading: myTf.heading,
            pitch: myTf.pitch,
          });
          world.emit({
            type: "projectileFired",
            ownerId: id,
            moduleId: m.moduleId,
            kind: "kinetic",
            projectileId: pid,
            targetId: null,
            actions: cfg.onFire,
          });
        }
        continue;
      }

      const tgtTf = world.transforms.get(targetId)!;
      const dx = tgtTf.pos.x - myTf.pos.x;
      const dy = tgtTf.pos.y - myTf.pos.y;
      const dz = tgtTf.pos.z - myTf.pos.z;
      // True 3D range (BUBBLE.md §A): a target 40 units overhead is 40 units away,
      // not co-located.
      const dist = len3(dx, dy, dz);
      if (dist > cfg.fire.range) continue;
      if (cfg.fire.requiresLineOfSight && !hasLineOfSightBetween(world, id, targetId)) continue;

      // Fire.
      m.cycleTimer = cfg.fire.cycleTime;
      m.workedThisTick = true;
      spendRound(world, id, m, cfg);
      const heading = headingOf(dx, dz);
      // Ordnance leaves along the 3D bearing, so a shot at a climbing enemy
      // actually climbs (dumb kinetics included — they still lead nothing).
      const launchPitch = pitchOf(dx, dy, dz);

      if (cfg.fire.projectile === null) {
        applyDamageToShip(world, targetId, id, cfg.fire.damage, cfg.fire.damageType);
        world.emit({
          type: "projectileFired",
          ownerId: id,
          moduleId: m.moduleId,
          kind: "beam",
          targetId,
          actions: cfg.onFire,
        });
      } else {
        const proj = cfg.fire.projectile;
        const kind = proj.turnRate !== undefined ? "missile" : "kinetic";
        const pid = spawnProjectile(world, {
          kind,
          damage: cfg.fire.damage,
          damageType: cfg.fire.damageType,
          speed: proj.speed,
          turnRate: proj.turnRate,
          lifetime: proj.lifetime,
          ownerId: id,
          ownerTeam: myTeam,
          targetId: kind === "missile" ? targetId : undefined,
          pos: { x: myTf.pos.x, y: myTf.pos.y, z: myTf.pos.z },
          heading,
          pitch: launchPitch,
        });
        world.emit({
          type: "projectileFired",
          ownerId: id,
          moduleId: m.moduleId,
          kind,
          projectileId: pid,
          targetId,
          actions: cfg.onFire,
        });
      }
    }
  }
}

/** Spend ammunition only once a discrete shot has passed every firing gate. */
function spendRound(world: World, ownerId: EntityId, m: ModuleRuntime, cfg: ModuleConfig): void {
  const clip = cfg.fire?.clip;
  if (!clip) return;
  m.rounds = Math.max(0, m.rounds - 1);
  if (m.rounds === 0) {
    m.stateTimer = clip.reloadSec;
    transition(world, ownerId, m, "reloading");
  }
}

/** The ship's locked target if it is alive, else `null`.
 *
 * Hull, not mere existence. CleanupSystem removes the wreck at the END of
 * the tick, so between the shot that kills a ship and that removal the
 * entity is still present with hull ≤ 0 — and every attacker with a higher
 * entity id runs later in the same loop. Checking existence alone let all
 * of them spend a cycle timer and a tick of energy shooting a corpse.
 */
function lockedLiveTarget(world: World, ref: TargetRef | undefined): EntityId | null {
  if (!ref?.locked) return null;
  const targetId = ref.targetId;
  if (targetId === null) return null;
  const core = world.shipCores.get(targetId);
  if (!core || core.hull <= 0) return null;
  return targetId;
}

/** Sweep radius for straight-fire hitscan (same as travelling ordnance). */
const NOSE_RAY_RADIUS = 0.4;

interface NoseHit {
  id: EntityId;
  isAsteroid: boolean;
  /** Present only for a prop hit; existing entity-hit consumers remain compatible. */
  isStatic?: boolean;
}

/**
 * First thing on the shooter's nose line, out to `range`: enemy ships (alive)
 * and intact asteroids, nearest-along-ray wins. Same broadphase + swept-sphere
 * narrow phase as ProjectileSystem's hit sweep, so a straight beam and a
 * straight bullet agree about what is in the way. Deterministic — no engine
 * raycasts. Exported for tests.
 */
export function raycastNose(
  world: World,
  shooterId: EntityId,
  shooterTeam: number,
  tf: Transform3D,
  range: number,
): NoseHit | null {
  const cosPitch = Math.cos(tf.pitch);
  const dirX = cosPitch * Math.cos(tf.heading);
  const dirY = Math.sin(tf.pitch);
  const dirZ = cosPitch * Math.sin(tf.heading);
  const from = tf.pos;
  const to = { x: from.x + dirX * range, y: from.y + dirY * range, z: from.z + dirZ * range };

  const minX = Math.min(from.x, to.x) - NOSE_RAY_RADIUS;
  const maxX = Math.max(from.x, to.x) + NOSE_RAY_RADIUS;
  const minZ = Math.min(from.z, to.z) - NOSE_RAY_RADIUS;
  const maxZ = Math.max(from.z, to.z) + NOSE_RAY_RADIUS;
  const candidates = world.spatial.queryAABB(minX, minZ, maxX, maxZ);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);

  let best: NoseHit | null = null;
  let bestAlong = Infinity;
  const staticHit = world.staticWorld.raycast(from, to);
  if (staticHit) {
    bestAlong = staticHit.t * range;
    best = { id: -1, isAsteroid: false, isStatic: true };
  }
  for (const cid of candidates) {
    if (cid === shooterId) continue;
    const col = world.colliders.get(cid);
    const ct = world.transforms.get(cid);
    if (!col || !ct) continue;

    const isAsteroid = world.asteroids.has(cid);
    const isShip = world.shipCores.has(cid);
    if (!isAsteroid && !isShip) continue;
    if (isShip) {
      if (world.teams.get(cid)?.team === shooterTeam) continue;
      if (world.shipCores.get(cid)!.hull <= 0) continue;
    }
    if (isAsteroid && world.asteroids.get(cid)!.state === "destroyed") continue;

    const reach = col.radius + NOSE_RAY_RADIUS;
    if (ct.pos.y + reach < minY || ct.pos.y - reach > maxY) continue;
    if (!segmentIntersectsSphere(from, to, ct.pos, reach)) continue;
    const centerAlong = (ct.pos.x - from.x) * dirX + (ct.pos.y - from.y) * dirY + (ct.pos.z - from.z) * dirZ;
    const along = sphereEntryAlong(from, ct.pos, centerAlong, reach);
    if (along < bestAlong) {
      bestAlong = along;
      best = { id: cid, isAsteroid };
    }
  }
  return best;
}


interface ChannelCtx {
  id: EntityId;
  m: ModuleRuntime;
  cfg: ModuleConfig;
  ref: TargetRef | undefined;
  /** Trigger level for this ship this tick (`held` semantics — no edge latch). */
  firing: boolean;
  myTf: Transform3D;
  dt: number;
}

/**
 * One tick of a `continuous` weapon. Every gate is the SAME gate the discrete
 * path applies — active state, trigger, lock (FLIGHT.md §2), live target, 3D
 * range, LoS — evaluated fresh each tick, which is exactly what makes a
 * channel stop INSTANTLY on release or lock loss: there is no in-flight ordnance
 * and no timer to run down, the next tick simply applies nothing.
 */
function channelStep(world: World, ctx: ChannelCtx): void {
  const { id, m, cfg, dt } = ctx;
  const fire = cfg.fire!;
  const targetId = channelTarget(world, ctx);
  if (targetId === null) {
    stopChannel(world, id, m);
    return;
  }

  m.channeling = true;
  m.workedThisTick = true;

  // A rising edge announces itself once, so the existing beam fire event (and
  // with it the module's `onFire` actions/sound) still fires exactly once per
  // trigger pull instead of 30 times a second.
  if (m.channel === null || m.channel.targetId !== targetId) {
    if (m.channel !== null) flushChannel(world, id, m); // target switch: bank belongs to the old ship
    m.channel = { targetId, hull: 0, absorbed: new Map(), avoided: new Map(), eventTimer: 0 };
    world.emit({
      type: "projectileFired",
      ownerId: id,
      moduleId: m.moduleId,
      kind: "beam",
      targetId,
      actions: cfg.onFire,
    });
  }
  const channel = m.channel;

  // `fire.damage` is DPS for continuous modules (see moduleSchema), so the tick
  // size cancels out: any tick rate deals the same damage per wall second.
  const amount = fire.damage * dt;
  const tgtCore = world.shipCores.get(targetId)!;
  if (tgtCore.hull <= amount * world.tuning.globalDamageMult) {
    // This tick can kill (mitigation only ever reduces). Flush what is banked
    // first, then deal the killing damage unbanked, so the event ledger reads
    // damage-then-destroyed rather than the reverse.
    flushChannel(world, id, m);
    applyDamageToShip(world, targetId, id, amount, fire.damageType);
    return;
  }

  applyDamageToShip(world, targetId, id, amount, fire.damageType, channel);
  channel.eventTimer += dt;
  if (channel.eventTimer >= CHANNEL_EVENT_INTERVAL_SEC) {
    channel.eventTimer -= CHANNEL_EVENT_INTERVAL_SEC;
    emitChannelEvents(world, id, m, channel.targetId, channel);
  }
}

/**
 * The entity this channel may damage this tick, or `null` if any gate fails.
 * Mirrors the discrete path's checks in the same order. Without a lock the
 * channel runs the same straight-nose raycast as the discrete path — it damages
 * the enemy ship the nose crosses (asteroids block the line but a channel does
 * not chew them: the banked-damage ledger is ship-shaped).
 */
function channelTarget(world: World, ctx: ChannelCtx): EntityId | null {
  const { id, m, cfg, ref, firing, myTf } = ctx;
  const fire = cfg.fire!;
  if (m.state !== "active") return null;
  if (!firing) return null;
  const targetId = lockedLiveTarget(world, ref);
  if (targetId === null) {
    const myTeam = world.teams.get(id)!.team;
    const hit = raycastNose(world, id, myTeam, myTf, fire.range);
    return hit !== null && !hit.isAsteroid && !hit.isStatic ? hit.id : null;
  }
  const tgtTf = world.transforms.get(targetId)!;
  const dist = len3(tgtTf.pos.x - myTf.pos.x, tgtTf.pos.y - myTf.pos.y, tgtTf.pos.z - myTf.pos.z);
  if (dist > fire.range) return null;
  if (fire.requiresLineOfSight && !hasLineOfSightBetween(world, id, targetId)) return null;
  return targetId;
}

/** Stop a channel, flushing whatever damage it banked since the last window. */
function stopChannel(world: World, ownerId: EntityId, m: ModuleRuntime): void {
  m.channeling = false;
  if (m.channel === null) return;
  flushChannel(world, ownerId, m);
  m.channel = null;
}

/** Emit the banked amounts (if any) and reset the window. */
function flushChannel(world: World, ownerId: EntityId, m: ModuleRuntime): void {
  const channel = m.channel;
  if (channel === null) return;
  emitChannelEvents(world, ownerId, m, channel.targetId, channel);
  channel.eventTimer = 0;
}

function emitChannelEvents(
  world: World,
  ownerId: EntityId,
  m: ModuleRuntime,
  targetId: EntityId,
  channel: { hull: number; absorbed: Map<number, number>; avoided: Map<number, number> },
): void {
  for (const [hardpointIndex, amount] of channel.absorbed) {
    if (amount > 0) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      world.emit({
        type: "shieldAbsorb",
        targetId,
        sourceId: ownerId,
        hardpointIndex,
        amount,
        hullAvoided: channel.avoided.get(hardpointIndex) ?? 0,
        damageType: cfg?.fire?.damageType ?? "energy",
      });
    }
  }
  channel.absorbed.clear();
  channel.avoided.clear();
  if (channel.hull > 0) {
    const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
    world.emit({
      type: "damage",
      targetId,
      sourceId: ownerId,
      amount: channel.hull,
      damageType: cfg?.fire?.damageType ?? "energy",
      isAsteroid: false,
    });
    channel.hull = 0;
  }
}

/**
 * Latch the held trigger once per ship after every weapon has observed the same
 * edge. Called at the end of the live simulation tick, after CombatSystem.
 */
export function latchFireState(world: World): void {
  for (const id of world.shipIds()) {
    const fs = world.flightStates.get(id);
    if (fs) fs.firePrev = fs.fire;
  }
}
