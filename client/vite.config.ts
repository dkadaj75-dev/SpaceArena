import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { persistEditorConfig } from "../shared/src/content/editorPersistence.js";
import { MAX_UPLOAD_BYTES, uploadEditorModel } from "./src/editor/editorUploadModel.js";

// Repo-root content/ directory (client/ is one level down).
const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

/**
 * Phase 0 task 0.5 — content pipeline plugin.
 *
 * How content reaches the client in dev: this plugin adds a middleware that
 * serves the repo `content/` tree at the `/content/*` URL prefix, so the client
 * can `fetch("/content/manifest.json")` with no publicDir copying. (Production
 * static serving is wired in a later phase alongside the server build.)
 *
 * Hot-reload: it watches `content/**\/*.json`; on change it reads the file and
 * pushes a custom HMR event `content:changed` (or `content:error` on bad JSON)
 * over the Vite websocket. The client module in src/core/contentHotReload.ts
 * subscribes and calls ConfigService.replace().
 */
function contentPipelinePlugin(): Plugin {
  return {
    name: "space-arena:content-pipeline",
    configureServer(server) {
      // Dev-only editor persistence. It accepts only a content-relative JSON path.
      server.middlewares.use("/__editor/save", (req, res, next) => {
        if (req.method !== "POST") return next();
        let body = "";
        req.on("data", (part: Buffer) => {
          body += part.toString();
        });
        req.on("end", () => {
          void (async () => {
            try {
              const payload: unknown = JSON.parse(body);
              if (!isSaveRequest(payload)) throw new Error("expected { path, json }");
              const result = await persistEditorConfig(CONTENT_DIR, payload);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, ...result }));
            } catch (error) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(error) }));
            }
          })();
        });
      });
      server.middlewares.use("/__editor/upload-model", (req, res, next) => {
        if (req.method !== "POST") return next();
        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD_BYTES) rejected = true;
          else chunks.push(chunk);
        });
        req.on("end", () => {
          void (async () => {
            const requestedPath = new URL(req.url ?? "", "http://editor.local").searchParams.get("path") ?? "";
            const result = rejected
              ? { status: 413, body: { ok: false, reason: "model exceeds the 32 MB upload limit" } }
              : await uploadEditorModel(CONTENT_DIR, requestedPath, Buffer.concat(chunks));
            res.statusCode = result.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result.body));
          })().catch((error) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, reason: String(error) }));
          });
        });
      });
      // Dev-only: list binary model assets under content/ for the Ship tool's picker.
      server.middlewares.use("/__editor/list-models", (req, res) => {
        void (async () => {
          const found: string[] = [];
          const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const abs = path.join(dir, entry.name);
              if (entry.isDirectory()) await walk(abs);
              else if (/\.gl(b|tf)$/i.test(entry.name)) found.push(path.relative(CONTENT_DIR, abs).split(path.sep).join("/"));
            }
          };
          try {
            await walk(CONTENT_DIR);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ models: found.sort() }));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ models: [], error: String(error) }));
          }
        })();
      });

      // --- Serve /content/* from the repo content dir ---
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (!url || !url.startsWith("/content/")) return next();
        const rel = decodeURIComponent(url.slice("/content/".length).split("?")[0]);
        const abs = path.join(CONTENT_DIR, rel);
        // Path-traversal guard.
        if (!abs.startsWith(CONTENT_DIR)) {
          res.statusCode = 403;
          return res.end("forbidden");
        }
        // Binary assets (GLB buffers, skybox panoramas, textures) must not go
        // through utf8 — a .webp served as utf8 "JSON" still 200s but never
        // decodes, so the sky silently falls back to the dim solid tint.
        const binaryMime: Record<string, string> = {
          ".glb": "model/gltf-binary",
          ".bin": "application/octet-stream",
          ".webp": "image/webp",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".ktx2": "image/ktx2",
          ".mp3": "audio/mpeg",
          ".ogg": "audio/ogg",
          ".wav": "audio/wav",
        };
        const ext = (/\.[a-z0-9]+$/i.exec(rel)?.[0] ?? "").toLowerCase();
        const mime = binaryMime[ext];
        if (mime) {
          readFile(abs).then(
            (buf) => {
              res.setHeader("Content-Type", mime);
              res.setHeader("Cache-Control", "no-store");
              res.end(buf);
            },
            () => {
              res.statusCode = 404;
              res.end("not found");
            },
          );
          return;
        }
        readFile(abs, "utf8").then(
          (text) => {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(text);
          },
          () => {
            res.statusCode = 404;
            res.end("not found");
          },
        );
      });

      // --- Watch content for hot-reload ---
      // Note: chokidar v4 (Vite 7) dropped glob support — watch the directory
      // itself and filter for .json inside push().
      server.watcher.add(CONTENT_DIR);

      const push = async (file: string): Promise<void> => {
        if (!file.endsWith(".json") || !path.resolve(file).startsWith(CONTENT_DIR)) return;
        const rel = path.relative(CONTENT_DIR, file).split(path.sep).join("/");
        try {
          const json = JSON.parse(await readFile(file, "utf8"));
          server.ws.send({ type: "custom", event: "content:changed", data: { file: rel, json } });
        } catch (err) {
          server.ws.send({
            type: "custom",
            event: "content:error",
            data: { file: rel, message: String(err) },
          });
        }
      };

      server.watcher.on("change", (f) => void push(f));
      server.watcher.on("add", (f) => void push(f));
    },
  };
}

