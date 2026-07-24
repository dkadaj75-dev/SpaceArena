/**
 * Single source of truth for "which game server" the client talks to, shared
 * by the Colyseus (`ws://`) and REST (`http://`) transports. Both honor the
 * same `?server=` dev override so pointing the client at a non-default server
 * only requires setting one query param.
 */

const DEFAULT_PORT = 2567;

function overrideParam(): string | null {
  return new URLSearchParams(location.search).get("server");
}

/** Colyseus endpoint, e.g. `ws://localhost:2567` (or the raw `?server=` value). */
export function wsServerUrl(): string {
  return overrideParam() || `ws://${location.hostname}:${DEFAULT_PORT}`;
}

/** REST API origin, e.g. `http://localhost:2567`. Derives from the same override. */
export function httpServerUrl(): string {
  const override = overrideParam();
  if (override) return override.replace(/^ws/, "http");
  return `http://${location.hostname}:${DEFAULT_PORT}`;
}
