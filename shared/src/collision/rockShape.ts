import type { RockShapeConfig } from "../schemas/asteroid.js";

/**
 * ROCK SHAPE — one deterministic description of what an asteroid IS, shared by
 * the sim's collision and the client's mesh builder.
 *
 * ## Why a shared shape at all
 *
 * Until 2026-08-15 a rock was a GLB in the renderer and a SPHERE in the sim, and
 * the two could only be reconciled by shrinking the sphere until it hid inside
 * the silhouette (`asteroid.colliderScale`). That trade has no good setting: a
 * sphere sized to the widest lobe kills pilots in clear space, and a sphere
 * inscribed in the narrowest one lets shots fly straight through visible rock.
 *
 * The fix is to stop having two shapes. An asteroid authors ONE shape spec; the
 * sim collides against it and the client tessellates the very same field into
 * its render mesh, so "what you see" and "what you hit" are the same surface by
 * construction — no baked collision mesh to fall out of sync, and nothing read
 * back out of Babylon (which the server does not have).
 *
 * ## The representation: a star-shaped radial field
 *
 * A rock is `r(d)` — the surface distance from the body centre along a unit
 * direction `d`, in units of the rock's nominal radius. It is built from:
 *
 *  - **lobes**: offset ellipsoids, unioned by taking the largest exit distance.
 *    One lobe is an ordinary potato; a stretched one is a splinter; two or three
 *    partly-overlapping ones are a contact binary or a rubble knot. Every lobe
 *    must contain the body origin (the schema enforces it), which is exactly the
 *    condition that keeps the union star-shaped — the property this whole
 *    representation rests on.
 *  - **noise**: a fixed sum of sine waves over the sphere. Deterministic on
 *    every JS engine (no tables, no hashing of floats), smooth, and evaluable in
 *    closed form at any direction — a lookup-free `r(d)` is what makes the
 *    narrowphase cheap.
 *  - **craters**: angular bowls with a raised rim, subtracted from the surface.
 *  - **facets**: plane cuts, `min`-ed into the surface, for angular shards.
 *
 * ### Why not a convex hull / SAT
 *
 * A convex hull cannot express the two things this content most needs — the
 * waist of a contact binary and the dish of a crater — so the "bounces off empty
 * space" complaint would simply move to the concavities.
 *
 * The radial field gives concavity support cheaply: one evaluation is a handful
 * of dot products plus ~9 `sin` calls, with no traversal, no allocation and no
 * per-instance data — the same resolved shape object is shared by every
 * placement of a config. See {@link rockSphereContact} and
 * {@link rockSegmentEntry} for the bounding-sphere early-outs that keep it off
 * the hot path entirely for the rocks a ship is nowhere near.
 *
 * ### Its limit, and the mesh that sits beside it
 *
 * `r(d)` is single-valued, so the field can only describe a body that is
 * STAR-SHAPED about its centre. A sculpted rock generally is not, and its
 * silhouette exists nowhere but its triangles — refitting a field to one would
 * produce a second, disagreeing shape. Since 2026-08-18 the shipped catalogue is
 * exactly that: sculpted GLBs collided against a baked triangle BVH
 * (`rockCollider.ts`), which is what the whole pack now uses. This field remains
 * the cheaper representation and the one the client can tessellate, so a config
 * that authors a `shape` still wins over one that authors a mesh.
 *
 * ## Determinism
 *
 * Everything here is pure `Math` on doubles in a fixed order, driven by integer
 * seeds from content. There is no wall clock, no `Math.random`, no iteration
 * over a hash map, and no reliance on transcendental precision beyond what IEEE
 * doubles plus a shared engine build already give the rest of the sim.
 */

/** Waves per octave in the surface noise. Three is enough to kill visible banding. */
const WAVES_PER_OCTAVE = 3;
/** Directions sampled to measure a resolved shape's radius extremes. */
const EXTENT_SAMPLES = 2048;
/**
 * Safety factor on the sampled maximum. The sampled directions are ~4.5 degrees
 * apart, so a peak can hide between two of them; the broadphase sphere must be a
 * genuine upper bound or a hit can be rejected before the narrow phase ever runs.
 */
