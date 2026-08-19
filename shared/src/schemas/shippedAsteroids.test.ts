import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { asteroidSchema, type AsteroidConfig } from "./asteroid.js";
import { resolveRockMesh, type ResolvedRockMesh } from "../collision/rockCollider.js";

const CONTENT_ROOT = fileURLToPath(new URL("../../../content/", import.meta.url));

const asteroids: AsteroidConfig[] = readdirSync(`${CONTENT_ROOT}asteroids/`, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => asteroidSchema.parse(JSON.parse(readFileSync(`${CONTENT_ROOT}asteroids/${entry.name}`, "utf8"))))
  .sort((a, b) => (a.id < b.id ? -1 : 1));

/**
 * The shipped catalogue is six sculpted GLBs, each carrying the decimation of
 * its own visual mesh as baked triangle collision (2026-08-18). Every assertion
 * here is therefore measured off the SHIPPED TRIANGLES rather than off an
 * authored shape spec — which is a stronger check than the field-era version it
 * replaces: it fails if the bake drifts from the art, not merely if a number in
 * a JSON file changes.
 */
function meshOf(config: AsteroidConfig): ResolvedRockMesh {
  const mesh = resolveRockMesh(config);
  if (!mesh) throw new Error(`${config.id} has no collision mesh`);
  return mesh;
}

describe("shipped asteroid catalogue", () => {
  it("ships enough rock types to build a field out of", () => {
    expect(asteroids.length).toBeGreaterThanOrEqual(6);
  });

  it("gives every rock a real surface, so nothing is left colliding as a sphere", () => {
    for (const config of asteroids) {
      expect(
        config.shape !== undefined || config.collision !== undefined,
        `${config.id} must author a shape or a collision mesh`,
      ).toBe(true);
    }
  });

  it("points every model rock at a GLB that is actually in the pack", () => {
    for (const config of asteroids) {
      if (!config.collision) continue;
      const model = config.render.model;
      expect(model, `${config.id} must author a render.model`).toBeDefined();
      expect(existsSync(`${CONTENT_ROOT}${model}`), `${config.id} needs ${model}`).toBe(true);
    }
  });

  it("normalizes every collider to the radius the rock is drawn at", () => {
    // `AssetRegistry` bakes `modelScale` into the master and divides it back out
    // per instance, so the drawn body spans `radius * placement.scale` exactly
    // when the GLB is unit-radius and `modelScale` is the config's radius. The
    // collider is authored in the same unit-radius space, which is the whole
    // reason "what you hit" equals "what you see" at every placement size.
    for (const config of asteroids) {
      if (!config.collision) continue;
      expect(config.render.modelScale, `${config.id} modelScale`).toBe(config.radius);
      const { maxRadius } = meshOf(config);
      expect(maxRadius, `${config.id} collider extent`).toBeLessThanOrEqual(1.001);
      expect(maxRadius, `${config.id} collider extent`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("leaves a solid core rather than a shell the narrowphase can fall through", () => {
    // The inner sphere is the conservative "this is rock for certain" stand-in
    // every coarse consumer (bots, radar) reasons with. A body whose nearest
    // surface hugged the centre would make that stand-in useless.
    for (const config of asteroids) {
      if (!config.collision) continue;
      const { minRadius, maxRadius } = meshOf(config);
      expect(minRadius, `${config.id} solid core`).toBeGreaterThan(0.15 * maxRadius);
      expect(minRadius, `${config.id} solid core`).toBeLessThan(maxRadius);
    }
  });

  it("spans a real range of silhouettes rather than one potato at six sizes", () => {
    const meshes = asteroids.filter((c) => c.collision).map(meshOf);
    const aspects = meshes.map((m) => m.maxRadius / m.minRadius);
    // Round bodies AND genuinely lumpy, deeply-waisted ones both have to be
    // present, or the field reads as wallpaper however many rocks are in it.
    expect(Math.min(...aspects)).toBeLessThan(1.7);
    expect(Math.max(...aspects)).toBeGreaterThan(2.8);
    // No two configs may resolve to the same silhouette signature.
    const signatures = new Set(
      meshes.map((m) => `${m.minRadius.toFixed(4)}:${m.meanRadius.toFixed(4)}:${m.maxRadius.toFixed(4)}`),
    );
    expect(signatures.size).toBe(meshes.length);
  });

  it("keeps the collision budget proportional to what it buys", () => {
    // Colliders ship inside the JSON, so triangles are bytes in the content pack
    // as well as work in the narrowphase. The visual meshes are ~5200 triangles;
    // the colliders are decimations of them, and must stay decimations.
    for (const config of asteroids) {
      if (!config.collision) continue;
      const triangles = meshOf(config).bvh.mesh.indices.length / 3;
      expect(triangles, `${config.id} collider triangles`).toBeGreaterThanOrEqual(400);
      expect(triangles, `${config.id} collider triangles`).toBeLessThanOrEqual(2500);
    }
  });

  it("gives every rock an authored tumble", () => {
    const spins = asteroids.map((c) => c.render.spin);
    for (const [index, spin] of spins.entries()) {
      expect(spin, `${asteroids[index]!.id} must author a spin`).toBeDefined();
    }
    // Some rocks turn visibly, some barely move: a field where everything
    // tumbles at one rate reads as a single animated prop.
    expect(Math.max(...spins.map((s) => s!.maxDegPerSec))).toBeGreaterThanOrEqual(8);
    expect(Math.min(...spins.map((s) => s!.minDegPerSec))).toBeLessThanOrEqual(1.5);
  });

  it("backs every destructible rock with hp and a destroyed state", () => {
    for (const config of asteroids) {
      if (!config.destructible) {
        expect(config.hp, `${config.id} is indestructible and needs no hp`).toBeUndefined();
        continue;
      }
      expect(config.hp, `${config.id} must author hp`).toBeGreaterThan(0);
      const states = config.states?.map((state) => state.id) ?? [];
      expect(states, `${config.id} destroyed state`).toContain("destroyed");
    }
    // The feature has to keep a shipped user, or the destroyed-state render path
    // and the destruction events go untested outside fixtures.
    expect(asteroids.some((config) => config.destructible)).toBe(true);
  });
});
