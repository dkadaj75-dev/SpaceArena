import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PROTOCOL_VERSION, buildBundle, setGlobalLogLevel, type ContentBundle } from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { ContentPackStore, resetPackStore, setPackStore } from "../content/packStore.js";
import { openDatabase, setDb } from "../db/index.js";
import { usersRepo } from "../db/repos.js";
import { createHttpApp } from "../httpApp.js";
import { ADMIN_MUTATE_RATE_CAPACITY, ADMIN_RATE_CAPACITY } from "./adminContent.js";

setGlobalLogLevel("error");

/** Tiny self-consistent pack; `radius` is the observable difference between packs. */
function pack(radius: number, withProof = false): { manifest: unknown; files: Record<string, unknown> } {
  const files: Record<string, unknown> = {
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
    "arenas/base.json": arena("arena.base", radius),
  };
  const list = ["asteroids/rock.json", "arenas/base.json"];
  if (withProof) {
    files["arenas/proof.json"] = arena("arena.proof", 33);
    list.push("arenas/proof.json");
  }
  return { manifest: { id: "manifest.test", type: "manifest", version: 1, name: "Test", files: list }, files };
}

function arena(id: string, radius: number): unknown {
  return {
    id,
    type: "arena",
    version: 1,
    name: id,
    bounds: { shape: "circle", radius },
    asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 0, z: 0 } }],
    spawnPoints: [
      { id: "sp-a", team: 0, position: { x: -20, z: -20 }, heading: 0 },
      { id: "sp-b", team: 1, position: { x: 20, z: 20 }, heading: 3.14 },
    ],
  };
}

function bundleOf(radius: number, withProof = false): Promise<ContentBundle> {
  const { manifest, files } = pack(radius, withProof);
  return buildBundle(manifest, files);
}

let root: string;
let contentDir: string;
let store: ContentPackStore;
let app: ReturnType<typeof createHttpApp>;
let adminAuth: string;
let playerAuth: string;

/** Register a user and return its bearer header + id. */
async function newUser(email: string): Promise<{ auth: string; userId: string }> {
  const res = await request(app).post("/api/auth/register").send({ email, password: "password123", displayName: "T" });
  return { auth: `Bearer ${res.body.accessToken}`, userId: res.body.profile.userId };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sa-admin-"));
  contentDir = path.join(root, "content");
  const { manifest, files } = pack(50);
  await mkdir(path.join(contentDir, "arenas"), { recursive: true });
  await mkdir(path.join(contentDir, "asteroids"), { recursive: true });
  await writeFile(path.join(contentDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  for (const [rel, json] of Object.entries(files)) {
    await writeFile(path.join(contentDir, ...rel.split("/")), JSON.stringify(json), "utf8");
  }

  store = new ContentPackStore(contentDir);
  setPackStore(store);
  await store.reload();
  setDb(openDatabase(":memory:"));

  app = createHttpApp();
  const admin = await newUser("admin@pack.test");
  usersRepo.setRole(admin.userId, "admin");
  adminAuth = admin.auth;
  playerAuth = (await newUser("player@pack.test")).auth;
});

afterAll(async () => {
  resetPackStore();
  await rm(root, { recursive: true, force: true });
});

// A fresh app per test gives each one its own (deliberately tiny) admin rate
// bucket, so ordinary coverage never trips the limiter that production wants.
beforeEach(() => {
  app = createHttpApp();
});

describe("admin content API — gating", () => {
  const routes: [("get" | "post"), string][] = [
    ["get", "/api/admin/content/export"],
    ["get", "/api/admin/content/status"],
    ["post", "/api/admin/content/import"],
    ["post", "/api/admin/content/rollback"],
  ];

  it("401s every route without a token", async () => {
    for (const [method, route] of routes) {
      const res = await request(app)[method](route);
      expect(res.status, route).toBe(401);
      expect(res.body.error.code, route).toBe("unauthorized");
    }
  });

  it("401s on a malformed token", async () => {
    const res = await request(app).get("/api/admin/content/export").set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
  });

  it("403s every route for an authenticated non-admin", async () => {
    for (const [method, route] of routes) {
      const res = await request(app)[method](route).set("Authorization", playerAuth);
      expect(res.status, route).toBe(403);
      expect(res.body.error.code, route).toBe("forbidden");
    }
  });

  it("reflects a role change immediately — no token re-issue needed", async () => {
    const victim = await newUser("demote@pack.test");
    usersRepo.setRole(victim.userId, "admin");
    expect((await request(app).get("/api/admin/content/status").set("Authorization", victim.auth)).status).toBe(200);

    usersRepo.setRole(victim.userId, "player");
    // Same token, still valid, now refused: the role is read per request.
    expect((await request(app).get("/api/admin/content/status").set("Authorization", victim.auth)).status).toBe(403);
  });

  it("allows an admin", async () => {
    const res = await request(app).get("/api/admin/content/export").set("Authorization", adminAuth);
    expect(res.status).toBe(200);
  });
});

describe("admin content API — export", () => {
  it("returns the live pack as a downloadable bundle", async () => {
    const res = await request(app).get("/api/admin/content/export").set("Authorization", adminAuth);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("manifest.test-v1.pack.json");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.kind).toBe("space-arena.content-pack");
    expect(res.body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(Object.keys(res.body.files).sort()).toEqual(["arenas/base.json", "asteroids/rock.json"]);
    expect(res.body.sourceHash).toMatch(/^sha256:/);
  });

  it("reports the live pack on /status and /health", async () => {
    const status = await request(app).get("/api/admin/content/status").set("Authorization", adminAuth);
    expect(status.status).toBe(200);
    expect(status.body.pack.packId).toBe("manifest.test");

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.contentPack.sourceHash).toBe(status.body.pack.sourceHash);
  });
});

