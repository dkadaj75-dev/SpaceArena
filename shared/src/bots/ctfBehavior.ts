import type { FlagSnapshot, ShipSnapshot } from "../sim/ArenaSimulation.js";
import { dist3, facingVec, segmentIntersectsSphere } from "../sim/math.js";
import { registerBotBehavior, type BotBehavior, type BotPlan } from "./behaviors.js";
import { numParam, type BehaviorParams, type BotContext } from "./context.js";

/**
 * `objective` (owner 2026-07-31) — the behaviour that makes a bot play capture
 * the flag instead of merely fighting in a match that happens to have flags in
 * it.
 *
 * One behaviour rather than three, because the job is always the same shape —
 * "fly at the thing that matters most right now" — and only the thing changes.
 * WHICH thing is no longer this behaviour's decision (D2, 2026-08-08): the team
 * role allocator hands every ship one claim per window, and the ladder below
 * reads it. Before that, ten bots each ran the whole ladder independently and
 * arrived at the same top rung, which is why a dropped flag drew the whole team
 * and a carrier ran home alone.
 *
 *  0. Carrying the enemy flag ⇒ run for my own base. Not a role: the flag in the
 *     hold outranks any board.
 *  1. `striker`      ⇒ go take the enemy flag.
 *  2. `interceptor`  ⇒ hunt whoever has ours; the combat behaviours do the shooting.
 *  3. `escort`       ⇒ screen our carrier — peel onto the nearest closing enemy,
 *     otherwise hold station ahead of them.
 *  4. `warden`       ⇒ recover our loose flag, else hold our base.
 *  5. `free`         ⇒ no objective at all, so the profile's combat behaviours win.
 *
 * Urgency is the score and stays personal: every rung multiplies by this bot's
 * own `ctfWeights`, so the allocator decides WHO and the profile decides HOW HARD.
 * `engaged` is FALSE for travel rungs — a bot on the objective is moving, and
 * claiming an engagement would raise a shield for a fight that is not happening —
 * and TRUE only for the escort peel, which is a fight by construction.
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
    // Nav waypoints are pass-through bearings, not arrival targets. Easing at
    // every graph node strands runners in the open and makes tunnel traversal a
    // stop-start zigzag instead of cruise flight.
    const close = job.terminal && distance < range;
    // A capture is blocked while our own flag is away. Once safely inside the
    // capture sphere, visibly wait instead of carrying enough throttle to orbit
    // the base indefinitely. Velocity drag brings this to a calm loiter.
    const holding = job.blockedAtHome && distance < numParam(params, "holdRange", 5);
    return {
      aim: job.aim,
      throttle: holding ? 0 : close ? numParam(params, "arriveThrottle", 0.4) : numParam(params, "throttle", 1),
      arrive: close && !holding && job.terminal,
      arriveRadius: job.arriveRadius,
      aimPriority: job.aimPriority,
      // A carrier CANNOT boost (the sim refuses it), so asking would only burn
      // energy and heat for nothing. Everyone else may run.
      boost: !job.carrying && numParam(params, "boostChance", 0.5) > ctx.rng(),
      engaged: job.engaged ?? false,
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
  aimPriority?: boolean;
  /** True only for a job that is itself a fight (the escort peel). */
  engaged?: boolean;
}

function chooseJob(ctx: BotContext, params: BehaviorParams): ObjectiveJob | null {
  const flags = ctx.snapshot.flags;
  if (flags.length === 0) return null;

  const own = flags.find((f) => f.team === ctx.self.team);
  const enemyFlag = flags.find((f) => f.team !== ctx.self.team);
  const weights = ctx.profile.ctfWeights;

  // 0. I have the enemy flag: nothing else matters, go home.
  if (enemyFlag && enemyFlag.carrierId === ctx.self.id) {
    return routed(ctx, {
      aim: own?.home ?? enemyFlag.home,
      urgency: numParam(params, "carryUrgency", 3) * (weights?.takeEnemyFlag ?? 1),
      carrying: true,
      terminal: true,
      arriveRadius: (own?.baseRadius ?? enemyFlag.baseRadius) + (ctx.self.colliderRadius ?? 0),
      blockedAtHome: own?.state !== "home",
    });
  }

  switch (ctx.role) {
    case "interceptor": {
      if (own?.state !== "carried" || own.carrierId === null) return null;
      const carrier = ctx.snapshot.ships.find((s) => s.id === own.carrierId);
      if (!carrier) return null;
      return {
        aim: carrier.pos,
        urgency: numParam(params, "chaseUrgency", 1.6) * (weights?.killEnemyCarrier ?? 1),
        carrying: false,
        terminal: false,
      };
    }
    case "escort": {
      if (!enemyFlag || enemyFlag.state !== "carried" || enemyFlag.carrierId === null) return null;
      const carrier = ctx.snapshot.ships.find((s) => s.id === enemyFlag.carrierId && s.team === ctx.self.team);
      if (!carrier) return null;
      return escortJob(ctx, params, carrier);
    }
    case "warden": {
      // 2. My flag is loose in space: touching it sends it home instantly, and
      //    until it IS home my team cannot score at all.
      if (own?.state === "dropped") {
        return routed(ctx, {
          aim: own.pos,
          urgency: recoverUrgency(ctx, own, params) * (weights?.returnOwnFlag ?? 1),
          carrying: false,
          terminal: true,
          arriveRadius: (own.pickupRadius ?? 0) + (ctx.self.colliderRadius ?? 0),
        });
      }
      if (!own) return null;
      // Hold the stand: it is both what the enemy has to reach to start a run and
      // where our own carrier can only cash once the flag is back on it.
      return routed(ctx, {
        aim: own.home,
        urgency: numParam(params, "defendUrgency", 0.45) * (weights?.defendOwnBase ?? 1),
        carrying: false,
        terminal: true,
        arriveRadius: own.baseRadius + (ctx.self.colliderRadius ?? 0),
      });
    }
    case "striker": {
      // A flag already in someone else's hands is not takeable — leave it to the
      // fighters (the allocator stops issuing the claim, but a window can lag an
      // event by a tick).
      if (!enemyFlag || enemyFlag.state === "carried") return null;
      return routed(ctx, {
        aim: enemyFlag.pos,
        urgency: numParam(params, "attackUrgency", 1) * (weights?.takeEnemyFlag ?? 1),
        carrying: false,
        terminal: true,
        arriveRadius: (enemyFlag.pickupRadius ?? 0) + (ctx.self.colliderRadius ?? 0),
      });
    }
    default:
      return null;
  }
}

