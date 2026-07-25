/**
 * Single source of truth for "which game server" the client talks to, shared
 * by the Colyseus (`ws://`) and REST (`http://`) transports.
 *
 * Resolution order (first match wins):
 *
 *   1. `?server=` query param — a dev/QA override for pointing a build at any
 *      server. Accepts either scheme; the two helpers translate between them.
 *   2. `VITE_SERVER_URL` build-time env — for split deploys where the static
 *      client lives on a CDN and the game server is on another origin.
 *   3. Production default: **same origin**. The production container serves the
 *      client, the REST API, the content pack and the WebSocket from one origin
 *      (ROADMAP §11 6.3), so a page on `https://play.example.com` must dial
 *      `wss://play.example.com` — never a hardcoded `:2567`, which TLS would
 *      reject as mixed content anyway.
 *   4. Dev default: `<hostname>:2567`, because Vite serves the page on :5173
 *      while the game server runs as its own process.
 */

const DEFAULT_DEV_PORT = 2567;

function overrideParam(): string | null {
  return new URLSearchParams(location.search).get("server");
}

/** Build-time override for split deploys (client and server on different origins). */
function envOverride(): string | null {
  const value = import.meta.env.VITE_SERVER_URL;
  return typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\/$/, "") : null;
}

/** The configured origin, in whatever scheme it was written, or null for "use the default". */
function configuredOrigin(): string | null {
  return overrideParam() ?? envOverride();
}

/** Colyseus endpoint, e.g. `wss://play.example.com` or `ws://localhost:2567`. */
export function wsServerUrl(): string {
  const configured = configuredOrigin();
  if (configured) return configured.replace(/^http/, "ws");
  if (import.meta.env.PROD) return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  return `ws://${location.hostname}:${DEFAULT_DEV_PORT}`;
}

/** REST API origin, e.g. `https://play.example.com` or `http://localhost:2567`. */
export function httpServerUrl(): string {
  const configured = configuredOrigin();
  if (configured) return configured.replace(/^ws/, "http");
  if (import.meta.env.PROD) return location.origin;
  return `http://${location.hostname}:${DEFAULT_DEV_PORT}`;
}
