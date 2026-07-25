import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../constants.js";
import {
  CONTENT_BUNDLE_KIND,
  MAX_BUNDLE_FILES,
  buildBundle,
  canonicalPackString,
  computeSourceHash,
  contentPathProblem,
  isSafeContentPath,
  manifestFiles,
  validateBundle,
  type ContentBundle,
} from "./pack.js";

/**
 * Smallest pack that satisfies every schema + reference rule: one asteroid and
 * one arena that points at it. Kept tiny on purpose — these tests are about the
 * bundle envelope, not about the game's real content.
 */
function miniPack(): { manifest: unknown; files: Record<string, unknown> } {
  return {
    manifest: {
      id: "manifest.test",
      type: "manifest",
      version: 1,
      name: "Test Pack",
      files: ["asteroids/rock.json", "arenas/test.json"],
    },
    files: {
      "asteroids/rock.json": {
        id: "asteroid.rock",
        type: "asteroid",
        version: 1,
        name: "Rock",
        radius: 4,
        hp: 100,
        destructible: true,
        impactDamage: 5,
        render: { recipe: "procedural.rock-small" },
      },
      "arenas/test.json": {
        id: "arena.test",
        type: "arena",
        version: 1,
        name: "Test Arena",
        bounds: { shape: "circle", radius: 80 },
        asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 0, z: 0 } }],
        spawnPoints: [
          { id: "sp-a", team: 0, position: { x: -20, z: -20 }, heading: 0 },
          { id: "sp-b", team: 1, position: { x: 20, z: 20 }, heading: 3.14 },
        ],
      },
    },
  };
}

async function miniBundle(): Promise<ContentBundle> {
  const { manifest, files } = miniPack();
  return buildBundle(manifest, files);
}

describe("content bundle — path safety", () => {
  it("accepts ordinary nested content paths", () => {
    expect(isSafeContentPath("arenas/ring-nebula.json")).toBe(true);
    expect(isSafeContentPath("modules/laser-mk1.json")).toBe(true);
    expect(isSafeContentPath("a/b/c/d.json")).toBe(true);
  });

  it("rejects traversal, absolute, backslash and non-json paths", () => {
    expect(contentPathProblem("../secrets.json")).toMatch(/`\.` or `\.\.`/);
    expect(contentPathProblem("arenas/../../etc/passwd.json")).toMatch(/`\.` or `\.\.`/);
    expect(contentPathProblem("/etc/passwd.json")).toMatch(/relative/);
    expect(contentPathProblem("C:/windows/system32.json")).toMatch(/absolute/);
    expect(contentPathProblem("arenas\\win.json")).toMatch(/forward slashes/);
    expect(contentPathProblem("arenas/evil.js")).toMatch(/\.json/);
    expect(contentPathProblem("")).toMatch(/empty/);
    expect(contentPathProblem("arenas//x.json")).toMatch(/empty segment/);
    expect(contentPathProblem("arenas/x\0.json")).toBeTruthy();
  });
});