const MAX_RADIUS_MARGIN = 1.04;
/** Matching slack under the sampled minimum, so the inner sphere is a true lower bound. */
const MIN_RADIUS_MARGIN = 0.96;
/** Golden angle, for evenly spread sample/feature directions on the sphere. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Floor on the radial field; a crater stack can never eat the body. */
const MIN_FIELD_RADIUS = 0.12;

/**
 * A shape spec compiled into flat typed arrays. Built once per asteroid config
 * and shared by every placement of it, so a narrowphase touches only read-only
 * memory and allocates nothing.
 *
 * All radii are in units of the asteroid's nominal radius; callers multiply by
 * the placement's world radius.
 */
export interface ResolvedRockShape {
  /** Per lobe: `ox, oy, oz, 1/rx, 1/ry, 1/rz`. */
  readonly lobes: Float64Array;
  /** Per wave: `ux, uy, uz, frequency, amplitude, phase`. */
  readonly waves: Float64Array;
  /** Overall multiplier on the (unit-amplitude) wave sum. */
  readonly noiseAmplitude: number;
  /** Per crater: `cx, cy, cz, cos(angularRadius), depth, rim`. */
  readonly craters: Float64Array;
  /** Per facet plane: `nx, ny, nz, distance`. */
  readonly facets: Float64Array;
  /** Largest surface radius, rounded UP — the conservative broadphase sphere. */
  readonly maxRadius: number;
  /** Smallest surface radius, rounded DOWN — everything inside it is solid rock. */
  readonly minRadius: number;
  /** Mean surface radius — the honest single-sphere stand-in for coarse consumers. */
  readonly meanRadius: number;
}

/** A contact between a probe sphere and a rock surface. Reused; never allocated per hit. */
export interface RockContact {
  /** Unit outward normal, world space (radial from the body centre). */
  nx: number;
  ny: number;
  nz: number;
  /** Overlap along the normal, world units. */
  depth: number;
}

/** A mutable unit quaternion (the asteroid's world orientation). */
export interface RockQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/* ------------------------------------------------------------------ */
/* Deterministic small-integer PRNG (same mixer the client spin used).  */
/* ------------------------------------------------------------------ */

function mix32(value: number): number {
  let v = value | 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return (v ^ (v >>> 16)) >>> 0;
}

/** Deterministic 0..1 stream from an integer seed. */
function stream(seed: number): () => number {
  let state = mix32(seed) || 1;
  return () => {
    state = mix32(state + 0x9e3779b9);
    return state / 0x100000000;
  };
}

/**
 * `index`-th direction of a golden-spiral sphere covering, rotated about Y by
 * `phase`. Even coverage with no clustering at the poles and no random rejection
 * loop, which is what a fixed sample budget needs.
 */
