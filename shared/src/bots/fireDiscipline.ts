import { SIM_TICK_RATE } from "../constants.js";
import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { BotContext } from "./context.js";

export type FireDiscipline = BotprofileConfig["fireDiscipline"];

/** Why the bot chose its current trigger level. */
export type FireDecisionReason =
  | "fire"
  | "not-engaged"
  | "no-lock"
  | "no-armed-weapons"
  | "out-of-range"
  | "heat-headroom"
  | "energy-floor"
  | "burst-pause";

export interface FireDecision {
  fire: boolean;
  reason: FireDecisionReason;
}

/** Driver-owned hysteresis latch; mutable only by decideFire and reset on respawn. */
export interface FireDisciplineState {
  heatHeld: boolean;
}

/**
 * Decide the level-triggered fire flag. With no authored discipline, bots keep
 * the compatibility rule: fire whenever engaged with a lock.
 */
export function decideFire(
  ctx: BotContext,
  configs: ConfigService,
  fireDiscipline: FireDiscipline,
  engaged: boolean,
  state?: FireDisciplineState,
): FireDecision {
  if (!engaged) return { fire: false, reason: "not-engaged" };
  if (!ctx.self.locked) return { fire: false, reason: "no-lock" };
  if (!fireDiscipline) return { fire: true, reason: "fire" };

  const armed = ctx.self.modules.flatMap((runtime) => {
    if (runtime.state !== "active") return [];
    const config = configs.get<ModuleConfig>("module", runtime.moduleId);
    return config?.fire ? [{ runtime, config }] : [];
  });
  if (armed.length === 0) return { fire: false, reason: "no-armed-weapons" };

  const shortestRange = Math.min(...armed.map(({ config }) => config.fire!.range));
  const rangeMult = fireDiscipline.engageRangeMult ?? 1;
  if (ctx.distance > shortestRange * rangeMult) return { fire: false, reason: "out-of-range" };

  const heatHeadroom = fireDiscipline.heatHeadroom ?? 1;
  const heatFractions = armed.map(({ runtime, config }) => {
    const threshold = config.heat.overheatThreshold;
    return threshold > 0 ? runtime.heat / threshold : 0;
  });
  // One shared trigger drives every rack. A hot missile rack must not silence a
  // cool laser (the combat system already skips locked-out racks), so pause only
  // when every currently armed weapon has exhausted its headroom.
  if (state?.heatHeld) {
    const rearm = fireDiscipline.rearmHeatBelow ?? heatHeadroom;
    if (heatFractions.some((fraction) => fraction <= rearm)) state.heatHeld = false;
  }
  if (!state?.heatHeld && heatFractions.every((fraction) => fraction >= heatHeadroom)) {
    if (state) state.heatHeld = true;
  }
  if (state?.heatHeld ?? heatFractions.every((fraction) => fraction >= heatHeadroom)) {
    return { fire: false, reason: "heat-headroom" };
  }

  if (ctx.energyFraction < (fireDiscipline.minEnergyFraction ?? 0)) {
    return { fire: false, reason: "energy-floor" };
  }

  const burstSec = fireDiscipline.burstSec;
  if (burstSec !== undefined) {
    const burstTicks = Math.max(0, Math.ceil(burstSec * SIM_TICK_RATE));
    const pauseTicks = Math.max(0, Math.ceil((fireDiscipline.pauseSec ?? 0) * SIM_TICK_RATE));
    const period = burstTicks + pauseTicks;
    if (burstTicks === 0 || (period > 0 && ctx.driverTick % period >= burstTicks)) {
      return { fire: false, reason: "burst-pause" };
    }
  }

  return { fire: true, reason: "fire" };
}
