import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, AuthService, type AuthState } from "./AuthService.js";

const BASE = "http://localhost:2567";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** Typed fetch mock returning each response in order (repeats the last once exhausted). */
function fetchSequence(...responses: Response[]) {
  let i = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return r;
  });
}

const profile = { userId: "u1", displayName: "Guest-1234", level: 1, xp: 0, credits: 0, isGuest: true };
const pair = { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900, profile };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthService.guest", () => {
  it("creates a guest and persists the token triad", async () => {
    const fetchMock = fetchSequence(jsonResponse({ ...pair, guestToken: "gt-1" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.guest();

    expect(auth.getState()).toEqual({ status: "authed", profile });
    expect(localStorage.getItem("accessToken")).toBe("access-1");
    expect(localStorage.getItem("refreshToken")).toBe("refresh-1");
    expect(localStorage.getItem("guestToken")).toBe("gt-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/auth/guest`);
    expect(JSON.parse(init!.body as string)).toEqual({ displayName: undefined, guestToken: undefined });
  });
});

describe("AuthService.register (guest upgrade)", () => {
  it("attaches the current access token as the Authorization bearer so the server upgrades in place", async () => {
    const fetchMock = fetchSequence(
      jsonResponse({ ...pair, guestToken: "gt-1" }, 201),
      jsonResponse({ ...pair, accessToken: "access-2", profile: { ...profile, isGuest: false } }, 200),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.guest(); // establishes a guest session first

    await auth.register("PlayerOne", "hunter22", "player@example.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${BASE}/api/auth/register`);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
    expect(JSON.parse(init!.body as string)).toEqual({
      displayName: "PlayerOne",
      password: "hunter22",
      email: "player@example.com",
    });
    expect(auth.getState()).toEqual({ status: "authed", profile: { ...profile, isGuest: false } });
  });

  it("registers with no email at all — the nickname is the only required field", async () => {
    const fetchMock = fetchSequence(jsonResponse({ ...pair, profile: { ...profile, isGuest: false } }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.register("PlayerOne", "hunter22");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/auth/register`);
    // `email: undefined` is dropped by JSON.stringify → the server sees no email.
    expect(JSON.parse(init!.body as string)).toEqual({ displayName: "PlayerOne", password: "hunter22" });
  });
});

describe("AuthService.login", () => {
  it("posts the nickname-or-email as `identifier`", async () => {
    const fetchMock = fetchSequence(jsonResponse({ ...pair, profile: { ...profile, isGuest: false } }));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.login("PlayerOne", "hunter22");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/auth/login`);
    expect(JSON.parse(init!.body as string)).toEqual({ identifier: "PlayerOne", password: "hunter22" });
  });
});

describe("AuthService 401 handling", () => {
  it("retries once via /refresh on a 401, then succeeds transparently", async () => {
    const fetchMock = fetchSequence(
      errorResponse("unauthorized", "expired", 401), // GET /me — expired access token
      jsonResponse({ ...pair, accessToken: "access-2", refreshToken: "refresh-2" }), // POST /refresh
      jsonResponse({ profile }), // retried GET /me
    );
    vi.stubGlobal("fetch", fetchMock);

    // Seed a session without going through guest()/login() so /me is the first call.
    localStorage.setItem("accessToken", "access-1");
    localStorage.setItem("refreshToken", "refresh-1");
    const auth = new AuthService(BASE);
    await auth.restore();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/api/auth/refresh`);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ refreshToken: "refresh-1" });
    expect(auth.getState()).toEqual({ status: "authed", profile });
    expect(localStorage.getItem("accessToken")).toBe("access-2");
  });

  it("clears the session and ends anonymous if the refresh itself fails", async () => {
    const fetchMock = fetchSequence(
      errorResponse("unauthorized", "expired", 401),
      errorResponse("invalid-refresh", "refresh token is invalid or expired", 401),
    );
    vi.stubGlobal("fetch", fetchMock);

    localStorage.setItem("accessToken", "access-1");
    localStorage.setItem("refreshToken", "refresh-1");
    const auth = new AuthService(BASE);
    await auth.restore();

    // restore() swallows the me() failure and, with no guestToken stored, ends anonymous.
    expect(auth.getState()).toEqual({ status: "anonymous" });
    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(localStorage.getItem("refreshToken")).toBeNull();
  });

  it("surfaces ApiRequestError with the server's error code for non-401 failures", async () => {
    const fetchMock = fetchSequence(errorResponse("invalid-credentials", "email or password is incorrect", 401));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await expect(auth.login("nobody@example.com", "wrongpass")).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe("AuthService.restore", () => {
  it("goes straight to /me when a valid access+refresh pair is stored", async () => {
    const fetchMock = fetchSequence(jsonResponse({ profile }));
    vi.stubGlobal("fetch", fetchMock);

    localStorage.setItem("accessToken", "access-1");
    localStorage.setItem("refreshToken", "refresh-1");
    const auth = new AuthService(BASE);
    await auth.restore();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/api/auth/me`);
    expect(auth.getState()).toEqual({ status: "authed", profile });
  });

  it("falls back to restoring the guest identity via POST /guest when no access/refresh pair exists", async () => {
    const fetchMock = fetchSequence(jsonResponse({ ...pair, guestToken: "gt-1" }));
    vi.stubGlobal("fetch", fetchMock);

    localStorage.setItem("guestToken", "gt-1");
    const auth = new AuthService(BASE);
    await auth.restore();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/auth/guest`);
    expect(JSON.parse(init!.body as string)).toEqual({ displayName: undefined, guestToken: "gt-1" });
    expect(auth.getState()).toEqual({ status: "authed", profile });
  });

  it("stays anonymous with no stored tokens at all", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.restore();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.getState()).toEqual({ status: "anonymous" });
  });
});

describe("Finding 6 — stale guest credential cleanup", () => {
  it("removes the stored guestToken once a guest upgrades via register", async () => {
    const fetchMock = fetchSequence(
      jsonResponse({ ...pair, guestToken: "gt-1" }, 201), // guest()
      jsonResponse({ ...pair, accessToken: "access-2", profile: { ...profile, isGuest: false } }), // register upgrade
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.guest();
    expect(localStorage.getItem("guestToken")).toBe("gt-1");

    await auth.register("PlayerOne", "hunter22", "player@example.com");
    expect(localStorage.getItem("guestToken")).toBeNull();
  });

  it("removes any stale guestToken left over from a prior session after a plain (non-guest) login", async () => {
    localStorage.setItem("guestToken", "stale-gt");
    const fetchMock = fetchSequence(jsonResponse({ ...pair, profile: { ...profile, isGuest: false } }));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.login("player@example.com", "hunter22");

    expect(localStorage.getItem("guestToken")).toBeNull();
  });

  it("restore(): a guest token the server rejects as invalid is cleared, ending anonymous without minting a new guest", async () => {
    localStorage.setItem("guestToken", "bad-gt");
    const fetchMock = fetchSequence(errorResponse("invalid-guest-token", "unknown guest token", 401));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.restore();

    // Exactly one /guest call — no automatic retry that would mint a fresh guest.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("guestToken")).toBeNull();
    expect(auth.getState()).toEqual({ status: "anonymous" });
  });
});

describe("Finding 8 — concurrent refresh is serialized", () => {
  it("two parallel 401s share a single /refresh call and both retries succeed", async () => {
    const auth = new AuthService(BASE);
    localStorage.setItem("accessToken", "access-1");
    localStorage.setItem("refreshToken", "refresh-1");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ profile })));
    await auth.restore(); // seeds accessToken/refreshToken="access-1"/"refresh-1", authed

    const fetchMock = fetchSequence(
      errorResponse("unauthorized", "expired", 401), // me #1
      errorResponse("unauthorized", "expired", 401), // me #2
      jsonResponse({ ...pair, accessToken: "access-2", refreshToken: "refresh-2" }), // the one shared /refresh
      jsonResponse({ profile }), // retried me #1
      jsonResponse({ profile }), // retried me #2
    );
    vi.stubGlobal("fetch", fetchMock);

    const [p1, p2] = await Promise.all([auth.me(), auth.me()]);

    expect(p1).toEqual(profile);
    expect(p2).toEqual(profile);
    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url === `${BASE}/api/auth/refresh`);
    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(auth.getState()).toEqual({ status: "authed", profile }); // no logout
    expect(localStorage.getItem("accessToken")).toBe("access-2");
  });

  it("a shared refresh failure fails both callers and clears the session exactly once", async () => {
    const auth = new AuthService(BASE);
    localStorage.setItem("accessToken", "access-1");
    localStorage.setItem("refreshToken", "refresh-1");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ profile })));
    await auth.restore();

    const stateChanges: AuthState[] = [];
    auth.onChange((s) => stateChanges.push(s));

    const fetchMock = fetchSequence(
      errorResponse("unauthorized", "expired", 401), // me #1
      errorResponse("unauthorized", "expired", 401), // me #2
      errorResponse("invalid-refresh", "refresh token is invalid or expired", 401), // the one shared /refresh
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.allSettled([auth.me(), auth.me()]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url === `${BASE}/api/auth/refresh`);
    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // no extra retries after the shared refresh failed
    expect(auth.getState()).toEqual({ status: "anonymous" });
    // clearSession must fire once for the shared failure, not once per caller.
    expect(stateChanges.filter((s) => s.status === "anonymous")).toHaveLength(1);
  });
});

describe("AuthService.logout", () => {
  it("clears every stored token, including the durable guestToken", async () => {
    const fetchMock = fetchSequence(jsonResponse({ ...pair, guestToken: "gt-1" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const auth = new AuthService(BASE);
    await auth.guest();
    auth.logout();

    expect(auth.getState()).toEqual({ status: "anonymous" });
    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(localStorage.getItem("refreshToken")).toBeNull();
    expect(localStorage.getItem("guestToken")).toBeNull();
  });
});
