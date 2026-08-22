import {
  createLogger,
  type ApiInventory,
  type HardpointMap,
  type ModuleFamily,
  type SocketConfig,
  type UpgradeTrackName,
} from "@space-arena/shared";
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

/** The profile block every auth response (and `/api/auth/me`) carries. */
export interface ApiProfile {
  userId: string;
  displayName: string;
  level: number;
  xp: number;
  credits: number;
  isGuest: boolean;
  role?: "player" | "admin";
}

/**
 * One row of `/api/fittings` — a pilot's loadout for ONE hull, and since
 * 2026-08-22 the only row they have for it. The server still stores a `name`
 * column (it is `NOT NULL` in the original schema) but writes a constant into
 * it; it is deliberately absent here so no UI can grow a fitting name back.
 */
export interface ApiFitting {
  id: string;
  user_id: string;
  ship_id: string;
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

  /**
   * Profile + the WHOLE inventory in one read (hulls, modules, paints, equipped
   * paint per hull). The shop and the Hangar both need all of it at once, which
   * is why it rides the existing profile read instead of a second endpoint that
   * could disagree with it.
   */
  inventory(signal?: AbortSignal): Promise<{ profile: ApiProfile; inventory: ApiInventory }> {
    return this.request("GET", "/api/auth/me", undefined, signal);
  }

  buyShip(shipId: string): Promise<{ shipId: string; credits: number }> {
    return this.request("POST", "/api/ships/buy", { shipId });
  }

  buyCosmetic(cosmeticId: string): Promise<{ cosmeticId: string; credits: number }> {
    return this.request("POST", "/api/cosmetics/buy", { cosmeticId });
  }

  /** `cosmeticId: null` clears back to the hull's authored look. */
  selectCosmetic(shipId: string, cosmeticId: string | null): Promise<{ shipId: string; cosmeticId: string | null }> {
    return this.request("POST", "/api/cosmetics/select", { shipId, cosmeticId });
  }

  upgradeShip(shipId: string, track: UpgradeTrackName): Promise<{ shipId: string; track: UpgradeTrackName; level: number; credits: number }> {
    return this.request("POST", `/api/ships/${encodeURIComponent(shipId)}/upgrade`, { track });
  }

  /** Every hull's loadout, at most one row per ship. */
  fittings(signal?: AbortSignal): Promise<{ fittings: ApiFitting[] }> {
    return this.request("GET", "/api/fittings", undefined, signal);
  }

  /**
   * Make `hardpointMap` this hull's loadout. An upsert addressed by SHIP id:
   * the row's own id is derived server-side from (user, ship), so the client
   * never holds, stores or sends a fitting id — which is what let the whole
   * save/load/select/delete surface disappear without the wire changing shape.
   */
  saveLoadout(shipId: string, hardpointMap: HardpointMap): Promise<{ fitting: ApiFitting }> {
    return this.request("PUT", `/api/fittings/${encodeURIComponent(shipId)}`, { hardpointMap });
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
