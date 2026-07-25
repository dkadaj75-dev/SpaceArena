/**
 * Production static serving (ROADMAP §11 6.3).
 *
 * In production the single container is the whole game: Colyseus WS, the REST
 * API, the built client, and the content pack all answer on one origin. That
 * removes CORS from the browser's path entirely and lets the service worker
 * (§11 6.5) treat `/content/*` as same-origin.
 *
 * Three caching rules, and they are the whole design:
 *
 *   - `/assets/*` — Vite writes content-hashed filenames here, so a URL's bytes
 *     can never change. `immutable, max-age=1y`: the browser must not even
 *     revalidate. A deploy changes the hash, which changes the URL.
 *   - `index.html`, `sw.js`, `manifest.webmanifest`, icons — unhashed names whose
 *     content DOES change on deploy. `no-cache` (= "cached, but revalidate every
 *     time"): a 304 is cheap, a stale shell pointing at deleted asset hashes is
 *     a white screen.
 *   - `/content/*` — content packs must go live without a redeploy (ROADMAP S6),
 *     so these are `no-cache` too. The service worker layers network-first on
 *     top for the same reason.
 *
 * Dev is unaffected: `client/dist` normally does not exist while developing, and
 * the Vite plugin keeps serving `/content/*` itself (client/vite.config.ts).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";

/** Hashed build output: never revalidate. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Unhashed shell + live content: keep, but revalidate on every use. */
export const NO_CACHE_CACHE_CONTROL = "no-cache";

/**
 * Path prefixes the SPA fallback must never swallow. `/matchmake` is intercepted
 * by Colyseus above Express (Server.attachMatchMakingRoutes) and so never
 * reaches here, but it is listed for the reader.
 */
const RESERVED_PREFIXES = /^\/(api|content|health|monitor|matchmake)(\/|$)/;

/** MIME types Node's `mime-types` table does not know but the client needs. */
const EXTRA_MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".webmanifest": "application/manifest+json",
};

function applyExtraMime(res: express.Response, filePath: string): void {
  const type = EXTRA_MIME[path.extname(filePath).toLowerCase()];
  if (type) res.setHeader("Content-Type", type);
}

/**
 * Serve the content pack at `/content/*`.
 *
 * Mirrors the dev Vite middleware's URL shape exactly, so the same client code
 * (`fetch("/content/manifest.json")`, `SceneLoader.ImportMeshAsync("/content/…")`)
 * works in both. `express.static` handles ETag/If-None-Match, range requests and
 * `..` traversal rejection.
 */
export function mountContent(app: Express, contentDir: string): void {
  app.use(
    "/content",
    express.static(contentDir, {
      index: false,
      dotfiles: "ignore",
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        res.setHeader("Cache-Control", NO_CACHE_CACHE_CONTROL);
        applyExtraMime(res, filePath);
      },
    }),
  );
}

/**
 * Serve the built client from `clientDir`, with the SPA fallback.
 *
 * `index: false` on the static handler is deliberate: `/` must fall through to
 * the fallback below so index.html is delivered with `no-cache` from exactly one
 * code path instead of two.
 */
export function mountClient(app: Express, clientDir: string): void {
  const indexHtml = path.join(clientDir, "index.html");

  app.use(
    express.static(clientDir, {
      index: false,
      dotfiles: "ignore",
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        res.setHeader("Cache-Control", cacheControlFor(clientDir, filePath));
        applyExtraMime(res, filePath);
      },
    }),
  );

  // SPA fallback. Registered as plain middleware rather than `app.get("*")`
  // because Express 5's path-to-regexp v8 no longer accepts a bare `*`.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (RESERVED_PREFIXES.test(req.path)) return next();
    // A request for a *file* that express.static did not find is a 404, not the
    // app shell. Handing HTML back for a missing `/sw.js` would make the browser
    // register a bogus service worker; same for a stale hashed chunk.
    if (path.extname(req.path) !== "") return next();
    res.setHeader("Cache-Control", NO_CACHE_CACHE_CONTROL);
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });
}

/** Immutable for Vite's content-hashed `assets/`, revalidate-always for the rest. */
export function cacheControlFor(clientDir: string, filePath: string): string {
  const rel = path.relative(clientDir, filePath).split(path.sep).join("/");
  return rel.startsWith("assets/") ? IMMUTABLE_CACHE_CONTROL : NO_CACHE_CACHE_CONTROL;
}

/** True when `dir` looks like a finished Vite build (used by env validation). */
export function isBuiltClientDir(dir: string): boolean {
  return existsSync(path.join(dir, "index.html"));
}
