import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  server: {
    host: true, // expose on LAN for phone testing (--host)
  },
  plugins: [contentPipelinePlugin()],
});
