import { describe, expect, it } from "vitest";

import { rockShapeSchema, type RockShapeConfig } from "../schemas/asteroid.js";
import {
  resolveRockShape,
  rockRadius,
  rockSegmentEntry,
  rockSphereContact,
  rockWorldRadius,
  rotateByConjugate,
  type RockContact,
  type RockQuat,
} from "./rockShape.js";
import { rockOrientationAt, rockSpinFor } from "./rockPose.js";

const IDENTITY: RockQuat = { x: 0, y: 0, z: 0, w: 1 };
const contact: RockContact = { nx: 0, ny: 0, nz: 0, depth: 0 };

function parse(spec: unknown): RockShapeConfig {
  return rockShapeSchema.parse(spec);
}

/**
 * A contact binary: two lobes side by side on x with a pinched waist between
 * them. The canonical shape a sphere gets wrong — its bounding sphere swallows
 * the whole waist, so anything sphere-based reports a hit in the gap.
 */
const PEANUT = parse({
  seed: 7,
  lobes: [
    { offset: [-0.45, 0, 0], radii: [0.55, 0.42, 0.42] },
    { offset: [0.45, 0, 0], radii: [0.55, 0.42, 0.42] },
  ],
  noise: { amplitude: 0, frequency: 2, octaves: 1 },
});

/** A plain sphere, for asserting the field degenerates to the obvious answer. */
const BALL = parse({
  seed: 1,
  lobes: [{ radii: [1, 1, 1] }],
  noise: { amplitude: 0, frequency: 2, octaves: 1 },
});

describe("rock shape field", () => {
  it("degenerates to a sphere when a single centred lobe carries no features", () => {
    const shape = resolveRockShape(BALL);
    const diagonal = 1 / Math.sqrt(3);
    for (const dir of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [diagonal, diagonal, diagonal]] as const) {
      expect(rockRadius(shape, dir[0], dir[1], dir[2])).toBeCloseTo(1, 9);
    }
    expect(shape.meanRadius).toBeCloseTo(1, 3);
  });

  it("bounds a body: max is a true upper bound and min a true lower bound", () => {
    const lumpy = parse({
      seed: 4242,
      lobes: [{ radii: [1, 0.7, 0.85] }],
      noise: { amplitude: 0.25, frequency: 4, octaves: 3 },
      craters: { count: 5, radiusDeg: 30, depth: 0.25 },
    });
    const shape = resolveRockShape(lumpy);
    // Sample far denser than the resolver did — the margins exist precisely so
    // an unlucky direction between its samples still cannot escape the bounds.
    for (let i = 0; i < 20000; i++) {
      const y = 1 - (2 * i + 1) / 20000;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.39996;
      const r = rockRadius(shape, Math.cos(theta) * ring, y, Math.sin(theta) * ring);
      expect(r).toBeLessThanOrEqual(shape.maxRadius);
      expect(r).toBeGreaterThanOrEqual(shape.minRadius);
    }
    expect(shape.minRadius).toBeLessThan(shape.meanRadius);
    expect(shape.meanRadius).toBeLessThan(shape.maxRadius);
  });

  it("is bit-identical across repeated evaluation and across resolutions of the same spec", () => {
    // Determinism is the whole contract: the client and the server run this code
    // independently and must agree on every surface point.
    const shape = resolveRockShape(PEANUT);
    const again = resolveRockShape(parse(JSON.parse(JSON.stringify(PEANUT)) as unknown));
    for (let i = 0; i < 500; i++) {
      const y = 1 - (2 * i + 1) / 500;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 1.7;
      const dx = Math.cos(theta) * ring;
      const dz = Math.sin(theta) * ring;
      const a = rockRadius(shape, dx, y, dz);
      expect(rockRadius(shape, dx, y, dz)).toBe(a);
      expect(rockRadius(again, dx, y, dz)).toBe(a);
    }
  });

  it("carves a waist between the lobes of a contact binary", () => {
    const shape = resolveRockShape(PEANUT);
    const alongLobes = rockRadius(shape, 1, 0, 0);
    const acrossWaist = rockRadius(shape, 0, 1, 0);
    // Along x the far lobe's exit is its offset plus its own semi-axis.
    expect(alongLobes).toBeCloseTo(0.45 + 0.55, 6);
    // The waist is the pinch: the surface there is the lobes' vertical half-axis
    // reduced by how far off-centre they sit.
    expect(acrossWaist).toBeLessThan(0.45);
    expect(acrossWaist).toBeGreaterThan(0.1);
  });

  it("cuts flat facets that shorten the surface in their own direction", () => {
    const faceted = parse({
      seed: 11,
      lobes: [{ radii: [1, 1, 1] }],
      noise: { amplitude: 0, frequency: 2, octaves: 1 },
      facets: { count: 6, depth: 0.3 },
    });
    const shape = resolveRockShape(faceted);
    expect(shape.maxRadius).toBeLessThan(1.05);
    expect(shape.minRadius).toBeLessThan(0.75);
  });

  it("digs craters whose floor is below the surrounding surface", () => {
    const cratered = parse({
      seed: 3,
      lobes: [{ radii: [1, 1, 1] }],
      noise: { amplitude: 0, frequency: 2, octaves: 1 },
      craters: { count: 1, radiusDeg: 40, depth: 0.3, rim: 0.5 },
    });
    const shape = resolveRockShape(cratered);
    // The single crater sits on the spiral's only direction, which for count 1
    // is the equator; scan for the deepest point and check it is a real dish.
    let deepest = Infinity;
    for (let i = 0; i < 2000; i++) {
      const y = 1 - (2 * i + 1) / 2000;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.39996;
      deepest = Math.min(deepest, rockRadius(shape, Math.cos(theta) * ring, y, Math.sin(theta) * ring));
    }
    expect(deepest).toBeLessThan(0.75);
  });

  it("rejects a lobe that does not contain the body origin", () => {
    // Star-shapedness is the invariant the whole representation rests on.
    expect(() =>
      parse({
        seed: 1,
        lobes: [{ offset: [1.5, 0, 0], radii: [0.5, 0.5, 0.5] }],
        noise: { amplitude: 0, frequency: 2, octaves: 1 },
      }),
    ).toThrow(/lobe offset/);
  });
});

