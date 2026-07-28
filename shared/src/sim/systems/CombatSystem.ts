import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId, ModuleRuntime, ShipCore, TargetRef, Transform3D } from "../components.js";
import { applyDamageToShip } from "../damage.js";
import { headingOf, len3, pitchOf } from "../math.js";
import { hasLineOfSightBetween } from "../los.js";
import { spawnProjectile } from "../spawn.js";
import type { World } from "../World.js";

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
 * CombatSystem (1.6) — active weapon modules auto-fire when the ship holds a
 * LOCK on its target (FLIGHT.md §2 — every weapon kind requires it, no
 * exceptions and no per-driver carve-outs), the target is in weapon range, has
 * LoS (if required), the cycle has elapsed and energy is available.
 *   - beam (`projectile: null`): instant damage (projectileFired + damage events)
 *   - kinetic: dumb projectile aimed at the target's *current* position (leads
 *     nothing, so it can miss a mover — intentional)
 *   - missile: homing projectile carrying the target id (LoS checked at launch)
 * Firing marks the module worked-this-tick for EnergySystem.
 *
 * `fire.mode: "continuous"` weapons take a separate path ({@link channelStep}):
 * no cycle timer, no shots, no per-tick events — while the trigger is held and
 * the same gates pass they apply `fire.damage * dt` every tick and are marked
 * worked-this-tick every tick, so the EXISTING `drawActive` /
 * `heat.perSecondActive` per-second cost model charges them naturally.
 */
export function combatSystem(world: World, dt: number): void {
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    const core = world.shipCores.get(id)!;
    const ref = world.targets.get(id);
    const fs = world.flightStates.get(id);
    const myTeam = world.teams.get(id)!.team;
    const myTf = world.transforms.get(id)!;

    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg?.fire) continue;

      // Continuous weapons never touch the cycle timer, and must be visited even
      // while inactive so a retract/overheat stops the channel on the same tick.
      if (cfg.fire.mode === "continuous") {
        channelStep(world, { id, m, cfg, core, ref, firing: fs?.fire === true, myTf, dt });
        continue;
      }

      if (m.state !== "active") continue;

      if (m.cycleTimer > 0) {
        m.cycleTimer -= dt;
        if (m.cycleTimer > 0) continue;
        m.cycleTimer = 0;
      }

      const triggered =
        cfg.fire.mode === "held"
          ? fs?.fire === true
          : cfg.fire.mode === "semi"
            ? fs?.fire === true && !fs.firePrev
            : false;
      if (!triggered) continue;

      // Lock gate (checked after the cycle timer: a weapon keeps cooling down
      // whether or not the pilot is holding a lock).
      if (!ref?.locked) continue;
      const targetId = ref.targetId;
      if (targetId === null) continue;
      // Hull, not mere existence. CleanupSystem removes the wreck at the END of
      // the tick, so between the shot that kills a ship and that removal the
      // entity is still present with hull ≤ 0 — and every attacker with a higher
      // entity id runs later in this same loop. Checking existence alone let all
      // of them spend a cycle timer and a tick of energy shooting a corpse.
      const tgtCore = world.shipCores.get(targetId);
      if (!tgtCore || tgtCore.hull <= 0) continue;
      const tgtTf = world.transforms.get(targetId)!;

      const dx = tgtTf.pos.x - myTf.pos.x;
      const dy = tgtTf.pos.y - myTf.pos.y;
      const dz = tgtTf.pos.z - myTf.pos.z;
      // True 3D range (BUBBLE.md §A): a target 40 units overhead is 40 units away,
      // not co-located.
      const dist = len3(dx, dy, dz);
      if (dist > cfg.fire.range) continue;
      if (cfg.fire.requiresLineOfSight && !hasLineOfSightBetween(world, id, targetId)) continue;
      if (core.capacitor.cur <= cfg.energy.drawActive * dt) continue;

      // Fire.
      m.cycleTimer = cfg.fire.cycleTime;
      m.workedThisTick = true;
      m.heat += cfg.fire.heatPerShot ?? 0;
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

interface ChannelCtx {
  id: EntityId;
  m: ModuleRuntime;
  cfg: ModuleConfig;
  core: ShipCore;
  ref: TargetRef | undefined;
  /** Trigger level for this ship this tick (`held` semantics — no edge latch). */
  firing: boolean;
  myTf: Transform3D;
  dt: number;
}

/**
 * One tick of a `continuous` weapon. Every gate is the SAME gate the discrete
 * path applies — active state, trigger, lock (FLIGHT.md §2), live target, 3D
 * range, LoS, energy — evaluated fresh each tick, which is exactly what makes a
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
  // Charged like any other working module: EnergySystem bills `drawActive * dt`
  // and `heat.perSecondActive * dt` this tick. `fire.heatPerShot` is a per-SHOT
  // field and deliberately does not apply — a channel has no shots.
  m.workedThisTick = true;

  // A rising edge announces itself once, so the existing beam fire event (and
  // with it the module's `onFire` actions/sound) still fires exactly once per
  // trigger pull instead of 30 times a second.
  if (m.channel === null || m.channel.targetId !== targetId) {
    if (m.channel !== null) flushChannel(world, id, m); // target switch: bank belongs to the old ship
    m.channel = { targetId, hull: 0, absorbed: new Map(), eventTimer: 0 };
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
 * Mirrors the discrete path's checks in the same order.
 */
function channelTarget(world: World, ctx: ChannelCtx): EntityId | null {
  const { id, m, cfg, core, ref, firing, myTf, dt } = ctx;
  const fire = cfg.fire!;
  if (m.state !== "active") return null;
  if (!firing) return null;
  if (!ref?.locked) return null;
  const targetId = ref.targetId;
  if (targetId === null) return null;
  const tgtCore = world.shipCores.get(targetId);
  if (!tgtCore || tgtCore.hull <= 0) return null;
  const tgtTf = world.transforms.get(targetId)!;
  const dist = len3(tgtTf.pos.x - myTf.pos.x, tgtTf.pos.y - myTf.pos.y, tgtTf.pos.z - myTf.pos.z);
  if (dist > fire.range) return null;
  if (fire.requiresLineOfSight && !hasLineOfSightBetween(world, id, targetId)) return null;
  if (core.capacitor.cur <= cfg.energy.drawActive * dt) return null;
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
  channel: { hull: number; absorbed: Map<number, number> },
): void {
  for (const [hardpointIndex, amount] of channel.absorbed) {
    if (amount > 0) world.emit({ type: "shieldAbsorb", targetId, hardpointIndex, amount });
  }
  channel.absorbed.clear();
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
