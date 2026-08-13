import type { StaticSphereContact, StaticWorld } from "../collision/staticWorld.js";
import type { ArenaBounds, GamemodeConfig } from "../schemas/index.js";
import { orthonormalizeUp, spellAttitude, transportUp } from "./frame.js";

export interface StaticStepState {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  heading: number;
  pitch: number;
  up: { x: number; y: number; z: number };
}

export interface StaticStepEnvironment {
  staticWorld: StaticWorld;
  bounds: ArenaBounds;
  rule: GamemodeConfig["boundaryRule"];
}

interface StaticStepWorldEnvironment {
  staticWorld: StaticWorld;
  arena: { bounds: ArenaBounds };
  gamemode: { boundaryRule: GamemodeConfig["boundaryRule"] };
}

export interface PropResolution {
  contact: StaticSphereContact;
  closingSpeed: number;
}

export interface StaticStepCallbacks {
  onPropContact?: (resolution: PropResolution) => void;
  onBoxFace?: () => void;
}

export interface StaticStepResult {
  boxFaceCount: number;
}

/** Resolve at most two deepest static-mesh contacts, matching the live ship pass. */
export function resolvePropContacts(
  staticWorld: StaticWorld,
  state: StaticStepState,
  radius: number,
  onContact?: (resolution: PropResolution) => void,
): void {
  for (let iteration = 0; iteration < 2; iteration++) {
    const contact = staticWorld.sphereContact(state.position, radius);
    if (!contact || contact.depth <= 0) break;
    const vn = state.velocity.x * contact.normal.x + state.velocity.y * contact.normal.y + state.velocity.z * contact.normal.z;
    onContact?.({ contact, closingSpeed: -vn });
    state.position.x += contact.normal.x * contact.depth;
    state.position.y += contact.normal.y * contact.depth;
    state.position.z += contact.normal.z * contact.depth;
    if (vn < 0) {
      state.velocity.x -= vn * contact.normal.x;
      state.velocity.y -= vn * contact.normal.y;
      state.velocity.z -= vn * contact.normal.z;
    }
  }
}

/** Resolve every violated face of an authored box and return the contact count. */
export function resolveBoxBounds(
  bounds: Extract<ArenaBounds, { shape: "box" }>,
  rule: GamemodeConfig["boundaryRule"],
  state: StaticStepState,
  radius: number,
  onFace?: () => void,
): number {
  const faces: Array<{ x: number; y: number; z: number; penetration: number }> = [];
  const halfW = bounds.width / 2 - radius;
  const halfH = bounds.height / 2 - radius;
  const floor = bounds.floorY + radius;
  const ceiling = bounds.ceilingY - radius;
  if (state.position.x > halfW) faces.push({ x: 1, y: 0, z: 0, penetration: state.position.x - halfW });
  if (state.position.x < -halfW) faces.push({ x: -1, y: 0, z: 0, penetration: -halfW - state.position.x });
  if (state.position.z > halfH) faces.push({ x: 0, y: 0, z: 1, penetration: state.position.z - halfH });
  if (state.position.z < -halfH) faces.push({ x: 0, y: 0, z: -1, penetration: -halfH - state.position.z });
  if (state.position.y > ceiling) faces.push({ x: 0, y: 1, z: 0, penetration: state.position.y - ceiling });
  if (state.position.y < floor) faces.push({ x: 0, y: -1, z: 0, penetration: floor - state.position.y });

  for (const face of faces) {
    onFace?.();
    if (rule.type === "warning") continue;
    state.position.x -= face.x * face.penetration;
    state.position.y -= face.y * face.penetration;
    state.position.z -= face.z * face.penetration;
    if (rule.type === "bounce" || rule.type === "damageAndBounce") reflectState(state, face, rule.restitution ?? 1);
  }
  return faces.length;
}

/** Shared prediction/server static geometry step. Damage and cooldowns stay with CollisionSystem. */
export function resolveStaticStep(
  env: StaticStepEnvironment | StaticStepWorldEnvironment,
  state: StaticStepState,
  radius: number,
  dt: number,
  callbacks: StaticStepCallbacks = {},
): StaticStepResult {
  const bounds = "bounds" in env ? env.bounds : env.arena.bounds;
  const rule = "rule" in env ? env.rule : env.gamemode.boundaryRule;
  // Flight integration has already advanced position. Sweep from the previous
  // tick so a fast ship cannot cross a thin triangle without overlapping it.
  const hit = env.staticWorld.raycast(
    { x: state.position.x - state.velocity.x * dt, y: state.position.y - state.velocity.y * dt, z: state.position.z - state.velocity.z * dt },
    state.position,
  );
  if (hit) {
    // Leave a microscopic overlap so the ordinary contact pass still cancels
    // inward velocity and reports the impact; it then restores the exact shell.
    const shell = Math.max(0, radius - 1e-9);
    state.position.x = hit.point.x + hit.normal.x * shell;
    state.position.y = hit.point.y + hit.normal.y * shell;
    state.position.z = hit.point.z + hit.normal.z * shell;
  }
  resolvePropContacts(env.staticWorld, state, radius, callbacks.onPropContact);
  const boxFaceCount = bounds.shape === "box"
    ? resolveBoxBounds(bounds, rule, state, radius, callbacks.onBoxFace)
    : 0;
  return { boxFaceCount };
}

function reflectState(state: StaticStepState, outward: { x: number; y: number; z: number }, restitution: number): void {
  const vn = state.velocity.x * outward.x + state.velocity.y * outward.y + state.velocity.z * outward.z;
  if (vn > 0) {
    state.velocity.x -= (1 + restitution) * vn * outward.x;
    state.velocity.y -= (1 + restitution) * vn * outward.y;
    state.velocity.z -= (1 + restitution) * vn * outward.z;
  }
  const cp = Math.cos(state.pitch);
  const before = { x: cp * Math.cos(state.heading), y: Math.sin(state.pitch), z: cp * Math.sin(state.heading) };
  const noseOutward = before.x * outward.x + before.y * outward.y + before.z * outward.z;
  if (noseOutward <= 0) return;
  const after = {
    x: before.x - 2 * noseOutward * outward.x,
    y: before.y - 2 * noseOutward * outward.y,
    z: before.z - 2 * noseOutward * outward.z,
  };
  transportUp(before, after, state.up);
  const attitude = { heading: 0, pitch: 0 };
  spellAttitude(after.x, after.y, after.z, state.up, attitude);
  state.heading = attitude.heading;
  state.pitch = attitude.pitch;
  orthonormalizeUp(state.heading, state.pitch, state.up);
}