describe("rockSphereContact", () => {
  const shape = resolveRockShape(PEANUT);
  const SCALE = 10; // world radius, so the peanut is ~19 units long and ~8 thick

  it("hits a point inside a lobe", () => {
    expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 8, 0, 0, 0, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(1);
    expect(contact.depth).toBeGreaterThan(0);
  });

  it("MISSES the concavity beside the lobes — the empty space a sphere would claim", () => {
    // The waist surface is only ~2.4 units up, while the bounding sphere reaches
    // ~10.4. Six units above the centre is therefore deep inside the sphere and
    // well outside the rock — the exact case the old collider got wrong.
    expect(6).toBeLessThan(shape.maxRadius * SCALE);
    expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 0, 6, 0, 0, contact)).toBe(false);
    // ...and it does hit once it descends onto the actual waist.
    expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 0, 2, 0, 0, contact)).toBe(true);
  });

  it("rejects everything outside the bounding sphere without touching the field", () => {
    for (const distance of [11, 12, 50, 500]) {
      expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 0, distance, 0, 0, contact)).toBe(false);
      expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, distance, 0, 0, 0, contact)).toBe(false);
    }
    // The early-out IS the bounding sphere: nothing beyond it can hit, whatever
    // direction it approaches from.
    expect(shape.maxRadius * SCALE).toBeLessThan(11);
  });

  it("grows the contact by the probe radius", () => {
    expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 0, 3.5, 0, 0, contact)).toBe(false);
    expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 0, 3.5, 0, 1.5, contact)).toBe(true);
  });

  it("follows the body's orientation", () => {
    // Turned a quarter turn about y, the peanut's long axis lies on z: a point
    // that was inside a lobe is now in clear space, and vice versa.
    const turned: RockQuat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    expect(rockSphereContact(shape, SCALE, IDENTITY, 0, 0, 0, 8, 0, 0, 0, contact)).toBe(true);
    expect(rockSphereContact(shape, SCALE, turned, 0, 0, 0, 8, 0, 0, 0, contact)).toBe(false);
    expect(rockSphereContact(shape, SCALE, turned, 0, 0, 0, 0, 0, 8, 0, contact)).toBe(true);
  });
});

