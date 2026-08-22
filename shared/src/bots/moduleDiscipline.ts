import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { isInternalFamily } from "../schemas/common.js";
import { abilityOf, type ModuleConfig } from "../schemas/module.js";
import type { ShipSnapshot } from "../sim/ArenaSimulation.js";
import { dist3 } from "../sim/math.js";
import type { Order } from "../sim/orders.js";
import type { BotContext } from "./context.js";

export type ModuleDiscipline = BotprofileConfig["moduleDiscipline"];

/** Why a module toggle was emitted — surfaced for the Behavior Editor overlay. */
export type ModuleDecisionReason =
  | "ready"
  | "shield-engaged"
  | "shield-disengaged"
  | "energy-reserve"
  | "boost-requested"
  /** A slowing ray fired at the bot's locked target (2026-08-22). */
  | "slow-target"
  /** A repair field fired because an ally in radius is hurt. */
  | "repair-wing";

export interface ModuleDecision {
  hardpointIndex: number;
  moduleId: string;
  /** Desired state after the toggle. */
  activate: boolean;
  reason: ModuleDecisionReason;
}

export interface ModulePlan {
  orders: Order[];
  decisions: ModuleDecision[];
}

/**
 * `moduleDiscipline` (ROADMAP 5.1) — the bot's energy judgement, expressed
 * purely as `moduleToggle` orders so it runs through the exact same pipeline a
 * human's module buttons do.
 *
 * Rules, all config-driven:
 *  - **energyReserve** — a module is not *activated* while its own tank is below
 *    the reserve fraction; already-active modules are left alone (the sim
 *    cuts a module that actually runs its own tank dry, and retracting under
 *    load would thrash deploy timers).
 *  - **shieldOnlyWhenEngaged** — shield-family modules follow the chosen
 *    behaviour's `engaged` flag.
 *  - **collapse cooldown** — a shield whose reserve emptied is locked out by the
 *    sim for its authored `mitigation.collapseCooldownSec`; a bot waits it out
 *    rather than re-asking every tick. Not a profile knob: it is a sim rule that
 *    binds bots and players identically, and this is only the bot declining to
 *    shout at a closed door.
 *
 * Modules mid-transition (`deploying`/`retracting`) and reloading ones
 * are never toggled: the first would waste the deploy timer, the second is
 * ignored by the sim anyway.
 */
export function planModuleOrders(
  ctx: BotContext,
  configs: ConfigService,
  discipline: ModuleDiscipline,
  engaged: boolean,
): ModulePlan {
  const orders: Order[] = [];
  const decisions: ModuleDecision[] = [];

  for (const m of ctx.self.modules) {
    if (m.state === "deploying" || m.state === "retracting" || m.state === "reloading") continue;
    const cfg = configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg) continue;
    // Weapon racks are always on and gated only by their own cycle time.
    // Toggling them adds retract/deploy downtime for nothing; fireDiscipline
    // manages when they actually pull the trigger.
    if (cfg.fire) continue;
    // Never touch the internal bay (2026-07-31). Engine, generator,
    // transformer, countermeasure and sensors are the ship itself, not a power
    // budget to cycle — a bot shutting its own engine down to save a little
    // charge would simply stop flying.
    if (isInternalFamily(cfg.family)) continue;

    // SUPPORT PULSES (2026-08-22) take their own decision and then stop: their
    // toggle is an ACTIVATION, not a switch, so the "already on ⇒ leave it
    // alone" and energy-reserve rules below say nothing useful about them.
    if (abilityOf(cfg)) {
      const pulse = planPulse(ctx, cfg, m);
      if (pulse) {
        orders.push({ kind: "moduleToggle", hardpointIndex: m.hardpointIndex });
        decisions.push({ hardpointIndex: m.hardpointIndex, moduleId: m.moduleId, activate: true, reason: pulse });
      }
      continue;
    }

    const isActive = m.state === "active";
    const isShield = cfg.family === "shield";

    let want: boolean;
    let reason: ModuleDecisionReason;

    if (isShield && discipline.shieldOnlyWhenEngaged && !engaged) {
      want = false;
      reason = "shield-disengaged";
    } else if (isActive) {
      continue; // already on and nothing says otherwise
    } else if ((m.energyCapacity > 0 ? m.energy / m.energyCapacity : 1) < discipline.energyReserve) {
      continue; // reserve keeps a charge in the module tanks
    } else if (isShield && m.cycleTimer > 0) {
      // Collapsed shield, still serving `mitigation.collapseCooldownSec`. The
      // sim would refuse the raise anyway (ModuleSystem.collapseReady), so this
      // guard changes no outcome — it stops the bot re-issuing a dead toggle
      // every tick for up to 15 s, which would otherwise flood the order stream
      // and the Behavior Editor's decision log with a choice that never lands.
      continue;
    } else {
      want = true;
      reason = isShield && discipline.shieldOnlyWhenEngaged ? "shield-engaged" : "ready";
    }

    if (want === isActive) continue;
    orders.push({ kind: "moduleToggle", hardpointIndex: m.hardpointIndex });
    decisions.push({ hardpointIndex: m.hardpointIndex, moduleId: m.moduleId, activate: want, reason });
  }

  return { orders, decisions };
}

/**
 * Hull fraction below which a bot considers a wingman worth a repair pulse.
 * High enough that the field is used while the fight is still on rather than
 * saved for a hull that is already dead, low enough that a bot does not burn an
 * 18-second cooldown on a scratch.
 */
const REPAIR_HULL_FRACTION = 0.7;

/**
 * Whether to spend a support pulse this decision, and why — the whole of the
 * bot's judgement about the two 2026-08-22 modules.
 *
 * Deliberately minimal. A pulse has one input (is there something worth
 * pointing it at) and one cost (its cooldown), so a utility score would be
 * three numbers dressed up as a decision:
 *
 *  - SLOWING RAY — fire at the bot's locked target when it is inside the
 *    authored range. That is exactly the sim's own gate, so a bot never spends
 *    a cooldown on a pulse that cannot land.
 *  - REPAIR FIELD — fire when any ally in radius, the bot itself included, is
 *    under {@link REPAIR_HULL_FRACTION} of its hull. Same self-inclusion rule
 *    the module itself has, so a lone bot still heals itself.
 *
 * Returns null when the module is cold, mid-transition, or has nothing to do.
 */
function planPulse(
  ctx: BotContext,
  cfg: ModuleConfig,
  m: BotContext["self"]["modules"][number],
): ModuleDecisionReason | null {
  // The sim refuses a raise while the cooldown runs (`ModuleSystem.pulseReady`),
  // so asking anyway would be an order per decision tick that never lands —
  // against the bot's rate budget and noise in the Behavior Editor's log.
  if (m.cycleTimer > 0 || m.state !== "retracted") return null;

  if (cfg.slow) {
    if (!ctx.self.locked || ctx.target === null) return null;
    return ctx.distance <= cfg.slow.range ? "slow-target" : null;
  }
  if (cfg.repairField) {
    const radius = cfg.repairField.radiusUnits;
    const hurt = (s: ShipSnapshot): boolean =>
      s.hullMax > 0 && s.hull > 0 && s.hull / s.hullMax < REPAIR_HULL_FRACTION;
    if (hurt(ctx.self)) return "repair-wing";
    for (const ally of ctx.allies) {
      if (!hurt(ally)) continue;
      if (dist3(ctx.self.pos, ally.pos) <= radius) return "repair-wing";
    }
    return null;
  }
  return null;
}