describe("admin content API — import", () => {
  it("rejects a bundle with a bad schema and changes nothing", async () => {
    const before = await store.exportBundle();
    const bad = await bundleOf(50);
    (bad.files["arenas/base.json"] as { bounds: { radius: number } }).bounds.radius = -3;

    const res = await request(app).post("/api/admin/content/import").set("Authorization", adminAuth).send(bad);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("pack-validation-failed");
    expect(res.body.stage).toBe("validation");
    // Per-file errors in the editor's `{ file, path, message }` shape.
    expect(res.body.errors[0]).toMatchObject({ file: "arenas/base.json" });
    expect(res.body.errors[0].path).toContain("bounds");
    expect(typeof res.body.errors[0].message).toBe("string");

    expect((await store.exportBundle()).sourceHash).toBe(before.sourceHash);
  });

  it("rejects a dangling reference", async () => {
    const bad = await bundleOf(50);
    (bad.files["arenas/base.json"] as { asteroidPlacements: unknown[] }).asteroidPlacements = [
      { asteroidId: "asteroid.ghost", position: { x: 0, z: 0 } },
    ];
    const res = await request(app).post("/api/admin/content/import").set("Authorization", adminAuth).send(bad);
    expect(res.status).toBe(422);
    expect(res.body.errors.some((e: { message: string }) => e.message.includes("dangling reference"))).toBe(true);
  });

  it("rejects a protocolVersion mismatch", async () => {
    const bundle = { ...(await bundleOf(50)), protocolVersion: PROTOCOL_VERSION + 1 };
    const res = await request(app).post("/api/admin/content/import").set("Authorization", adminAuth).send(bundle);
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].path).toBe("protocolVersion");
  });

  it("rejects a traversal path in the files map", async () => {
    const bundle = await bundleOf(50);
    const evil = { ...bundle, files: { ...bundle.files, "../../evil.json": { id: "x" } } };
    const res = await request(app).post("/api/admin/content/import").set("Authorization", adminAuth).send(evil);
    expect(res.status).toBe(422);
    expect(res.body.errors.some((e: { message: string }) => e.message.includes("unsafe file path"))).toBe(true);
  });

  it("rejects a body that is not a bundle at all", async () => {
    const res = await request(app).post("/api/admin/content/import").set("Authorization", adminAuth).send({ nope: 1 });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].file).toBe("<bundle>");
  });

  it("imports a good pack and serves it without a restart, then rolls back", async () => {
    expect(getConfigService().get("arena", "arena.proof")).toBeUndefined();

    const imported = await request(app)
      .post("/api/admin/content/import")
      .set("Authorization", adminAuth)
      .send(await bundleOf(120, true));
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ ok: true, packId: "manifest.test", files: 3, rollbackAvailable: true });
    expect(imported.body.counts).toEqual({ asteroid: 1, arena: 2 });

    // Live in the running server's registry — no restart, no redeploy.
    expect(getConfigService().get("arena", "arena.proof")).toMatchObject({ bounds: { radius: 33 } });
    // And a fresh export now contains it.
    const reexport = await request(app).get("/api/admin/content/export").set("Authorization", adminAuth);
    expect(Object.keys(reexport.body.files)).toContain("arenas/proof.json");

    const rolled = await request(app).post("/api/admin/content/rollback").set("Authorization", adminAuth);
    expect(rolled.status).toBe(200);
    expect(getConfigService().get("arena", "arena.proof")).toBeUndefined();
    expect(getConfigService().get("arena", "arena.base")).toMatchObject({ bounds: { radius: 50 } });
  });

  it("409s a rollback with nothing to roll back to", async () => {
    // A fresh store over the same directory has no `.previous` knowledge, and the
    // directory left behind by the previous test was rolled back already.
    await rm(store.previousDir, { recursive: true, force: true });
    const res = await request(app).post("/api/admin/content/rollback").set("Authorization", adminAuth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("rollback-failed");
  });
});

