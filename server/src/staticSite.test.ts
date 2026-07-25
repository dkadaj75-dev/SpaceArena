import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { setGlobalLogLevel } from "@space-arena/shared";
import { setConfigService, loadContent } from "./configService.js";
import { openDatabase, setDb } from "./db/index.js";
import { createHttpApp } from "./httpApp.js";
import { IMMUTABLE_CACHE_CONTROL, NO_CACHE_CACHE_CONTROL, cacheControlFor } from "./staticSite.js";

setGlobalLogLevel("error");

/**
 * Production static serving (ROADMAP §11 6.3).
 *
 * Built against a throwaway `dist` that mimics the real Vite output shape
 * (hashed `assets/`, unhashed shell + service worker at the root), so the tests
 * assert the caching *policy* rather than today's hashes.
 */

let root: string;
let clientDir: string;
let contentDir: string;
let app: ReturnType<typeof createHttpApp>;

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "space-arena-static-"));
  clientDir = path.join(root, "dist");
  mkdirSync(path.join(clientDir, "assets"), { recursive: true });
  writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>Space Arena</title>");
  writeFileSync(path.join(clientDir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(path.join(clientDir, "sw.js"), "self.addEventListener('fetch',()=>{})");
  writeFileSync(path.join(clientDir, "manifest.webmanifest"), '{"name":"Space Arena"}');
  writeFileSync(path.join(clientDir, "offline.html"), "<!doctype html>offline");

  contentDir = path.join(root, "content");
  mkdirSync(path.join(contentDir, "arenas"), { recursive: true });
  writeFileSync(path.join(contentDir, "manifest.json"), '{"id":"manifest.default"}');
  writeFileSync(path.join(contentDir, "arenas", "ring.json"), '{"id":"arena.ring"}');

  setConfigService(await loadContent());
  setDb(openDatabase(":memory:"));
  app = createHttpApp({ corsOrigins: [], contentDir, clientDir });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cacheControlFor", () => {
  it("marks hashed assets immutable and everything else revalidate-always", () => {
    expect(cacheControlFor("/dist", path.join("/dist", "assets", "index-abc.js"))).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor("/dist", path.join("/dist", "index.html"))).toBe(NO_CACHE_CACHE_CONTROL);
    expect(cacheControlFor("/dist", path.join("/dist", "sw.js"))).toBe(NO_CACHE_CACHE_CONTROL);
    expect(cacheControlFor("/dist", path.join("/dist", "icons", "icon-192.png"))).toBe(NO_CACHE_CACHE_CONTROL);
  });
});

describe("client static serving", () => {
  it("serves the shell at / with no-cache", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe(NO_CACHE_CACHE_CONTROL);
  });

  it("serves hashed assets as immutable", async () => {
    const res = await request(app).get("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it("serves the service worker and manifest with no-cache", async () => {
    const sw = await request(app).get("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers["cache-control"]).toBe(NO_CACHE_CACHE_CONTROL);

    const manifest = await request(app).get("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers["content-type"]).toMatch(/application\/manifest\+json/);
    expect(manifest.headers["cache-control"]).toBe(NO_CACHE_CACHE_CONTROL);
  });

  it("falls back to the shell for extension-less routes", async () => {
    const res = await request(app).get("/hangar");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Space Arena");
    expect(res.headers["cache-control"]).toBe(NO_CACHE_CACHE_CONTROL);
  });

  it("404s a missing FILE rather than handing back HTML", async () => {
    // Critical for the PWA: a 200-with-HTML for a missing /sw.js would register
    // a bogus service worker, and for a missing hashed chunk would white-screen.
    for (const url of ["/assets/gone-deadbeef.js", "/nope.js", "/icons/missing.png"]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      // Express's own 404 body, not the app shell.
      expect(res.text, url).not.toContain("Space Arena");
    }
  });

  it("never swallows API routes", async () => {
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    // Unauthenticated but reaching the real router, not the SPA fallback.
    const api = await request(app).get("/api/fittings");
    expect(api.status).toBe(401);
  });

  it("does not fall back for non-GET verbs", async () => {
    const res = await request(app).post("/hangar").send({});
    expect(res.status).toBe(404);
  });
});

describe("content serving", () => {
  it("serves the pack at /content/* with no-cache so packs go live without a redeploy", async () => {
    const res = await request(app).get("/content/manifest.json");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(NO_CACHE_CACHE_CONTROL);
    expect(res.body.id).toBe("manifest.default");
  });

  it("serves nested files and 404s unknown ones", async () => {
    expect((await request(app).get("/content/arenas/ring.json")).status).toBe(200);
    expect((await request(app).get("/content/arenas/nope.json")).status).toBe(404);
  });

  it("refuses to escape the content directory", async () => {
    const res = await request(app).get("/content/..%2f..%2fpackage.json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain("space-arena");
  });
});