function isSaveRequest(value: unknown): value is { path: string; json: unknown } {
  return typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string" && "json" in value;
}

/**
 * Chunk layout (ROADMAP §11 6.3).
 *
 * Split along *rate-of-change* boundaries so a deploy invalidates as little of
 * the browser cache as possible — every chunk here is content-hashed and served
 * `immutable` by the production server (server/src/staticSite.ts):
 *
 *   babylon-core    — @babylonjs/core. Enormous, and changes only on an engine
 *                     upgrade. One chunk, never subdivided: Babylon's internal
 *                     module graph has cycles, and splitting it invites
 *                     temporal-dead-zone crashes at load.
 *   babylon-loaders — @babylonjs/loaders (the glTF importer). Depends on core,
 *                     nothing depends on it, and it is `import()`ed lazily by
 *                     AssetRegistry — so it stays OUT of the initial payload.
 *   vendor          — colyseus.js, @colyseus/schema, zod. Small, stable.
 *   index (entry)   — game code + @space-arena/shared.
 *
 * The dev editor is deliberately NOT listed here. Rollup already splits it on
 * the `import("./editor/EditorShell.js")` in main.ts, emitting a lazy
 * `EditorShell-*.js`; naming it in manualChunks instead makes Vite treat it as a
 * chunk of the entry and emit a `<link rel=modulepreload>` for it — the exact
 * opposite of what we want. (In a production build the whole
 * `import.meta.env.DEV` branch is tree-shaken and no editor chunk exists at all;
 * tools/bundle-budget.ts asserts that, and fails on editor code in any initial
 * chunk.)
 *
 * The graph is a DAG (entry → vendor/babylon-*, babylon-loaders → babylon-core),
 * so there is no cross-chunk initialization cycle.
 */
function manualChunks(id: string): string | undefined {
  // Workspace source — including the symlinked @space-arena/shared package —
  // resolves to a real path outside node_modules, and stays in the entry chunk.
  const file = id.split("\\").join("/");
  if (!file.includes("/node_modules/")) return undefined;

  if (file.includes("/@babylonjs/loaders/")) return "babylon-loaders";
  if (file.includes("/@babylonjs/")) return "babylon-core";
  return "vendor";
}