/**
 * Escort screen. The former peel flew all the way to a pursuer's intercept point;
 * in a canyon that detached the screen into a side fight while the carrier kept
 * moving through the lane. A nearby threat now produces a reachable point on the
 * carrier→threat segment. Declaring it engaged still makes the escort fire
 * proactively, but movement remains coupled to the carrier every decision.
 */
function escortJob(
  ctx: BotContext,
  params: BehaviorParams,
  carrier: ShipSnapshot,
): ObjectiveJob {
  const weights = ctx.profile.ctfWeights;
  const threat = closingThreat(ctx, carrier, numParam(params, "peelRange", 140));
  if (threat) {
    const dx = threat.pos.x - carrier.pos.x;
    const dy = threat.pos.y - carrier.pos.y;
    const dz = threat.pos.z - carrier.pos.z;
    const distance = Math.max(Math.hypot(dx, dy, dz), 1e-6);
    const offset = Math.min(24, distance * 0.5);
    return {
      aim: {
        x: carrier.pos.x + dx / distance * offset,
        y: carrier.pos.y + dy / distance * offset,
        z: carrier.pos.z + dz / distance * offset,
      },
      urgency: numParam(params, "peelUrgency", 1.6) * (weights?.escortOwnCarrier ?? 1),
      carrying: false,
      terminal: true,
      arriveRadius: 6 + (ctx.self.colliderRadius ?? 0),
      engaged: true,
    };
  }
  // Route to the carrier itself. The former 20%-of-the-whole-run offset put the
  // escort ~90 units ahead at pickup time: safely absent from the screen it was
  // allocated to provide. Arrival steering supplies the non-ramming station.
  return routed(ctx, {
    aim: carrier.pos,
    urgency: numParam(params, "escortUrgency", 1.15) * (weights?.escortOwnCarrier ?? 1),
    carrying: false,
    terminal: true,
    arriveRadius: 10 + (ctx.self.colliderRadius ?? 0) + (carrier.colliderRadius ?? 0),
  });
}

/** Route objective travel through authored canyon/tunnel lanes when required. */
function routed(ctx: BotContext, job: ObjectiveJob): ObjectiveJob {
  const waypoint = ctx.navRoute?.route(ctx.self.pos, job.aim, (a, b) => routeCanSee(ctx, a, b));
  if (!waypoint) return job;
  const radius = ctx.self.colliderRadius ?? 0;
  const floor = ctx.staticWorld?.heightBelow(waypoint, 60);
  const clearance = Math.max(radius * 4, radius + 3);
  // Open-lane nodes are authored on the ground while bore nodes sit at tunnel
  // centre. Raising only to measured terrain clearance handles both without a
  // map/id special case and keeps the predictive floor guard from fighting the
  // route's pitch command every decision.
  const aim = floor ? { ...waypoint, y: Math.max(waypoint.y, floor.y + clearance) } : waypoint;
  return { ...job, aim, terminal: false, arriveRadius: undefined, aimPriority: true };
}

/**
 * Nav nodes on open lanes are authored on the terrain surface (tunnel nodes are
 * authored at bore centre). A terrain hit only at the destination therefore
 * means "the lane reaches this node", not "a wall blocks the lane".
 */
function routeCanSee(ctx: BotContext, a: Required<BotContext["self"]["pos"]>, b: Required<BotContext["self"]["pos"]>): boolean {
  const terrain = ctx.staticWorld?.raycast(a, b);
  if (terrain && terrain.t < 0.97) return false;
  for (const blocker of ctx.blockers) {
    if (segmentIntersectsSphere(a, b, { x: blocker.pos.x, y: blocker.pos.y ?? 0, z: blocker.pos.z }, blocker.radius)) return false;
  }
  return true;
}

/**
 * Nearest enemy actually closing on the carrier inside `range`. Snapshot order
 * is the stable tie break, so the screen is deterministic.
 */
function closingThreat(ctx: BotContext, carrier: ShipSnapshot, range: number): ShipSnapshot | null {
  let best: ShipSnapshot | null = null;
  let bestDistance = Infinity;
  for (const enemy of ctx.enemies) {
    if (enemy.hull <= 0) continue;
    const dx = carrier.pos.x - enemy.pos.x;
    const dy = carrier.pos.y - enemy.pos.y;
    const dz = carrier.pos.z - enemy.pos.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > range || distance >= bestDistance) continue;
    const bearing = enemy.velocity && Math.hypot(enemy.velocity.x, enemy.velocity.y, enemy.velocity.z) > 1e-3
      ? enemy.velocity
      : facingVec(enemy.heading, enemy.pitch, { x: 0, y: 0, z: 0 });
    if (dx * bearing.x + dy * (bearing.y ?? 0) + dz * bearing.z <= 0) continue;
    best = enemy;
    bestDistance = distance;
  }
  return best;
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