function spiralDirection(index: number, count: number, phase: number, out: { x: number; y: number; z: number }): void {
  const y = 1 - (2 * index + 1) / count;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index + phase;
  out.x = Math.cos(theta) * ring;
  out.y = y;
  out.z = Math.sin(theta) * ring;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

const resolvedCache = new WeakMap<RockShapeConfig, ResolvedRockShape>();
const sampleDir = { x: 0, y: 0, z: 0 };

/**
 * Compile a spec (cached per spec object). Callers may resolve on every access;
 * the extent sampling that dominates the cost runs exactly once per config.
 */
export function resolveRockShape(spec: RockShapeConfig): ResolvedRockShape {
  const cached = resolvedCache.get(spec);
  if (cached) return cached;
  const built = buildRockShape(spec);
  resolvedCache.set(spec, built);
  return built;
}

function buildRockShape(spec: RockShapeConfig): ResolvedRockShape {
  const lobes = new Float64Array(spec.lobes.length * 6);
  spec.lobes.forEach((lobe, i) => {
    const offset = lobe.offset ?? [0, 0, 0];
    lobes[i * 6] = offset[0];
    lobes[i * 6 + 1] = offset[1];
    lobes[i * 6 + 2] = offset[2];
    lobes[i * 6 + 3] = 1 / lobe.radii[0];
    lobes[i * 6 + 4] = 1 / lobe.radii[1];
    lobes[i * 6 + 5] = 1 / lobe.radii[2];
  });

  // --- surface noise: octaves of three waves each, weights halving per octave.
  const octaves = spec.noise.octaves;
  const waveCount = octaves * WAVES_PER_OCTAVE;
  const waves = new Float64Array(waveCount * 6);
  const rand = stream(spec.seed ^ 0x5f356495);
  let weightSum = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const frequency = spec.noise.frequency * Math.pow(2, octave);
    const weight = Math.pow(0.5, octave);
    for (let k = 0; k < WAVES_PER_OCTAVE; k++) {
      const index = octave * WAVES_PER_OCTAVE + k;
      // Wave directions come off the same spiral the samples do, offset per
      // octave, so two octaves never line up into a visible stripe.
      spiralDirection(index, waveCount, rand() * Math.PI * 2, sampleDir);
      waves[index * 6] = sampleDir.x;
      waves[index * 6 + 1] = sampleDir.y;
      waves[index * 6 + 2] = sampleDir.z;
      waves[index * 6 + 3] = frequency;
      waves[index * 6 + 4] = weight;
      waves[index * 6 + 5] = rand() * Math.PI * 2;
      weightSum += weight;
    }
  }
  // Normalize so the wave sum lands in [-1, 1] and `amplitude` means what it says.
  if (weightSum > 0) for (let i = 0; i < waveCount; i++) waves[i * 6 + 4]! /= weightSum;

  // --- craters: evenly spread bowls with a raised rim.
  const craterSpec = spec.craters;
  const craterCount = craterSpec?.count ?? 0;
  const craters = new Float64Array(craterCount * 6);
  if (craterSpec && craterCount > 0) {
    const craterPhase = stream(spec.seed ^ 0x2c1b3c6d)() * Math.PI * 2;
    const cosR = Math.cos((craterSpec.radiusDeg * Math.PI) / 180);
    for (let i = 0; i < craterCount; i++) {
      spiralDirection(i, craterCount, craterPhase, sampleDir);
      craters[i * 6] = sampleDir.x;
      craters[i * 6 + 1] = sampleDir.y;
      craters[i * 6 + 2] = sampleDir.z;
      craters[i * 6 + 3] = cosR;
      craters[i * 6 + 4] = craterSpec.depth;
      craters[i * 6 + 5] = craterSpec.rim;
    }
  }

  // --- facet planes: cut at a fraction of the lobe radius in their own
  // direction, so a cut always shaves the surface instead of amputating a lobe.
  const facetSpec = spec.facets;
  const facetCount = facetSpec?.count ?? 0;
  const facets = new Float64Array(facetCount * 4);
  if (facetSpec && facetCount > 0) {
    const facetPhase = stream(spec.seed ^ 0x68e31da4)() * Math.PI * 2;
    for (let i = 0; i < facetCount; i++) {
      spiralDirection(i, facetCount, facetPhase, sampleDir);
      facets[i * 4] = sampleDir.x;
      facets[i * 4 + 1] = sampleDir.y;
      facets[i * 4 + 2] = sampleDir.z;
      facets[i * 4 + 3] = lobeRadius(lobes, sampleDir.x, sampleDir.y, sampleDir.z) * (1 - facetSpec.depth);
    }
  }

  const shape: ResolvedRockShape = {
    lobes,
    waves,
    noiseAmplitude: spec.noise.amplitude,
    craters,
    facets,
    maxRadius: 1,
    minRadius: 1,
    meanRadius: 1,
  };

  // --- measure the extremes on a fixed spiral covering.
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < EXTENT_SAMPLES; i++) {
    spiralDirection(i, EXTENT_SAMPLES, 0, sampleDir);
    const r = rockRadius(shape, sampleDir.x, sampleDir.y, sampleDir.z);
    if (r < min) min = r;
    if (r > max) max = r;
    sum += r;
  }
  return {
    ...shape,
    maxRadius: max * MAX_RADIUS_MARGIN,
    minRadius: Math.max(MIN_FIELD_RADIUS, min * MIN_RADIUS_MARGIN),
    meanRadius: sum / EXTENT_SAMPLES,
  };
}

