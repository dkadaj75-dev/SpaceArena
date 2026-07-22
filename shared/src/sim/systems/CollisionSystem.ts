import type { ShipCore } from "../components.js";
import type { World } from "../World.js";

/**
 * CollisionSystem (1.7) — planar circle resolution using the world spatial hash:
 *   - ship vs asteroid: push the ship out; if closing speed > tuning
 *     `impactSpeedThreshold`, the asteroid's `impactDamage` is dealt to hull.
 *   - ship vs ship: symmetric push-out (no damage).
 *   - ship vs boundary: per gamemode `boundaryRule` — bounce (reflect + reposition),
 *     damage (reposition + damagePerSec), warning (emit only).
 */
export function collisionSystem(world: World, dt: number): void {
  const ships = world.shipIds();
  const impactThreshold = world.tuning.impactSpeedThreshold ?? 6;
  const impactCooldown = world.tuning.impactDamageCooldown ?? 1.0;

  // Age out per-pair impact-damage immunity.
  for (const [key, remaining] of world.impactCooldowns) {
    const next = remaining - dt;
    if (next <= 0) world.impactCooldowns.delete(key);
    else world.impactCooldowns.set(key, next);
  }

  // Ship vs asteroid.
  for (const sid of ships) {
    const core = world.shipCores.get(sid)!;
    if (core.hull <= 0) continue;
    const st = world.transforms.get(sid)!;
    const sc = world.colliders.get(sid)!;
    const vel = world.velocities.get(sid)!;
    const candidates = world.spatial.queryCircle(st.pos.x, st.pos.z, sc.radius + 10);
    for (const aid of candidates) {
      const ast = world.asteroids.get(aid);
      if (!ast || ast.state === "destroyed") continue;
      const at = world.transforms.get(aid)!;
      const ac = world.colliders.get(aid)!;
      let nx = st.pos.x - at.pos.x;
      let nz = st.pos.z - at.pos.z;
      let d = Math.sqrt(nx * nx + nz * nz);
      const sumR = sc.radius + ac.radius;
      if (d >= sumR) continue;
      if (d === 0) {
        nx = 1;
        nz = 0;
        d = 1;
      }
      const inv = 1 / d;
      nx *= inv;
      nz *= inv;
      const push = sumR - d;
      st.pos.x += nx * push;
      st.pos.z += nz * push;

      // Impact damage only on a genuine high-speed collision: the closing speed
      // along the contact normal must exceed the threshold, and the pair must not
      // be on cooldown. Push-out on sustained overlap (low closing speed) deals no
      // damage, so a ship grinding against a rock is not ground to death.
      const vn = vel.x * nx + vel.z * nz; // >0 = separating, <0 = closing
      const closingSpeed = -vn;
      const pairKey = sid * 0x100000 + aid;
      if (
        ast.impactDamage > 0 &&
        closingSpeed > impactThreshold &&
        !world.impactCooldowns.has(pairKey)
      ) {
        applyRaw(world, sid, core, ast.impactDamage);
        world.impactCooldowns.set(pairKey, impactCooldown);
      }

      // Cancel inward velocity component.
      if (vn < 0) {
        vel.x -= vn * nx;
        vel.z -= vn * nz;
      }
    }
  }

  // Ship vs ship (each unordered pair once).
  for (let i = 0; i < ships.length; i++) {
    const a = ships[i]!;
    const ca = world.shipCores.get(a)!;
    if (ca.hull <= 0) continue;
    const ta = world.transforms.get(a)!;
    const cola = world.colliders.get(a)!;
    for (let j = i + 1; j < ships.length; j++) {
      const b = ships[j]!;
      const cb = world.shipCores.get(b)!;
      if (cb.hull <= 0) continue;
      const tb = world.transforms.get(b)!;
      const colb = world.colliders.get(b)!;
      let nx = ta.pos.x - tb.pos.x;
      let nz = ta.pos.z - tb.pos.z;
      let d = Math.sqrt(nx * nx + nz * nz);
      const sumR = cola.radius + colb.radius;
      if (d >= sumR) continue;
      if (d === 0) {
        nx = 1;
        nz = 0;
        d = 1;
      }
      const inv = 1 / d;
      nx *= inv;
      nz *= inv;
      const half = (sumR - d) / 2;
      ta.pos.x += nx * half;
      ta.pos.z += nz * half;
      tb.pos.x -= nx * half;
      tb.pos.z -= nz * half;
    }
  }

  // Ship vs boundary.
  for (const sid of ships) {
    const core = world.shipCores.get(sid)!;
    if (core.hull <= 0) continue;
    resolveBoundary(world, sid, core, dt);
  }
}

function resolveBoundary(world: World, sid: number, core: ShipCore, dt: number): void {
  const bounds = world.arena.bounds;
  const rule = world.gamemode.boundaryRule;
  const tf = world.transforms.get(sid)!;
  const col = world.colliders.get(sid)!;
  const vel = world.velocities.get(sid)!;

  let outward: { x: number; z: number } | null = null;
  let penetration = 0;

  if (bounds.shape === "circle") {
    const d = Math.sqrt(tf.pos.x * tf.pos.x + tf.pos.z * tf.pos.z);
    const limit = bounds.radius - col.radius;
    if (d > limit) {
      const inv = d === 0 ? 0 : 1 / d;
      outward = { x: tf.pos.x * inv, z: tf.pos.z * inv };
      penetration = d - limit;
    }
  } else {
    const halfW = bounds.width / 2 - col.radius;
    const halfH = bounds.height / 2 - col.radius;
    if (tf.pos.x > halfW) {
      outward = { x: 1, z: 0 };
      penetration = tf.pos.x - halfW;
    } else if (tf.pos.x < -halfW) {
      outward = { x: -1, z: 0 };
      penetration = -halfW - tf.pos.x;
    } else if (tf.pos.z > halfH) {
      outward = { x: 0, z: 1 };
      penetration = tf.pos.z - halfH;
    } else if (tf.pos.z < -halfH) {
      outward = { x: 0, z: -1 };
      penetration = -halfH - tf.pos.z;
    }
  }

  if (!outward || penetration <= 0) return;

  world.emit({ type: "boundaryHit", entityId: sid, rule: rule.type });

  if (rule.type === "warning") return;

  // Reposition to the boundary.
  tf.pos.x -= outward.x * penetration;
  tf.pos.z -= outward.z * penetration;

  if (rule.type === "bounce") {
    const restitution = rule.restitution ?? 1;
    const vn = vel.x * outward.x + vel.z * outward.z;
    if (vn > 0) {
      vel.x -= (1 + restitution) * vn * outward.x;
      vel.z -= (1 + restitution) * vn * outward.z;
    }
  } else if (rule.type === "damage") {
    applyRaw(world, sid, core, rule.damagePerSec * dt);
  }
}

/** Direct hull damage (impact/boundary) — no resist/shield, emits events. */
function applyRaw(world: World, sid: number, core: ShipCore, amount: number): void {
  const wasAlive = core.hull > 0;
  core.hull -= amount;
  world.emit({ type: "damage", targetId: sid, sourceId: null, amount, damageType: "kinetic", isAsteroid: false });
  if (wasAlive && core.hull <= 0) {
    core.hull = 0;
    world.emit({
      type: "entityDestroyed",
      entityId: sid,
      killerId: null,
      isAsteroid: false,
      team: world.teams.get(sid)?.team,
    });
  }
}
