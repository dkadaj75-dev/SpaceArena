import { createLogger, type HardpointMap, type ModuleFamily, type SocketConfig, type UpgradeTrackName } from "@space-arena/shared";
import type { AuthService } from "../core/AuthService.js";
import { httpServerUrl } from "../core/serverConfig.js";

const log = createLogger("HangarApi");

export interface ApiHardpoint {
  id: string;
  accepts: ModuleFamily[];
}

export interface ApiShip {
  id: string;
  name: string;
  class: string;
  hardpoints: ApiHardpoint[];
  sockets: SocketConfig[];
  upgrades: Record<UpgradeTrackName, number>;
}

export interface ApiModule {
  id: string;
  name: string;
  family: ModuleFamily;
  level: number;
  price: number;
  requiresLevel: number;
  owned: boolean;
}

export interface ApiFitting {
  id: string;
  user_id: string;
  ship_id: string;
  name: string;
  hardpointMap: HardpointMap;
  created_at: string;
}

/** Thrown for any non-2xx `/api/*` response; carries the server's error envelope (see `server/src/api/README.md`). */
export class HangarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HangarApiError";
  }
}

/**
 * Owns the single inventory read allowed for a Hangar visit. Starting a new
 * read aborts and invalidates the old one, so callers can safely ignore late
 * completions even when a transport cannot honour an abort immediately.
 */
export class HangarRefreshScope {
  private version = 0;
  private controller: AbortController | null = null;

  begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort();
    this.controller = new AbortController();
    return { token: ++this.version, signal: this.controller.signal };
  }

  isCurrent(token: number, signal: AbortSignal): boolean {
    return token === this.version && this.controller?.signal === signal && !signal.aborted;
  }

  /** Abort the active read and make all of its callbacks permanently stale. */
  invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.version++;
  }
}

/**
 * Thin fetch wrapper over the auth-required fittings/ships/modules REST
 * surface (`server/src/api/README.md`). Deliberately standalone rather than
 * reusing {@link AuthService}'s private `request()` (that class lives outside
 * this task's ownership — see the Hangar screen's module doc) — reads the
 * current access token from it and attaches `Authorization: Bearer <token>`.
 *
 * No 401-retry/refresh loop: access tokens last 15 min and a Hangar visit is
 * short, so a request that lands right as the token expires just surfaces an
 * error (`unauthorized`) — the caller can prompt the user to reopen Hangar,
 * which re-reads the (by-then AuthService-refreshed) token. See the
 * `HANGAR_API_GAPS` doc comment in Hangar.ts for the full rationale.
 */
export class HangarApi {
  constructor(
    private readonly auth: AuthService,
    private readonly baseUrl = httpServerUrl(),
  ) {}

  ships(signal?: AbortSignal): Promise<{ ships: ApiShip[] }> {
    return this.request("GET", "/api/ships", undefined, signal);
  }

  modules(signal?: AbortSignal): Promise<{ modules: ApiModule[] }> {
    return this.request("GET", "/api/modules", undefined, signal);
  }

  buyModule(moduleId: string): Promise<{ moduleId: string; credits: number }> {
    return this.request("POST", "/api/modules/buy", { moduleId });
  }

  upgradeShip(shipId: string, track: UpgradeTrackName): Promise<{ shipId: string; track: UpgradeTrackName; level: number; credits: number }> {
    return this.request("POST", `/api/ships/${encodeURIComponent(shipId)}/upgrade`, { track });
  }

  fittings(signal?: AbortSignal): Promise<{ fittings: ApiFitting[] }> {
    return this.request("GET", "/api/fittings", undefined, signal);
  }

  createFitting(shipId: string, name: string, hardpointMap: HardpointMap): Promise<{ fitting: ApiFitting }> {
    return this.request("POST", "/api/fittings", { shipId, name, hardpointMap });
  }

  updateFitting(id: string, body: { name?: string; hardpointMap?: HardpointMap }): Promise<{ fitting: ApiFitting }> {
    return this.request("PUT", `/api/fittings/${encodeURIComponent(id)}`, body);
  }

  deleteFitting(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/fittings/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = this.auth.getAccessToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      let code = "unknown";
      let message = `HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error: { code: string; message: string } };
        code = errBody.error.code;
        message = errBody.error.message;
      } catch {
        // non-JSON error body — fall back to the generic message
      }
      log.warn(`${method} ${path} -> ${res.status} ${code}`);
      throw new HangarApiError(code, message, res.status);
    }
    return (await res.json()) as T;
  }
}