/* ------------------------------------------------------------------ */
/* The field                                                           */
/* ------------------------------------------------------------------ */

/** Union of the lobe ellipsoids along `d`: the farthest exit distance. */
function lobeRadius(lobes: Float64Array, dx: number, dy: number, dz: number): number {
  let best = 0;
  for (let i = 0; i < lobes.length; i += 6) {
    const ox = lobes[i]!;
    const oy = lobes[i + 1]!;
    const oz = lobes[i + 2]!;
    const ix = lobes[i + 3]!;
    const iy = lobes[i + 4]!;
    const iz = lobes[i + 5]!;
    // ((t*d - o) / r)^2 = 1, solved for the positive root. `c < 0` holds because
    // the schema requires every lobe to contain the origin, so the root exists
    // and is unique in t > 0.
    const dxs = dx * ix;
    const dys = dy * iy;
    const dzs = dz * iz;
    const oxs = ox * ix;
    const oys = oy * iy;
    const ozs = oz * iz;
    const a = dxs * dxs + dys * dys + dzs * dzs;
    if (a <= 0) continue;
    const b = -2 * (dxs * oxs + dys * oys + dzs * ozs);
    const c = oxs * oxs + oys * oys + ozs * ozs - 1;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) continue;
    const t = (-b + Math.sqrt(disc)) / (2 * a);
    if (t > best) best = t;
  }
  return best;
}

/** Wave-sum surface noise in [-1, 1]. */
function surfaceNoise(waves: Float64Array, dx: number, dy: number, dz: number): number {
  let n = 0;
  for (let i = 0; i < waves.length; i += 6) {
    const projection = waves[i]! * dx + waves[i + 1]! * dy + waves[i + 2]! * dz;
    n += waves[i + 4]! * Math.sin(waves[i + 3]! * projection + waves[i + 5]!);
  }
  return n;
}

/**
 * Crater contribution as a fraction of the local lobe radius: a smooth bowl with
 * a rim bump just inside its edge. `u` runs 0 at the rim to 1 at the centre.
 */
function craterProfile(craters: Float64Array, dx: number, dy: number, dz: number): number {
  let delta = 0;
  for (let i = 0; i < craters.length; i += 6) {
    const alignment = craters[i]! * dx + craters[i + 1]! * dy + craters[i + 2]! * dz;
    const cosR = craters[i + 3]!;
    if (alignment <= cosR) continue;
    const u = (alignment - cosR) / (1 - cosR);
    const depth = craters[i + 4]!;
    const rim = craters[i + 5]!;
    // Bowl: smoothstep, 0 at the rim and `depth` at the centre.
    delta -= depth * u * u * (3 - 2 * u);
    // Rim: a bump peaking a third of the way in, which is what reads as an
    // impact crater rather than a dent.
    delta += depth * rim * 6.75 * u * (1 - u) * (1 - u);
  }
  return delta;
}

/**
 * Surface radius along a UNIT direction, in units of the nominal radius. The
 * single hot function: the collision narrowphase and the client's tessellator
 * both go through it, which is what guarantees they agree.
 */
export function rockRadius(shape: ResolvedRockShape, dx: number, dy: number, dz: number): number {
  const base = lobeRadius(shape.lobes, dx, dy, dz);
  let r = base * (1 + shape.noiseAmplitude * surfaceNoise(shape.waves, dx, dy, dz));
  if (shape.craters.length > 0) r += base * craterProfile(shape.craters, dx, dy, dz);
  const facets = shape.facets;
  for (let i = 0; i < facets.length; i += 4) {
    const nd = facets[i]! * dx + facets[i + 1]! * dy + facets[i + 2]! * dz;
    if (nd <= 1e-4) continue;
    const limit = facets[i + 3]! / nd;
    if (limit < r) r = limit;
  }
  return r < MIN_FIELD_RADIUS ? MIN_FIELD_RADIUS : r;
}

