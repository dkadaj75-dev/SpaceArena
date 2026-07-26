import { describe, expect, it, vi } from "vitest";
import {
  checkServerHealth,
  looksLikeServerUnreachable,
  DEFAULT_HEALTH_TIMEOUT_MS,
} from "./serverHealth.js";

const URL = "http://localhost:2567/health";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("checkServerHealth", () => {
  it("reads the live server's identity out of a healthy answer", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ status: "ok", protocolVersion: 4, tickRate: 30, contentPack: { sourceHash: "abc123" } }),
      ),
    );
    const health = await checkServerHealth({ url: URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(health).toEqual({
      online: true,
      detail: "",
      protocolVersion: 4,
      tickRate: 30,
      contentPackHash: "abc123",
    });
    expect(fetchImpl).toHaveBeenCalledWith(URL, expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("stays online when the server could not read its own content pack", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: "ok", contentPack: null })));
    const health = await checkServerHealth({ url: URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(health.online).toBe(true);
    expect(health.contentPackHash).toBeUndefined();
  });

  it("reports a non-2xx answer as offline with the status in the detail", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({}, 503)));
    const health = await checkServerHealth({ url: URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(health.online).toBe(false);
    expect(health.detail).toContain("503");
  });

  it("never throws when the connection is refused", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    const health = await checkServerHealth({ url: URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(health).toEqual({ online: false, detail: "could not be reached" });
  });

  it("gives up after the timeout and says so in seconds", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const fetchImpl = vi.fn(() => Promise.reject(abortError));
    const health = await checkServerHealth({
      url: URL,
      timeoutMs: 3500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(health.online).toBe(false);
    expect(health.detail).toBe("no answer within 3.5 s");
  });

  it("passes an abort signal so a dead connect does not leak a request", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ status: "ok" })),
    );
    await checkServerHealth({ url: URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults to a probe budget that is a check, not a wait", () => {
    expect(DEFAULT_HEALTH_TIMEOUT_MS).toBeLessThanOrEqual(4000);
    expect(DEFAULT_HEALTH_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe("looksLikeServerUnreachable", () => {
  it("recognises every browser's phrasing for a refused connection", () => {
    // The exact string that used to reach the player as a toast.
    expect(looksLikeServerUnreachable(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(looksLikeServerUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(looksLikeServerUnreachable(new TypeError("Load failed"))).toBe(true);
    expect(looksLikeServerUnreachable(new Error("connect ECONNREFUSED 127.0.0.1:2567"))).toBe(true);
    expect(looksLikeServerUnreachable("net::ERR_CONNECTION_REFUSED")).toBe(true);
  });

  it("does NOT claim unreachable for an answer the server actually gave", () => {
    // ApiRequestError-shaped: it carries an HTTP status, so something answered.
    expect(looksLikeServerUnreachable({ status: 401, message: "Failed to fetch profile" })).toBe(false);
    expect(looksLikeServerUnreachable(new Error("invalid-fitting: not-owned"))).toBe(false);
    expect(looksLikeServerUnreachable(new Error("Room not found"))).toBe(false);
  });
});
