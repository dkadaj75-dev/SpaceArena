import type { ShipCore } from "../components.js";
import { len3, type Attitude } from "../math.js";
import { orthonormalizeUp, spellAttitude, transportUp } from "../frame.js";
import type { World } from "../World.js";
import { resolveStaticStep } from "../staticStep.js";

/** Scratch attitude for the boundary nose reflection — no per-contact allocation. */
const reflectedAttitude: Attitude = { heading: 0, pitch: 0 };
/** Scratch nose vectors for the frame transport across a bounce — no allocation. */
const noseBefore = { x: 0, y: 0, z: 0 };
const noseAfter = { x: 0, y: 0, z: 0 };

/**
 * CollisionSystem (1.7) — SPHERE resolution using the world spatial hash as a
 * planar (x,z) broadphase (BUBBLE.md §A: the hash stays 2D, every narrowphase
 * distance is 3D):
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
      const sumR = sc.radius + ac.radius;
      // |Δy| prefilter: the broadphase is planar, so a rock directly below the
      // ship is a candidate no matter how deep it sits.
      if (Math.abs(st.pos.y - at.pos.y) >= sumR) continue;
      let nx = st.pos.x - at.pos.x;
      let ny = st.pos.y - at.pos.y;
      let nz = st.pos.z - at.pos.z;
      let d = len3(nx, ny, nz);
      if (d >= sumR) continue;
      if (d === 0) {
        nx = 1;
        ny = 0;
        nz = 0;
        d = 1;
      }
      const inv = 1 / d;
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const push = sumR - d;
      st.pos.x += nx * push;
      st.pos.y += ny * push;
      st.pos.z += nz * push;

      // Impact damage only on a genuine high-speed collision: the closing speed
      // along the contact normal must exceed the threshold, and the pair must not
      // be on cooldown. Push-out on sustained overlap (low closing speed) deals no
      // damage, so a ship grinding against a rock is not ground to death.
      const vn = vel.x * nx + vel.y * ny + vel.z * nz; // >0 = separating, <0 = closing
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
        vel.y -= vn * ny;
        vel.z -= vn * nz;
      }
    }
  }

  const boundaryContactsThisTick = new Set<number>();

  // Shared static pass: prop mesh contacts followed by all authored box faces.
  // Prop cooldown keys are NEGATIVE, while asteroid pair keys are
  // positive (`sid * 0x100000 + aid`, with positive entity ids), so the two key
  // spaces provably cannot collide regardless of entity or placement counts.
  if (!world.staticWorld.isEmpty || world.arena.bounds.shape === "box") for (const sid of ships) {
    const core = world.shipCores.get(sid)!;
    if (core.hull <= 0) continue;
    const tf = world.transforms.get(sid)!;
    const vel = world.velocities.get(sid)!;
    const radius = world.colliders.get(sid)!.radius;
    const state = {
      position: tf.pos, velocity: vel, heading: tf.heading, pitch: tf.pitch, up: tf.up,
    };
    const result = resolveStaticStep(world, state, radius, dt, {
      onPropContact: ({ contact, closingSpeed }) => {
        const damage = world.staticWorld.configAt(contact.placementIndex)?.impactDamage ?? 0;
        const pairKey = -(sid * 0x100000 + contact.placementIndex + 1);
        if (core.hull > 0 && damage > 0 && closingSpeed > impactThreshold && !world.impactCooldowns.has(pairKey)) {
          applyRaw(world, sid, core, damage);
          world.impactCooldowns.set(pairKey, impactCooldown);
        }
      },
    });
    tf.heading = state.heading;
    tf.pitch = state.pitch;
    if (result.boxFaceCount > 0) {
      const rule = world.gamemode.boundaryRule;
      if (core.hull > 0 && (rule.type === "damage" || rule.type === "damageAndBounce")) {
        applyRaw(world, sid, core, rule.damagePerSec * dt);
      }
      boundaryContactsThisTick.add(sid);
      if (!world.boundaryContacts.has(sid)) {
        world.emit({ type: "boundaryHit", entityId: sid, rule: world.gamemode.boundaryRule.type });
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
      const sumR = cola.radius + colb.radius;
      // Vertically separated ships pass each other cleanly in the bubble.
      if (Math.abs(ta.pos.y - tb.pos.y) >= sumR) continue;
      let nx = ta.pos.x - tb.pos.x;
      let ny = ta.pos.y - tb.pos.y;
      let nz = ta.pos.z - tb.pos.z;
      let d = len3(nx, ny, nz);
      if (d >= sumR) continue;
      if (d === 0) {
        nx = 1;
        ny = 0;
        nz = 0;
        d = 1;
      }
      const inv = 1 / d;
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const half = (sumR - d) / 2;
      ta.pos.x += nx * half;
      ta.pos.y += ny * half;
      ta.pos.z += nz * half;
      tb.pos.x -= nx * half;
      tb.pos.y -= ny * half;
      tb.pos.z -= nz * half;
    }
  }

  // Ship vs boundary.
  for (const sid of ships) {
    const core = world.shipCores.get(sid)!;
    if (core.hull <= 0) continue;
    if (world.arena.bounds.shape !== "box") resolveBoundary(world, sid, core, dt, boundaryContactsThisTick);
  }
  world.boundaryContacts.clear();
  for (const sid of boundaryContactsThisTick) world.boundaryContacts.add(sid);
}

function resolveBoundary(
  world: World,
  sid: number,
  core: ShipCore,
  dt: number,
  contactsThisTick: Set<number>,
): void {
  const bounds = world.arena.bounds;
  const rule = world.gamemode.boundaryRule;
  const tf = world.transforms.get(sid)!;
  const col = world.colliders.get(sid)!;
  const vel = world.velocities.get(sid)!;

  let outward: { x: number; y: number; z: number } | null = null;
  let penetration = 0;

  if (bounds.shape === "sphere") {
    const floorLimit = bounds.floorY === undefined ? undefined : bounds.floorY + col.radius;
    if (floorLimit !== undefined && tf.pos.y < floorLimit) {
      // `outward` follows the shell convention (out of the play volume), so
      // this is the negative of the floor's inward plane normal [0, 1, 0].
      outward = { x: 0, y: -1, z: 0 };
      penetration = floorLimit - tf.pos.y;
    } else {
      // The bubble: one radial test, so climbing out through the "top" is bounded
      // exactly like flying out sideways (BUBBLE.md §A).
      const d = len3(tf.pos.x, tf.pos.y, tf.pos.z);
      const limit = bounds.radius - col.radius;
      if (d > limit) {
        const inv = d === 0 ? 0 : 1 / d;
        outward = { x: tf.pos.x * inv, y: tf.pos.y * inv, z: tf.pos.z * inv };
        penetration = d - limit;
      }
    }
  } else if (bounds.shape === "rect") {
    // Rect arenas are boxes: x walls, z walls, plus a real ceiling/floor.
    const halfW = bounds.width / 2 - col.radius;
    const halfH = bounds.height / 2 - col.radius;
    const halfV = bounds.verticalExtent / 2 - col.radius;
    if (tf.pos.x > halfW) {
      outward = { x: 1, y: 0, z: 0 };
      penetration = tf.pos.x - halfW;
    } else if (tf.pos.x < -halfW) {
      outward = { x: -1, y: 0, z: 0 };
      penetration = -halfW - tf.pos.x;
    } else if (tf.pos.z > halfH) {
      outward = { x: 0, y: 0, z: 1 };
      penetration = tf.pos.z - halfH;
    } else if (tf.pos.z < -halfH) {
      outward = { x: 0, y: 0, z: -1 };
      penetration = -halfH - tf.pos.z;
    } else if (tf.pos.y > halfV) {
      outward = { x: 0, y: 1, z: 0 };
      penetration = tf.pos.y - halfV;
    } else if (tf.pos.y < -halfV) {
      outward = { x: 0, y: -1, z: 0 };
      penetration = -halfV - tf.pos.y;
    }
  }

  if (!outward || penetration <= 0) return;

  contactsThisTick.add(sid);
  // Boundary contact is an edge event, not a per-tick event. Besides reducing
  // network traffic, this guarantees warning audio cannot machine-gun while a
  // ship remains pressed against a non-repositioning warning boundary.
  if (!world.boundaryContacts.has(sid)) {
    world.emit({ type: "boundaryHit", entityId: sid, rule: rule.type });
  }

  if (rule.type === "warning") return;

  // Reposition to the boundary.
  tf.pos.x -= outward.x * penetration;
  tf.pos.y -= outward.y * penetration;
  tf.pos.z -= outward.z * penetration;

  if (rule.type === "bounce" || rule.type === "damageAndBounce") {
    const restitution = rule.restitution ?? 1;
    const vn = vel.x * outward.x + vel.y * outward.y + vel.z * outward.z;
    if (vn > 0) {
      vel.x -= (1 + restitution) * vn * outward.x;
      vel.y -= (1 + restitution) * vn * outward.y;
      vel.z -= (1 + restitution) * vn * outward.z;
    }

    // Powered flight reconstructs velocity from attitude on every navigation
    // tick. Reflect the nose as well as the current velocity so a level-triggered
    // throttle order continues inward instead of immediately overwriting the
    // bounce and pinning the ship to the wall.
    const cosPitch = Math.cos(tf.pitch);
    const noseX = cosPitch * Math.cos(tf.heading);
    const noseY = Math.sin(tf.pitch);
    const noseZ = cosPitch * Math.sin(tf.heading);
    const noseOutward = noseX * outward.x + noseY * outward.y + noseZ * outward.z;
    if (noseOutward > 0) {
      const reflectedX = noseX - 2 * noseOutward * outward.x;
      const reflectedY = noseY - 2 * noseOutward * outward.y;
      const reflectedZ = noseZ - 2 * noseOutward * outward.z;
      // The persisted up rides the SAME rotation the nose just made (minimal
      // rotation from old nose to reflected nose, flight-frame handoff), so a
      // rolled ship keeps its roll across the bounce instead of having the
      // frame silently reset to the derived spelling — which would snap the
      // hull and the chase camera by whatever roll the ship was carrying.
      noseBefore.x = noseX;
      noseBefore.y = noseY;
      noseBefore.z = noseZ;
      noseAfter.x = reflectedX;
      noseAfter.y = reflectedY;
      noseAfter.z = reflectedZ;
      transportUp(noseBefore, noseAfter, tf.up);
      // The reflected DIRECTION is unambiguous; the (heading, pitch) pair that
      // names it is not, and picking the wrong one snaps every consumer of the
      // coordinates. The spelling follows the transported up (`spellAttitude`),
      // so an inverted bounce stays inverted and the numbers move as little as
      // the nose does. Under the legacy clamp the hull can never be inverted,
      // so this resolves to the old upright atan2/asin pair. Orthonormalized
      // last: a reflection is a controlled boundary, exactly where numerical
      // drift is corrected.
      spellAttitude(reflectedX, reflectedY, reflectedZ, tf.up, reflectedAttitude);
      tf.heading = reflectedAttitude.heading;
      tf.pitch = reflectedAttitude.pitch;
      orthonormalizeUp(tf.heading, tf.pitch, tf.up);
    }
  }
  if (rule.type === "damage" || rule.type === "damageAndBounce") {
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
    const pos = world.transforms.get(sid)!.pos;
    world.emit({
      type: "entityDestroyed",
      entityId: sid,
      killerId: null,
      isAsteroid: false,
      team: world.teams.get(sid)?.team,
      pos: { x: pos.x, y: pos.y, z: pos.z },
    });
  }
}