/* ------------------------------------------------------------------ */
/* Orientation helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Rotate a world vector into the rock's local frame — i.e. apply the CONJUGATE
 * of the body orientation. Written out rather than composed from a quaternion
 * library so the sim keeps no vector-math dependency and allocates nothing.
 */
export function rotateByConjugate(
  q: RockQuat,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): void {
  // v' = q* · v · q  (conjugate rotation), expanded via the standard
  // t = 2 * (-qv) x v ; v' = v + w*t + (-qv) x t  identity.
  const cx = -q.x;
  const cy = -q.y;
  const cz = -q.z;
  const tx = 2 * (cy * z - cz * y);
  const ty = 2 * (cz * x - cx * z);
  const tz = 2 * (cx * y - cy * x);
  out.x = x + q.w * tx + (cy * tz - cz * ty);
  out.y = y + q.w * ty + (cz * tx - cx * tz);
  out.z = z + q.w * tz + (cx * ty - cy * tx);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** Scratch local-space direction. Module-level: the narrowphase never allocates. */
const localDir = { x: 0, y: 0, z: 0 };
/** Scratch world point for the swept test. */
const sweepPoint = { x: 0, y: 0, z: 0 };

/**
 * Surface radius, in WORLD units, along the world direction `(dx, dy, dz)`
 * (need not be unit — it is normalized here) for a rock of nominal world radius
 * `scale` at orientation `q`.
 */
export function rockWorldRadius(
  shape: ResolvedRockShape,
  scale: number,
  q: RockQuat,
  dx: number,
  dy: number,
  dz: number,
): number {
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length <= 1e-9) return shape.minRadius * scale;
  const inv = 1 / length;
  rotateByConjugate(q, dx * inv, dy * inv, dz * inv, localDir);
  return rockRadius(shape, localDir.x, localDir.y, localDir.z) * scale;
}

/**
 * Sphere-vs-rock contact. Returns false with `out` untouched when clear.
 *
 * Two early-outs before any field work, in the order that matters:
 *  1. outside the bounding sphere ⇒ reject (the common case for every rock a
 *     ship is merely near);
 *  2. inside the inner sphere ⇒ accept without evaluating the field at all,
 *     because everything under `minRadius` is solid rock by construction.
 *
 * The contact normal is RADIAL rather than the true surface gradient. That is
 * the same normal the old sphere path used, it is exact wherever the surface is
 * locally spherical, and push-out along it is stable under the repeated
 * per-tick resolution the sim already relies on.
 */
export function rockSphereContact(
  shape: ResolvedRockShape,
  scale: number,
  q: RockQuat,
  centerX: number,
  centerY: number,
  centerZ: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  probeRadius: number,
  out: RockContact,
): boolean {
  let dx = pointX - centerX;
  let dy = pointY - centerY;
  let dz = pointZ - centerZ;
  let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance >= shape.maxRadius * scale + probeRadius) return false;
  if (distance <= 1e-9) {
    dx = 1;
    dy = 0;
    dz = 0;
    distance = 1e-9;
  }
  const inv = 1 / distance;
  const nx = dx * inv;
  const ny = dy * inv;
  const nz = dz * inv;
  let surface: number;
  if (distance + probeRadius <= shape.minRadius * scale) {
    surface = shape.minRadius * scale;
  } else {
    rotateByConjugate(q, nx, ny, nz, localDir);
    surface = rockRadius(shape, localDir.x, localDir.y, localDir.z) * scale;
  }
  const reach = surface + probeRadius;
  if (distance >= reach) return false;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.depth = reach - distance;
  return true;
}

/** Whether a world point lies inside the rock, inflated by `probeRadius`. */
function insideRock(
  shape: ResolvedRockShape,
  scale: number,
  q: RockQuat,
  centerX: number,
  centerY: number,
  centerZ: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  probeRadius: number,
): boolean {
  const dx = pointX - centerX;
  const dy = pointY - centerY;
  const dz = pointZ - centerZ;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance >= shape.maxRadius * scale + probeRadius) return false;
  if (distance + probeRadius <= shape.minRadius * scale) return true;
  if (distance <= 1e-9) return true;
  const inv = 1 / distance;
  rotateByConjugate(q, dx * inv, dy * inv, dz * inv, localDir);
  return distance < rockRadius(shape, localDir.x, localDir.y, localDir.z) * scale + probeRadius;
}

