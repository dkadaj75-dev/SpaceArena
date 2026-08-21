import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { isInternalFamily } from "../schemas/common.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { Order } from "../sim/orders.js";
import type { BotContext } from "./context.js";

export type ModuleDiscipline = BotprofileConfig["moduleDiscipline"];

/** Why a module toggle was emitted — surfaced for the Behavior Editor overlay. */
export type ModuleDecisionReason =
  | "ready"
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
