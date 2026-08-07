import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { isInternalFamily } from "../schemas/common.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { ModuleSnapshot } from "../sim/ArenaSimulation.js";
import type { Order } from "../sim/orders.js";
import type { BotContext } from "./context.js";

export type ModuleDiscipline = BotprofileConfig["moduleDiscipline"];

/** Why a module toggle was emitted — surfaced for the Behavior Editor overlay. */
export type ModuleDecisionReason =
  | "heat-shutdown"
  | "heat-cooled"
  | "shield-engaged"
  | "shield-disengaged"
  | "energy-reserve"
  | "boost-requested";

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

/** Fraction of a module's own heat capacity currently used. */
function moduleHeatFraction(m: ModuleSnapshot): number {
  return m.heatCapacity > 0 ? m.heat / m.heatCapacity : 0;
}

/**
 * `moduleDiscipline` (ROADMAP 5.1) — the bot's heat/energy judgement, expressed
 * purely as `moduleToggle` orders so it runs through the exact same pipeline a
 * human's module buttons do.
 *
 * Rules, all config-driven:
 *  - **heatShutdownAt** — a module is retracted once *either* its own heat (vs
 *    its own `heatCapacity`) or the ship's hottest rack reaches the fraction.
 *    Retracting before the sim force-locks it is the whole skill axis: the rack
 *    comes back when the pilot says so instead of when the metal says so.
 *  - **reactivateBelow** — a retracted module is redeployed only once *both*
 *    fractions have fallen back below it (hysteresis, so bots don't chatter).
 *  - **energyReserve** — nothing is *activated* while the emptiest module tank is
 *    below the reserve fraction; already-active modules are left alone (the sim
 *    cuts a module that actually runs its own tank dry, and retracting under
 *    load would thrash deploy timers).
 *  - **shieldOnlyWhenEngaged** — shield-family modules follow the chosen
 *    behaviour's `engaged` flag.
 *
 * Modules mid-transition (`deploying`/`retracting`) and force-`overheated` ones
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
    if (m.state === "deploying" || m.state === "retracting" || m.state === "overheated") continue;
    const cfg = configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg) continue;
    // Weapon racks own a finite overheat/cooling cycle and automatically re-arm
    // after lockout. Toggling them pre-emptively adds retract/deploy downtime and
    // lets one hot rack suppress the whole trigger; fireDiscipline manages them.
    if (cfg.fire) continue;
    // Never touch the internal bay (2026-07-31). Engine, generator,
    // transformer, heatsink and sensors are the ship itself, not a power budget
    // to cycle — a bot shutting its own engine down to save heat would simply
    // stop flying.
    if (isInternalFamily(cfg.family)) continue;

    const isActive = m.state === "active";
    const heatFrac = Math.max(moduleHeatFraction(m), ctx.heatFraction);
    const isShield = cfg.family === "shield";

    let want: boolean;
    let reason: ModuleDecisionReason;

    if (heatFrac >= discipline.heatShutdownAt) {
      want = false;
      reason = "heat-shutdown";
    } else if (isShield && discipline.shieldOnlyWhenEngaged && !engaged) {
      want = false;
      reason = "shield-disengaged";
    } else if (isActive) {
      continue; // already on and nothing says otherwise
    } else if (heatFrac > discipline.reactivateBelow) {
      continue; // still too hot to come back
    } else if (ctx.energyFraction < discipline.energyReserve) {
      continue; // reserve keeps a charge in the module tanks
    } else {
      want = true;
      reason = isShield && discipline.shieldOnlyWhenEngaged ? "shield-engaged" : "heat-cooled";
    }

    if (want === isActive) continue;
    orders.push({ kind: "moduleToggle", hardpointIndex: m.hardpointIndex });
    decisions.push({ hardpointIndex: m.hardpointIndex, moduleId: m.moduleId, activate: want, reason });
  }

  return { orders, decisions };
}