/** Bisection steps used to refine a swept entry point once it has been bracketed. */
const REFINE_STEPS = 10;
/** Hard cap on march samples, so a grazing chord through a colossal rock stays bounded. */
const MAX_MARCH_STEPS = 32;
/** March resolution as a fraction of the inner radius. */
const MARCH_FRACTION = 0.35;

/**
 * Swept sphere-vs-rock along the segment `from`→`to`. Returns the entry
 * parameter in `[0, 1]`, or `-1` for a miss.
 *
 * Cost is bounded and data-independent: at most {@link MAX_MARCH_STEPS} +
 * {@link REFINE_STEPS} field evaluations, and ZERO when the segment misses the
 * bounding sphere — which is what every shot that is not actually near a rock
 * pays. The march resolution is a fixed fraction of the rock's inner radius, so
 * the sampling can only skip past a feature thinner than a third of the solid
 * core, which the shape schema's limits do not permit.
 */
export function rockSegmentEntry(
  shape: ResolvedRockShape,
  scale: number,
  q: RockQuat,
  centerX: number,
  centerY: number,
  centerZ: number,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  probeRadius: number,
): number {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const ez = to.z - from.z;
  const segLenSq = ex * ex + ey * ey + ez * ez;
  const bound = shape.maxRadius * scale + probeRadius;

  // Clip the segment to the bounding sphere first: everything below only ever
  // runs on the part of the shot that could possibly be touching the rock.
  const fx = from.x - centerX;
  const fy = from.y - centerY;
  const fz = from.z - centerZ;
  if (segLenSq <= 1e-12) {
    return fx * fx + fy * fy + fz * fz < bound * bound &&
      insideRock(shape, scale, q, centerX, centerY, centerZ, from.x, from.y, from.z, probeRadius)
      ? 0
      : -1;
  }
  const b = fx * ex + fy * ey + fz * ez;
  const c = fx * fx + fy * fy + fz * fz - bound * bound;
  const disc = b * b - segLenSq * c;
  if (disc < 0) return -1;
  const sqrtDisc = Math.sqrt(disc);
  let t0 = (-b - sqrtDisc) / segLenSq;
  let t1 = (-b + sqrtDisc) / segLenSq;
  if (t1 < 0 || t0 > 1) return -1;
  if (t0 < 0) t0 = 0;
  if (t1 > 1) t1 = 1;

  const span = (t1 - t0) * Math.sqrt(segLenSq);
  const resolution = Math.max(shape.minRadius * scale * MARCH_FRACTION, 1e-3);
  const steps = Math.min(MAX_MARCH_STEPS, Math.max(2, Math.ceil(span / resolution)));
  const stepT = (t1 - t0) / steps;

  let previous = t0;
  for (let i = 0; i <= steps; i++) {
    const t = i === steps ? t1 : t0 + stepT * i;
    sweepPoint.x = from.x + ex * t;
    sweepPoint.y = from.y + ey * t;
    sweepPoint.z = from.z + ez * t;
    if (!insideRock(shape, scale, q, centerX, centerY, centerZ, sweepPoint.x, sweepPoint.y, sweepPoint.z, probeRadius)) {
      previous = t;
      continue;
    }
    if (i === 0) return t;
    // Bracketed: [previous outside, t inside]. Bisect for the entry point.
    let lo = previous;
    let hi = t;
    for (let k = 0; k < REFINE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      sweepPoint.x = from.x + ex * mid;
      sweepPoint.y = from.y + ey * mid;
      sweepPoint.z = from.z + ez * mid;
      if (insideRock(shape, scale, q, centerX, centerY, centerZ, sweepPoint.x, sweepPoint.y, sweepPoint.z, probeRadius)) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return -1;
}
