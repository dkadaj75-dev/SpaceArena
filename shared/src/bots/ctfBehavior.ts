import type { FlagSnapshot } from "../sim/ArenaSimulation.js";
import { dist3 } from "../sim/math.js";
import { registerBotBehavior, type BotBehavior, type BotPlan } from "./behaviors.js";
import { numParam, type BehaviorParams, type BotContext } from "./context.js";

/**
 * `objective` (owner 2026-07-31) — the behaviour that makes a bot play capture
 * the flag instead of merely fighting in a match that happens to have flags in
 * it.
 *
 * One behaviour rather than three, because the job is always the same shape —
 * "fly at the thing that matters most right now" — and only the thing changes:
 *
 *  1. Carrying the enemy flag ⇒ run for my own base.
 *  2. My flag is loose ⇒ go touch it home. A team that never recovers can never
 *     cash a run of its own, so this outranks starting a new one.
 *  3. My flag is stolen ⇒ hunt the carrier. Handled by aiming at them; the
 *     ordinary combat behaviours do the shooting.
 *  4. Otherwise ⇒ go take the enemy flag.
 *
 * Urgency is the score, so a bot with nothing objective-related nearby quietly
 * falls back to whatever fighting behaviour its profile declares. `engaged` is
 * left FALSE throughout: a bot on the objective is travelling, and letting it
 * claim an engagement would have module discipline raise a shield for a fight
 * that is not happening.
 */
const objective: BotBehavior = {
  score(ctx, params) {
    const job = chooseJob(ctx, params);
    return job ? job.urgency : 0;
  },
  plan(ctx, params) {
    const job = chooseJob(ctx, params);
    if (!job) return { aim: null, throttle: 0, boost: false, engaged: false };
    // Turn rate is speed-independent in this sim, so the only way to fly a
    // TIGHTER arc is to travel less. A runner at full throttle sails past its
    // own base and orbits it forever; easing off inside `arriveRange` is what
    // actually lets a ship enter the capture sphere.
    const range = Math.max(numParam(params, "arriveRange", 30), 1e-3);
    const distance = dist3(ctx.self.pos, { x: job.aim.x, y: job.aim.y ?? 0, z: job.aim.z });
    const close = distance < range;
    // A capture is blocked while our own flag is away. Once safely inside the
    // capture sphere, visibly wait instead of carrying enough throttle to orbit
    // the base indefinitely. Velocity drag brings this to a calm loiter.
    const holding = job.blockedAtHome && distance < numParam(params, "holdRange", 5);
    return {
      aim: job.aim,
      throttle: holding ? 0 : close ? numParam(params, "arriveThrottle", 0.4) : numParam(params, "throttle", 1),
      arrive: close && !holding && job.terminal,
      arriveRadius: job.arriveRadius,
      // A carrier CANNOT boost (the sim refuses it), so asking would only burn
      // energy and heat for nothing. Everyone else may run.
      boost: !job.carrying && numParam(params, "boostChance", 0.5) > ctx.rng(),
      engaged: false,
    } satisfies BotPlan;
  },
};

interface ObjectiveJob {
  aim: { x: number; y: number; z: number };
  urgency: number;
  carrying: boolean;
  blockedAtHome?: boolean;
  terminal: boolean;
  arriveRadius?: number;
}

function chooseJob(ctx: BotContext, params: BehaviorParams): ObjectiveJob | null {
  const flags = ctx.snapshot.flags;
  if (flags.length === 0) return null;

  const own = flags.find((f) => f.team === ctx.self.team);
  const enemyFlag = flags.find((f) => f.team !== ctx.self.team);
  const weights = ctx.profile.ctfWeights;

  // 1. I have the enemy flag: nothing else matters, go home.
  if (enemyFlag && enemyFlag.carrierId === ctx.self.id) {
    return {
      aim: own?.home ?? enemyFlag.home,
      urgency: numParam(params, "carryUrgency", 3) * (weights?.takeEnemyFlag ?? 1),
      carrying: true,
      terminal: true,
      arriveRadius: (own?.baseRadius ?? enemyFlag.baseRadius) + (ctx.self.colliderRadius ?? 0),
      blockedAtHome: own?.state !== "home",
    };
  }

  // 2. My flag is loose in space: touching it sends it home instantly, and
  //    until it IS home my team cannot score at all.
  if (own?.state === "dropped") {
    return { aim: own.pos, urgency: recoverUrgency(ctx, own, params) * (weights?.returnOwnFlag ?? 1), carrying: false, terminal: true, arriveRadius: (own.pickupRadius ?? 0) + (ctx.self.colliderRadius ?? 0) };
  }

  // 3. My flag is being carried: chase whoever has it.
  if (own?.state === "carried" && own.carrierId !== null) {
    const carrier = ctx.snapshot.ships.find((s) => s.id === own.carrierId);
    if (carrier) {
      return {
        aim: carrier.pos,
        urgency: numParam(params, "chaseUrgency", 1.6) * (weights?.killEnemyCarrier ?? 1),
        carrying: false,
        terminal: false,
      };
    }
  }

  // Our carrier needs a moving screen. Aim slightly toward home from them so
  // escorts do not ram the carrier or lag behind the fight.
  if (enemyFlag?.state === "carried" && enemyFlag.carrierId !== null) {
    const carrier = ctx.snapshot.ships.find((s) => s.id === enemyFlag.carrierId && s.team === ctx.self.team);
    if (carrier) {
      const home = own?.home ?? enemyFlag.home;
      return {
        aim: {
          x: carrier.pos.x + (home.x - carrier.pos.x) * 0.2,
          y: carrier.pos.y + (home.y - carrier.pos.y) * 0.2,
          z: carrier.pos.z + (home.z - carrier.pos.z) * 0.2,
        },
        urgency: numParam(params, "escortUrgency", 1.15) * (weights?.escortOwnCarrier ?? 1),
        carrying: false,
        terminal: false,
      };
    }
  }

  // 4. Nothing to defend: go get theirs. A flag already in someone else's hands
  //    is not takeable — leave it to the fighters.
  if (enemyFlag && enemyFlag.state !== "carried") {
    const take = numParam(params, "attackUrgency", 1) * (weights?.takeEnemyFlag ?? 1);
    const defend = own?.state === "home"
      ? numParam(params, "defendUrgency", 0.45) * (weights?.defendOwnBase ?? 1)
      : 0;
    return defend > take
      ? { aim: own!.home, urgency: defend, carrying: false, terminal: true, arriveRadius: own!.baseRadius + (ctx.self.colliderRadius ?? 0) }
      : { aim: enemyFlag.pos, urgency: take, carrying: false, terminal: true, arriveRadius: (enemyFlag.pickupRadius ?? 0) + (ctx.self.colliderRadius ?? 0) };
  }
  return null;
}

/**
 * How badly a loose friendly flag needs a rescue: more as its clock runs down,
 * and more when the bot is close enough to actually get there. A bot on the far
 * side of the arena should keep fighting rather than fly a doomed errand.
 */
function recoverUrgency(ctx: BotContext, own: FlagSnapshot, params: BehaviorParams): number {
  const base = numParam(params, "recoverUrgency", 2.2);
  const reach = Math.max(numParam(params, "recoverRange", 90), 1);
  const distance = dist3(ctx.self.pos, own.pos);
  return distance <= reach ? base : base * 0.5;
}

registerBotBehavior("objective", objective);

export { objective as objectiveBehavior };