describe("rockSegmentEntry", () => {
  const shape = resolveRockShape(PEANUT);
  const SCALE = 10;

  it("finds the entry point of a shot into a lobe", () => {
    const t = rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, { x: 30, y: 0, z: 0 }, { x: -30, y: 0, z: 0 }, 0);
    expect(t).toBeGreaterThan(0);
    const entryX = 30 - 60 * t;
    // Entry lands on the surface, not on the bounding sphere.
    expect(entryX).toBeCloseTo(rockRadius(shape, 1, 0, 0) * SCALE, 1);
  });

  it("lets a shot through the waist gap that a bounding sphere would stop", () => {
    // A pass 6 units above the centre clips the bounding sphere and misses the
    // rock. Sphere collision reports a hit here; the shaped surface does not.
    const grazes = rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, { x: -30, y: 6, z: 0 }, { x: 30, y: 6, z: 0 }, 0);
    expect(grazes).toBe(-1);
    // Aimed at a lobe instead, it connects.
    const hits = rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, { x: -30, y: 6, z: 0 }, { x: 30, y: -6, z: 0 }, 0);
    expect(hits).toBeGreaterThan(0);
  });

  it("early-outs on a segment that never reaches the bounding sphere", () => {
    expect(rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, { x: -30, y: 40, z: 0 }, { x: 30, y: 40, z: 0 }, 0)).toBe(-1);
    expect(rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, { x: 200, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 0)).toBe(-1);
  });

  it("reports 0 for a segment that starts inside", () => {
    expect(rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, { x: 4, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, 0)).toBe(0);
  });

  it("is deterministic tick to tick for an unchanged pose", () => {
    const from = { x: -30, y: 2.5, z: 1 };
    const to = { x: 30, y: -2.5, z: -1 };
    const first = rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, from, to, 0.4);
    for (let tick = 0; tick < 50; tick++) {
      expect(rockSegmentEntry(shape, SCALE, IDENTITY, 0, 0, 0, from, to, 0.4)).toBe(first);
    }
  });

  it("tracks the tumbling body across ticks", () => {
    // The pose is a closed form of match time, so a rock that has turned its
    // waist toward the shot stops blocking it — and does so identically on
    // every evaluation of that same time.
    // An explicit half-turn-per-second about z, so the lobes swing through the
    // shot line and the test is about the pose, not about which axis a seed drew.
    const spin = { axisX: 0, axisY: 0, axisZ: 1, radiansPerSec: Math.PI };
    expect(Math.abs(rockSpinFor(3, { minDegPerSec: 90, maxDegPerSec: 90 }).radiansPerSec)).toBeCloseTo(Math.PI / 2, 6);
    const pose: RockQuat = { x: 0, y: 0, z: 0, w: 1 };
    const seen: number[] = [];
    for (let tick = 0; tick < 40; tick++) {
      rockOrientationAt(spin, 0, tick / 30, pose);
      seen.push(rockSegmentEntry(shape, SCALE, pose, 0, 0, 0, { x: -30, y: 5, z: 0 }, { x: 30, y: 5, z: 0 }, 0));
    }
    expect(seen.some((t) => t < 0)).toBe(true);
    expect(seen.some((t) => t >= 0)).toBe(true);
    const replay: number[] = [];
    for (let tick = 0; tick < 40; tick++) {
      rockOrientationAt(spin, 0, tick / 30, pose);
      replay.push(rockSegmentEntry(shape, SCALE, pose, 0, 0, 0, { x: -30, y: 5, z: 0 }, { x: 30, y: 5, z: 0 }, 0));
    }
    expect(replay).toEqual(seen);
  });
});

describe("rotateByConjugate", () => {
  it("undoes the body rotation", () => {
    const out = { x: 0, y: 0, z: 0 };
    const quarterTurnY: RockQuat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    // Forward, that quaternion carries +x to -z; the conjugate must carry it back.
    rotateByConjugate(quarterTurnY, 1, 0, 0, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(1);
    rotateByConjugate(quarterTurnY, 0, 0, -1, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.z).toBeCloseTo(0);
  });
});

describe("rockWorldRadius", () => {
  it("normalizes its direction and scales into world units", () => {
    const shape = resolveRockShape(BALL);
    expect(rockWorldRadius(shape, 7, IDENTITY, 12, 0, 0)).toBeCloseTo(7, 5);
    expect(rockWorldRadius(shape, 7, IDENTITY, 0, 0, 0.001)).toBeCloseTo(7, 5);
  });
});