describe("admin content API — limits", () => {
  it("413s a body over the import cap", async () => {
    const previous = process.env.CONTENT_IMPORT_MAX_BYTES;
    process.env.CONTENT_IMPORT_MAX_BYTES = "512";
    try {
      const capped = createHttpApp();
      const res = await request(capped)
        .post("/api/admin/content/import")
        .set("Authorization", adminAuth)
        .send(await bundleOf(50, true));
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe("pack-too-large");
    } finally {
      if (previous === undefined) delete process.env.CONTENT_IMPORT_MAX_BYTES;
      else process.env.CONTENT_IMPORT_MAX_BYTES = previous;
    }
  });

  it("400s a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/admin/content/import")
      .set("Authorization", adminAuth)
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid-json");
  });

  it("rate-limits reads", async () => {
    let limited = false;
    for (let i = 0; i < ADMIN_RATE_CAPACITY + 2; i++) {
      const res = await request(app).get("/api/admin/content/status").set("Authorization", adminAuth);
      if (res.status === 429) {
        limited = true;
        expect(res.body.error.code).toBe("rate-limited");
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("rate-limits writes far harder than reads", async () => {
    // A junk body is enough: the limiter runs before the pack is even parsed, so
    // this measures the bucket, not the validator.
    let mutateLimitedAt = -1;
    for (let i = 0; i < ADMIN_MUTATE_RATE_CAPACITY + 2; i++) {
      const res = await request(app).post("/api/admin/content/import").set("Authorization", adminAuth).send({ nope: i });
      if (res.status === 429) {
        mutateLimitedAt = i;
        break;
      }
      expect(res.status).toBe(422);
    }
    expect(mutateLimitedAt).toBeGreaterThanOrEqual(0);
    // The write bucket must run dry strictly before the read bucket would.
    expect(mutateLimitedAt).toBeLessThan(ADMIN_RATE_CAPACITY);
  });

  it("counts unauthenticated attempts against the same bucket", async () => {
    // The limiter runs before the auth check, so a token-less flood cannot be
    // used to probe the endpoint for free.
    let limited = false;
    for (let i = 0; i < ADMIN_RATE_CAPACITY + 2; i++) {
      const res = await request(app).get("/api/admin/content/status");
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(limited).toBe(true);
  });
});
