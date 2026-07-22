import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { CONFIG_SCHEMAS, type ConfigType } from "../shared/src/schemas/index.js";

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
              const absolute = path.resolve(CONTENT_DIR, payload.path);
              if (!absolute.startsWith(CONTENT_DIR) || !payload.path.endsWith(".json")) throw new Error("invalid content path");
              const candidate = payload.json;
              if (!isConfigObject(candidate)) throw new Error("config must contain a known type");
              const parsed = CONFIG_SCHEMAS[candidate.type].safeParse(candidate);
              if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
              await writeFile(absolute, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (error) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(error) }));
            }
          })();
        });
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

function isConfigObject(value: unknown): value is { type: ConfigType } {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && (value as { type: string }).type in CONFIG_SCHEMAS;
}

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Keep Babylon in its own always-loaded vendor chunk so the lazy editor
        // chunk stays small and is NOT pulled in at boot via shared imports.
        manualChunks: (id) => (id.includes("@babylonjs") ? "babylon" : undefined),
      },
    },
  },
  server: {
    host: true, // expose on LAN for phone testing (--host)
  },
  plugins: [contentPipelinePlugin()],
});
