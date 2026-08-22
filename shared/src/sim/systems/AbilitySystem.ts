import { abilityOf, type ModuleConfig } from "../../schemas/index.js";
import type { EntityId, ModuleRuntime } from "../components.js";
import { len3 } from "../math.js";
import type { World } from "../World.js";
import { transition } from "./ModuleSystem.js";

/**
 * AbilitySystem (owner 2026-08-22) — the cooldown-gated PULSES a hardpoint can
 * carry: the slowing ray (`slow`) and the repair field (`repairField`).
 *
 * ## Why a pulse rides the deploy toggle instead of a new order
 *
 * The pipeline already had two shapes of hardpoint control and neither fits:
 * a weapon is a TRIGGER (held, level-triggered, fires on its own cadence) and a
 * shield is a SWITCH (raise it, it stays up, lower it). A pulse is neither — it
 * is one discrete act with a cooldown after it — so the obvious move was a third
 * order kind, `activateModule`, and with it a wire schema change, a server order
 * validator, a client sender and a HUD branch.
 *
 * It buys nothing. A pulse maps EXACTLY onto the state machine already in
 * ModuleSystem if you read the deploy as the cast:
 *
 *   retracted ─(toggle)→ deploying(deployTime) → active ─[PULSE FIRES HERE]
 *        ▲                                                       │
 *        └──── cooldownSec on cycleTimer ── retracting ←─────────┘
 *
 * So one `moduleToggle` — the order the HUD's utility buttons already send, the
 * bots already plan, the netcode already validates and the offline session
 * already applies — is one pulse. `activation.deployTime` becomes the ray's
 * charge-up, `retractTime` its cool-off animation, and the module's own
 * `cycleTimer` (unused by anything without a `fire` block, exactly as the
 * countermeasure pod's is) carries the cooldown, which is ALREADY replicated and
 * already drawn as a ring by `ModuleButtons`. Nothing new travels on the wire
 * for the cooldown at all.
 *
 * The auto-retract at the end is what makes one tap one pulse: leaving the
 * module `active` would mean a pilot has to tap twice to fire twice, and the
 * second tap would be indistinguishable from "put my shield down".
 *
 * Runs AFTER ModuleSystem (so a toggle arriving this tick has already reached
 * `active` and fires this tick) and BEFORE TargetingSystem/CombatSystem (so a
 * pulse and the guns resolve against the same lock).
 */
export function abilitySystem(world: World, dt: number): void {
  ageSlows(world, dt);

  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      const ability = abilityOf(cfg);
      if (!ability) continue;

      // Cooldowns tick for every fitted emitter, used or not. Owned here rather
      // than in ModuleSystem for the same reason JettisonSystem owns the pod's:
      // the system that stamps a timer is the one that should burn it down.
      if (m.cycleTimer > 0) m.cycleTimer = Math.max(0, m.cycleTimer - dt);

      // `active` is the instant of the pulse and nothing else — the module is
      // put straight back down below, so it can never be found here twice for
      // one activation.
      if (m.state !== "active") continue;
      firePulse(world, id, m, cfg!);
      m.cycleTimer = ability.cooldownSec;
      m.workedThisTick = true;
      // Straight to `retracting` (or `retracted` when the module authors no
      // retract time), which is also what stops the pilot re-firing by holding
      // the button: the raise is refused while `cycleTimer` runs.
      if (cfg!.activation.retractTime <= 0) {
        transition(world, id, m, "retracted", cfg!.onDeactivate);
      } else {
        m.stateTimer = cfg!.activation.retractTime;
        transition(world, id, m, "retracting", cfg!.onDeactivate);
      }
    }
  }
}

/** Burn down live slows and free the hulls whose timers ran out. */
function ageSlows(world: World, dt: number): void {
  for (const [id, slow] of world.slows) {
    slow.remaining -= dt;
    if (slow.remaining > 0) continue;
    world.slows.delete(id);
    world.emit({ type: "slowExpired", entityId: id });
  }
}

/** Dispatch one activation to whichever pulse the module authored. */
function firePulse(world: World, casterId: EntityId, m: ModuleRuntime, cfg: ModuleConfig): void {
  if (cfg.slow) fireSlowingRay(world, casterId, m, cfg);
  else if (cfg.repairField) fireRepairField(world, casterId, m, cfg);
}

/**
 * One slowing-ray pulse: reach the caster's CURRENT LOCKED TARGET and slow it.
 *
 * The lock is the same lock a missile needs (FLIGHT.md §2) — deliberately, so a
 * pilot has one targeting concept and the ray answers the reticle they are
 * already reading. A pulse with no lock, a dead target or a target out of range
 * is SPENT anyway: the cooldown is stamped by the caller either way, because a
 * button that silently refuses to consume itself teaches a pilot to mash it.
 */
