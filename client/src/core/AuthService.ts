import { createLogger } from "@space-arena/shared";
import { httpServerUrl } from "./serverConfig.js";

const log = createLogger("AuthService");

const LS_ACCESS = "accessToken";
const LS_REFRESH = "refreshToken";
const LS_GUEST = "guestToken";

/** Public profile payload returned by every auth response and `/me`. */
export interface Profile {
  userId: string;
  displayName: string;
  level: number;
  xp: number;
  credits: number;
  isGuest: boolean;
}

/** Token pair + profile returned by every `/api/auth/*` route except `/me`. */
interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  guestToken?: string;
  profile: Profile;
}

export type AuthState = { status: "anonymous" } | { status: "authed"; profile: Profile };

/** Thrown for any non-2xx API response; carries the server's error envelope. */
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface ApiErrorBody {
  error: { code: string; message: string };
}

export type AuthListener = (state: AuthState) => void;

/**
 * Wraps `server/src/api/README.md`'s `/api/auth` surface: guest/register/login/
 * refresh/me plus the localStorage token lifecycle (access + refresh + durable
 * guest token) and transparent 401 → refresh-and-retry.
 *
 * Session-restore contract (README-driven, no invented endpoints):
 *  - `accessToken` (15 min) + `refreshToken` (7 days, rotated on use) are the
 *    primary restore path: call `/me` with the stored access token; on a 401
 *    (expired access token) `request()` rotates via `/refresh` once and
 *    retries automatically.
 *  - There is no endpoint to validate a bare `guestToken` on its own, but
 *    `POST /guest` accepts a known `guestToken` to *restore* that guest
 *    identity (issuing a fresh pair) per the README ("With a known
 *    `guestToken`, restores that guest → 200"). `restore()` therefore falls
 *    back to `guest()` (which re-sends the stored token) whenever the
 *    access/refresh pair is missing or its refresh has also expired — e.g. a
 *    guest who hasn't opened the client in over 7 days. This costs one extra
 *    `/guest` round trip but keeps the guest's progress instead of losing it,
 *    and it uses only documented routes.
 */
export class AuthService {
  private state: AuthState = { status: "anonymous" };
  private readonly listeners = new Set<AuthListener>();
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor(private readonly baseUrl = httpServerUrl()) {}

  getState(): AuthState {
    return this.state;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  onChange(fn: AuthListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Boot-time session restore; see class doc for the fallback order. */
  async restore(): Promise<void> {
    this.accessToken = localStorage.getItem(LS_ACCESS);
    this.refreshToken = localStorage.getItem(LS_REFRESH);
    if (this.accessToken && this.refreshToken) {
      try {
        const profile = await this.me();
        this.setState({ status: "authed", profile });
        return;
      } catch (err) {
        log.info("access/refresh restore failed, trying guest-token fallback", err);
      }
    }
    if (localStorage.getItem(LS_GUEST)) {
      try {
        await this.guest();
        return;
      } catch (err) {
        // guest() itself clears the stored guestToken when the server reports
        // it as invalid (401 invalid-guest-token) — restore() must not paper
        // over that by minting a brand-new guest; only the explicit "Play as
        // Guest" button is allowed to create one (Finding 6).
        log.warn("guest-token restore failed", err);
      }
    }
    this.clearSession();
  }

  /** Creates a new guest, or restores the one named by a stored guestToken. */
  async guest(displayName?: string): Promise<void> {
    const guestToken = localStorage.getItem(LS_GUEST) ?? undefined;
    try {
      const pair = await this.request<TokenPair>("POST", "/api/auth/guest", { displayName, guestToken });
      this.setSession(pair);
    } catch (err) {
      // A stored guestToken the server no longer recognizes must not linger —
      // otherwise every future restore()/guest() call keeps retrying it.
      if (guestToken && err instanceof ApiRequestError && err.code === "invalid-guest-token") {
        localStorage.removeItem(LS_GUEST);
      }
      throw err;
    }
  }

  /**
   * Registers a new account. If currently authed as a guest, the guest's
   * access token rides along (attached automatically by `request()`) and the
   * server upgrades that identity in place instead of creating a new one.
   */
  async register(email: string, password: string, displayName?: string): Promise<void> {
    const pair = await this.request<TokenPair>("POST", "/api/auth/register", { email, password, displayName });
    this.setSession(pair);
  }

  async login(email: string, password: string): Promise<void> {
    const pair = await this.request<TokenPair>("POST", "/api/auth/login", { email, password });
    this.setSession(pair);
  }

  /**
   * DEV ONLY: passwordless admin session via the server's dev-login route
   * (404s in production, so this can never succeed there). Returns false
   * instead of throwing when the server is down — the caller falls back to
   * the normal auth screen.
   */
  async devLogin(): Promise<boolean> {
    try {
      const pair = await this.request<TokenPair>("POST", "/api/auth/dev-login");
      this.setSession(pair);
      // Marker so a LATER visit from a LAN hostname can tell this stored
      // session came from the dev shortcut and drop it (see main.ts) — two
      // devices silently sharing the dev-admin identity cannot matchmake.
      localStorage.setItem("sa.devSession", "1");
      return true;
    } catch (err) {
      log.info("dev-login unavailable (server down or production build)", err);
      return false;
    }
  }

  /** True when the stored session was created by {@link devLogin}. */
  isDevSession(): boolean {
    return localStorage.getItem("sa.devSession") === "1";
  }

  async me(): Promise<Profile> {
    const body = await this.request<{ profile: Profile }>("GET", "/api/auth/me");
    if (this.state.status === "authed") this.setState({ status: "authed", profile: body.profile });
    return body.profile;
  }

  /** Refreshes the profile (credits/xp/level) for the currently authed user, if any. */
  async refreshProfile(): Promise<void> {
    if (this.state.status !== "authed") return;
    try {
      await this.me();
    } catch (err) {
      log.warn("profile refresh failed", err);
    }
  }

  /** Authenticated JSON API call with the same refresh-and-retry behavior as auth routes. */
  api<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body);
  }

