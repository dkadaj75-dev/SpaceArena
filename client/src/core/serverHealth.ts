import { createLogger } from "@space-arena/shared";
import { httpServerUrl } from "./serverConfig.js";

const log = createLogger("ServerHealth");

/**
 * Boot-time reachability probe for the game server.
 *
 * `GET /health` (server/src/httpApp.ts) is the right target: it is
 * unauthenticated, it is the URL Playwright already waits on, it is on the
 * service-worker navigate denylist (client/vite.config.ts) so it is never
 * answered by a cached app shell, and it returns the protocol/tick identity —
 * so one round trip answers both "is anything there?" and "is it the server this
 * build expects?".
 *
 * The probe never throws: an unreachable server is a normal state the boot
 * screen and the lobby render, not an error path.
 */

/** Default probe budget. Long enough for a cold container, short enough to feel like a check. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 3500;

export interface ServerHealth {
  /** True only when the server answered 2xx with a parseable body. */
  online: boolean;
  /**
   * Short human-readable reason, empty when online. Written for a player
   * ("could not be reached"), not for a log — the lobby badge shows it verbatim.
   */
  detail: string;
  /** Wire protocol the server speaks, when it told us. */
  protocolVersion?: number;
  /** Server sim tick rate (Hz), when it told us. */
  tickRate?: number;
  /** Live content-pack hash, when the server could read its pack. */
  contentPackHash?: string | null;
}

interface HealthBody {
  status?: unknown;
  protocolVersion?: unknown;
  tickRate?: unknown;
  contentPack?: { sourceHash?: unknown } | null;
}

export interface HealthProbeOptions {
  /** Abort budget. */
  timeoutMs?: number;
  /** Full URL override — tests and the `?server=` dev override both land here. */
  url?: string;
  /** Injection seam for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

export type ServerHealthListener = (health: ServerHealth) => void;

/**
 * One live reachability verdict shared by every online-play consumer.
 *
 * Probes are coalesced so showing the lobby, an offline retry click, and the
 * offline refresh timer cannot produce a burst of identical requests.
 */
export class ServerHealthState {
  private value: ServerHealth = { online: true, detail: "" };
  private readonly listeners = new Set<ServerHealthListener>();
  private pending: Promise<ServerHealth> | null = null;

  constructor(private readonly probe: () => Promise<ServerHealth> = () => checkServerHealth()) {}

  get current(): ServerHealth {
    return this.value;
  }

  set(health: ServerHealth): void {
    this.value = health;
    for (const listener of this.listeners) listener(health);
  }

  subscribe(listener: ServerHealthListener): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<ServerHealth> {
    if (this.pending) return this.pending;
    this.pending = this.probe()
      .then((health) => {
        this.set(health);
        return health;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

/**
 * Probe the server once. Resolves either way — see the module doc.
 *
 * The timeout is enforced with an `AbortController` rather than a racing
 * `Promise`, so a dead TCP connect does not leave a request in flight for the
 * rest of the session behind a resolved promise.
 */
export async function checkServerHealth(options: HealthProbeOptions = {}): Promise<ServerHealth> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const url = options.url ?? `${httpServerUrl()}/health`;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { online: false, detail: "no network stack available" };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "GET",
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      return { online: false, detail: `server answered HTTP ${res.status}` };
    }
    const body = (await res.json()) as HealthBody;
    const online = body.status === "ok";
    return {
      online,
      detail: online ? "" : "server reported an unhealthy state",
      ...(typeof body.protocolVersion === "number" ? { protocolVersion: body.protocolVersion } : {}),
      ...(typeof body.tickRate === "number" ? { tickRate: body.tickRate } : {}),
      ...(body.contentPack && typeof body.contentPack.sourceHash === "string"
        ? { contentPackHash: body.contentPack.sourceHash }
        : {}),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    log.warn(`health probe failed: ${aborted ? `no answer in ${timeoutMs} ms` : String(err)}`);
    return {
      online: false,
      detail: aborted ? `no answer within ${Math.round(timeoutMs / 100) / 10} s` : "could not be reached",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this rejection mean "the server is not there" rather than "the server
 * said no"?
 *
 * `fetch` reports a refused connection as a bare `TypeError` whose message is
 * browser-specific ("NetworkError when attempting to fetch resource." in
 * Firefox, "Failed to fetch" in Chrome, "Load failed" in Safari), and Colyseus
 * surfaces the same failure through its own join path. That raw string used to
 * reach the player as a toast; this predicate is what lets every caller replace
 * it with one honest sentence instead. A server that answered with an
 * {@link import("./AuthService.js").ApiRequestError} is deliberately NOT a match —
 * it IS reachable, and its own message is the useful one.
 */
export function looksLikeServerUnreachable(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") {
    // Anything carrying an HTTP status came back from a live server.
    return false;
  }
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /networkerror|failed to fetch|fetch failed|load failed|network request failed|econnrefused|err_connection|err_network|err_name_not_resolved|net::|timed? ?out|abort/i.test(
    message,
  );
}

/** The one sentence every "server is not there" path shows the player. */
export const SERVER_OFFLINE_MESSAGE = "SERVER OFFLINE — online play unavailable";

/** Tooltip/label for a control that online play has taken away. */
export const SERVER_OFFLINE_HINT =
  "The game server could not be reached. Offline practice still works.";