function fireSlowingRay(world: World, casterId: EntityId, m: ModuleRuntime, cfg: ModuleConfig): void {
  const slow = cfg.slow!;
  const ref = world.targets.get(casterId);
  const targetId = ref?.locked ? ref.targetId : null;
  const casterTf = world.transforms.get(casterId);
  world.emit({
    type: "abilityFired",
    entityId: casterId,
    hardpointIndex: m.hardpointIndex,
    moduleId: m.moduleId,
    kind: "slow",
    targetId,
    actions: cfg.onActivate,
  });
  if (targetId === null || casterTf === undefined) return;
  const targetCore = world.shipCores.get(targetId);
  const targetTf = world.transforms.get(targetId);
  // Hull, not mere existence: CleanupSystem removes a wreck at the END of the
  // tick, so a ship killed earlier this tick is still here with hull ≤ 0.
  if (!targetCore || targetCore.hull <= 0 || !targetTf) return;
  // True 3D range (BUBBLE.md §A), the same measure every weapon uses.
  const dist = len3(
    targetTf.pos.x - casterTf.pos.x,
    targetTf.pos.y - casterTf.pos.y,
    targetTf.pos.z - casterTf.pos.z,
  );
  if (dist > slow.range) return;

  applySlow(world, targetId, slow.factor, slow.durationSec, casterId);
}

/**
 * Put a slow on `targetId`, or refresh the one already there.
 *
 * THE STACKING RULE, in one place: a second pulse REFRESHES the duration and
 * takes the STRONGER factor; it never multiplies. Two rays on one hull is
 * therefore the better ray, not a parked hull, and a wing cannot chain 40% into
 * 64% into 78% by fitting more of the same module. Exported because the sim
 * test and any future source of a slow (a mine, a hazard) must go through the
 * one rule rather than writing the map themselves.
 */
export function applySlow(
  world: World,
  targetId: EntityId,
  factor: number,
  durationSec: number,
  sourceId: EntityId | null,
): void {
  const existing = world.slows.get(targetId);
  const stronger = existing === undefined || factor >= existing.factor;
  world.slows.set(targetId, {
    factor: stronger ? factor : existing.factor,
    // Refresh, never extend: `max` of the two remainders, so a weaker pulse
    // landing late cannot cut a stronger one short and a stronger one cannot be
    // truncated by the shorter timer it replaces.
    remaining: Math.max(existing?.remaining ?? 0, durationSec),
    sourceId: stronger ? sourceId : existing.sourceId,
  });
  world.emit({ type: "slowApplied", entityId: targetId, sourceId, factor, durationSec });
}

/**
 * One repair-field pulse: every ALLIED hull inside `radiusUnits` gains
 * `healAmount`, capped at its own maximum.
 *
 * SELF IS INCLUDED. The alternative — heal everyone but yourself — makes the
 * module strictly worse the moment you are the one being focused, which is
 * exactly when a support pilot presses it, and it would need a rule of its own
 * to explain in the Hangar. "Everything friendly in the bubble, me included" is
 * the version a pilot can predict without reading anything.
 *
 * Hull only, never shields: a shield's reserve IS its energy tank and refills on
 * its own rules, so repairing it here would be two systems paying for the same
 * thing. A wreck (hull ≤ 0) is not healed — a repair field is not a resurrection
 * — and neither is a ship on another team, decoy or rock.
 */
function fireRepairField(world: World, casterId: EntityId, m: ModuleRuntime, cfg: ModuleConfig): void {
  const field = cfg.repairField!;
  const casterTf = world.transforms.get(casterId);
  const myTeam = world.teams.get(casterId)?.team;
  world.emit({
    type: "abilityFired",
    entityId: casterId,
    hardpointIndex: m.hardpointIndex,
    moduleId: m.moduleId,
    kind: "repairField",
    targetId: null,
    actions: cfg.onActivate,
  });
  if (!casterTf || myTeam === undefined) return;

  for (const id of world.shipIds()) {
    if (world.teams.get(id)?.team !== myTeam) continue;
    const core = world.shipCores.get(id)!;
    if (core.hull <= 0) continue;
    const tf = world.transforms.get(id)!;
    const dist = len3(tf.pos.x - casterTf.pos.x, tf.pos.y - casterTf.pos.y, tf.pos.z - casterTf.pos.z);
    if (dist > field.radiusUnits) continue;
    const healed = Math.min(core.hullMax, core.hull + field.healAmount) - core.hull;
    // A hull already full is still IN the field; it simply gains nothing, and
    // no event is emitted for it — a floating "+0" is noise.
    if (healed <= 0) continue;
    core.hull += healed;
    world.emit({
      type: "hullRepaired",
      targetId: id,
      sourceId: casterId,
      amount: healed,
      moduleId: m.moduleId,
    });
  }
}

/**
 * Speed multiplier for one ship this tick: 1 unless a slowing ray is on it.
 *
 * It scales TOP SPEED and nothing else — the same knob `boost.speedMult` moves,
 * on the same line of `NavigationSystem`, which is why the client predictor
 * needs no second concept to stay in sync. Acceleration is deliberately
 * untouched: a slowed ship keeps its throttle response and its handling, so the
 * accel-limited approach in the integrator carries it DOWN to the new cap over a
 * beat instead of snapping its velocity, and being slowed reads as "I cannot
 * outrun this" rather than as a stutter in the controls.
 */
export function slowMultiplierFor(world: World, id: EntityId): number {
  const slow = world.slows.get(id);
  if (slow === undefined) return 1;
  return Math.max(0, 1 - slow.factor);
}