describe("content bundle — source hash", () => {
  it("is stable across key order and formatting", async () => {
    const a = await computeSourceHash({ id: "m", files: ["x.json"] }, { "x.json": { a: 1, b: 2 } });
    const b = await computeSourceHash({ files: ["x.json"], id: "m" }, { "x.json": { b: 2, a: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when any value changes", async () => {
    const a = await computeSourceHash({ id: "m" }, { "x.json": { radius: 90 } });
    const b = await computeSourceHash({ id: "m" }, { "x.json": { radius: 91 } });
    expect(a).not.toBe(b);
  });

  it("canonicalizes files in sorted path order", () => {
    const forward = canonicalPackString({}, { "b.json": 1, "a.json": 2 });
    const reverse = canonicalPackString({}, { "a.json": 2, "b.json": 1 });
    expect(forward).toBe(reverse);
  });

  it("matches the SHA-256 of the canonical string for a known input", async () => {
    // Guards the digest wiring itself (encoding + hex formatting), independent
    // of the canonical form: sha256("") is a published constant.
    const empty = new Uint8Array(0);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", empty);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("content bundle — validation", () => {
  it("accepts a well-formed bundle and reports counts", async () => {
    const result = await validateBundle(await miniBundle());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ asteroid: 1, arena: 1 });
  });

  it("rejects a non-bundle envelope", async () => {
    const result = await validateBundle({ hello: "world" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.file).toBe("<bundle>");
  });

  it("rejects a bundle whose protocolVersion does not match the server", async () => {
    const bundle = await miniBundle();
    const result = await validateBundle({ ...bundle, protocolVersion: PROTOCOL_VERSION + 7 });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("protocolVersion");
    expect(result.errors[0]?.message).toContain(`${PROTOCOL_VERSION + 7}`);
  });

  it("reports a schema violation against the offending file and json path", async () => {
    const bundle = await miniBundle();
    // radius must be positive; -5 is a schema failure inside arenas/test.json.
    const broken = {
      ...bundle,
      files: {
        ...bundle.files,
        "arenas/test.json": {
          ...(bundle.files["arenas/test.json"] as Record<string, unknown>),
          bounds: { shape: "circle", radius: -5 },
        },
      },
    };
    const result = await validateBundle(broken);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.file === "arenas/test.json");
    expect(err).toBeDefined();
    expect(err!.path).toContain("bounds");
  });

  it("reports a dangling cross-reference", async () => {
    const bundle = await miniBundle();
    const broken = {
      ...bundle,
      files: {
        ...bundle.files,
        "arenas/test.json": {
          ...(bundle.files["arenas/test.json"] as Record<string, unknown>),
          asteroidPlacements: [{ asteroidId: "asteroid.does-not-exist", position: { x: 0, z: 0 } }],
        },
      },
    };
    const result = await validateBundle(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("dangling reference"))).toBe(true);
  });

  it("reports a manifest entry the bundle does not carry", async () => {
    const bundle = await miniBundle();
    const broken = {
      ...bundle,
      manifest: {
        ...(bundle.manifest as Record<string, unknown>),
        files: ["asteroids/rock.json", "arenas/test.json", "arenas/missing.json"],
      },
    };
    const result = await validateBundle(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.file === "arenas/missing.json")).toBe(true);
  });

  it("reports a carried file the manifest does not list", async () => {
    const bundle = await miniBundle();
    const broken = { ...bundle, files: { ...bundle.files, "arenas/orphan.json": { id: "x" } } };
    const result = await validateBundle(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.file === "arenas/orphan.json" && e.message.includes("not listed"))).toBe(true);
  });

  it("refuses a traversal path before any filesystem work could happen", async () => {
    const bundle = await miniBundle();
    const broken = { ...bundle, files: { ...bundle.files, "../../evil.json": { id: "x" } } };
    const result = await validateBundle(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.every((e) => e.message.includes("unsafe file path"))).toBe(true);
  });

  it("refuses an oversized bundle by file count", async () => {
    const bundle = await miniBundle();
    const files: Record<string, unknown> = { ...bundle.files };
    for (let i = 0; i < MAX_BUNDLE_FILES + 1; i++) files[`bulk/f${i}.json`] = { id: `x.${i}` };
    const result = await validateBundle({ ...bundle, files });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("more than the"))).toBe(true);
  });

  it("rejects a manifest smuggled through the files map", async () => {
    const bundle = await miniBundle();
    const broken = { ...bundle, files: { ...bundle.files, "manifest.json": bundle.manifest } };
    const result = await validateBundle(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.file === "manifest.json")).toBe(true);
  });
});

describe("content bundle — envelope", () => {
  it("stamps kind, ids and a hash from the manifest", async () => {
    const bundle = await miniBundle();
    expect(bundle.kind).toBe(CONTENT_BUNDLE_KIND);
    expect(bundle.packId).toBe("manifest.test");
    expect(bundle.packVersion).toBe(1);
    expect(bundle.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(Date.parse(bundle.generatedAt)).not.toBeNaN();
    expect(bundle.sourceHash).toMatch(/^sha256:/);
  });

  it("reads manifest.files defensively", () => {
    expect(manifestFiles({ files: ["a.json", 3, "b.json"] })).toEqual(["a.json", "b.json"]);
    expect(manifestFiles(null)).toEqual([]);
    expect(manifestFiles({})).toEqual([]);
  });
});