// Where the site is mounted. "/" everywhere except GitHub Pages, which serves
// project sites from a `/<repo>/` subpath — the deploy workflow sets
// SPACE_ARENA_BASE. Vite guarantees import.meta.env.BASE_URL ends in "/", so
// normalize here and build the manifest URLs below from the same value.
function siteBase(): string {
  const raw = process.env.SPACE_ARENA_BASE ?? "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export default defineConfig(({ command }) => ({
  base: siteBase(),
  build: {
    rollupOptions: {
      output: { manualChunks },
    },
  },
  server: {
    host: true, // expose on LAN for phone testing (--host)
  },
  plugins: [
    contentPipelinePlugin(),
    VitePWA({
      // Off in dev: a service worker caching a Vite dev server is a debugging
      // nightmare, and the content hot-reload pipeline above would fight it.
      disable: command !== "build",
      // Ship a new SW as soon as one is built and take over silently. The game
      // is a single long-lived page; prompting mid-match would be worse.
      registerType: "autoUpdate",
      injectRegister: "auto",
      // No `includeAssets`: the workbox globPatterns below already sweep up
      // everything Vite copies out of public/ (icons, favicon, offline.html).
      // (The plugin still re-lists the manifest icons itself, so the generated
      // precache manifest holds a few duplicate url+revision pairs — workbox
      // collapses identical entries, and only *conflicting* ones would throw.)
      manifest: {
        name: "Space Arena",
        short_name: "Space Arena",
        description: "One-thumb tactical space combat. Fit your ship, manage heat, win the arena.",
        id: siteBase(),
        start_url: siteBase(),
        scope: siteBase(),
        display: "standalone",
        // Installed builds open in landscape. The runtime
        // remains orientation-adaptive for browsers that cannot honour this.
        orientation: "landscape",
        // Matches index.html's <meta name="theme-color"> and the icon artwork.
        theme_color: "#0a0f1a",
        background_color: "#05070d",
        categories: ["games", "entertainment"],
        icons: [
          { src: `${siteBase()}icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
          { src: `${siteBase()}icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
          { src: `${siteBase()}icons/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: `${siteBase()}favicon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // Precache the app shell: the HTML plus every chunk index.html loads
        // eagerly. Babylon is ~6 MB raw, well past workbox's 2 MB default.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // Nothing under these prefixes is a navigation: /api and the Colyseus
        // matchmaking POST must always hit the network, and /content is handled
        // by the network-first rule below.
        navigateFallbackDenylist: [/^\/api\//, /^\/content\//, /^\/health/, /^\/monitor/, /^\/matchmake/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // ROADMAP S6: a content pack must go live WITHOUT a redeploy, so the
            // network is always tried first and the cache is only a fallback for
            // an offline (or very slow) player.
            urlPattern: /\/content\/.*\.json(\?.*)?$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "space-arena-content-json",
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // Binary pack assets keep their URLs when a pack regenerates (the
            // lunar-rift chunk GLBs were rewritten in place), so cache-first
            // showed players old geometry inside a world whose server collision
            // had moved on. Network first; the cache is the offline fallback.
            // maxEntries must fit a full arena: 32 terrain chunks + textures +
            // props + ship hulls + audio blew past the old 60-entry LRU.
            urlPattern: /\/content\/.*\.(glb|gltf|bin|png|jpe?g|webp|ktx2|mp3|ogg|wav)(\?.*)?$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "space-arena-content-assets",
              // Generous: the match loading screen absorbs the wait, and a
              // slow-but-alive server falling back to cache would re-create
              // exactly the stale-geometry mismatch this rule exists to stop.
              networkTimeoutSeconds: 10,
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 160, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
        // The app shell is what an offline navigation gets: the game boots and
        // offline practice works off the cached content pack. `offline.html` is
        // the deeper fallback, reached from main.ts when the pack itself is
        // unavailable (see bootstrap()'s offline guard).
        navigateFallback: "index.html",
      },
      devOptions: { enabled: false },
    }),
  ],
}));