  /** Clears all local session state, including the durable guest token. */
  logout(): void {
    localStorage.removeItem(LS_GUEST);
    localStorage.removeItem("sa.devSession");
    this.clearSession();
  }

  private setState(state: AuthState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  private setSession(pair: TokenPair): void {
    this.accessToken = pair.accessToken;
    this.refreshToken = pair.refreshToken;
    localStorage.setItem(LS_ACCESS, pair.accessToken);
    localStorage.setItem(LS_REFRESH, pair.refreshToken);
    if (pair.guestToken) {
      localStorage.setItem(LS_GUEST, pair.guestToken);
    } else if (!pair.profile.isGuest) {
      // Register (guest upgrade) or login for a non-guest account — any stale
      // guest identity left over from a prior, un-upgraded guest session must
      // not resurface on a future restore() (Finding 6).
      localStorage.removeItem(LS_GUEST);
    }
    this.setState({ status: "authed", profile: pair.profile });
  }

  /** Drops the in-memory + access/refresh localStorage session (guestToken kept). */
  private clearSession(): void {
    this.accessToken = null;
    this.refreshToken = null;
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
    this.setState({ status: "anonymous" });
  }

  /**
   * Serializes concurrent refresh attempts through one shared network call
   * (Finding 8): every request that hits a 401 awaits the same in-flight
   * promise instead of each firing its own `/refresh`, so a burst of
   * concurrently-expiring requests rotates the single-use refresh token
   * exactly once. Losers reuse the winner's result; `clearSession` runs at
   * most once, inside `performRefresh`, when that shared attempt definitively
   * fails.
   */
  private refreshInFlight: Promise<boolean> | null = null;

  private tryRefresh(): Promise<boolean> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<boolean> {
    const refreshToken = this.refreshToken;
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        this.clearSession();
        return false;
      }
      const pair = (await res.json()) as TokenPair;
      this.accessToken = pair.accessToken;
      this.refreshToken = pair.refreshToken;
      localStorage.setItem(LS_ACCESS, pair.accessToken);
      localStorage.setItem(LS_REFRESH, pair.refreshToken);
      return true;
    } catch (err) {
      log.warn("token refresh failed", err);
      this.clearSession();
      return false;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, isRetry = false): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !isRetry) {
      if (this.refreshToken) {
        const refreshed = await this.tryRefresh();
        if (refreshed) return this.request<T>(method, path, body, true);
        // performRefresh() already cleared the session on definitive failure.
        throw await this.buildError(res);
      }
      this.clearSession();
      throw await this.buildError(res);
    }

    if (!res.ok) {
      if (res.status === 401) this.clearSession(); // a retried request that still 401s
      throw await this.buildError(res);
    }
    return (await res.json()) as T;
  }

  private async buildError(res: Response): Promise<ApiRequestError> {
    let code = "unknown";
    let message = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as ApiErrorBody;
      code = errBody.error.code;
      message = errBody.error.message;
    } catch {
      // Non-JSON error body (e.g. proxy 502) — fall back to the generic message.
    }
    return new ApiRequestError(code, message, res.status);
  }
}
