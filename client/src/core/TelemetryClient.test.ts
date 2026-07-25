import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGlobalLogLevel } from "@space-arena/shared";
import { TelemetryClient } from "./TelemetryClient.js";

setGlobalLogLevel("error");

const HASH = "0123456789abcdef0123456789abcdef";

function client(overrides: Partial<ConstructorParameters<typeof TelemetryClient>[0]> = {}): {
  telemetry: TelemetryClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  const telemetry = new TelemetryClient({
    baseUrl: "http://test.local",
    enabled: true,
    sessionHash: HASH,
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  });
  return { telemetry, fetchMock };
}

/** Feed `frames` frames of `dtMs` each. */
function render(telemetry: TelemetryClient, frames: number, dtMs: number): void {
  for (let i = 0; i < frames; i++) telemetry.sampleFrame(dtMs);
}

const tier = { qualityTier: "med" as const, deviceProbe: { mobile: false } };

describe("TelemetryClient", () => {
  it("mints a schema-valid session hash from the platform CSPRNG", () => {
    const telemetry = new TelemetryClient({ baseUrl: "http://test.local", enabled: false });
    expect(telemetry.sessionHash).toMatch(/^[0-9a-f]{32}$/);
    const other = new TelemetryClient({ baseUrl: "http://test.local", enabled: false });
    expect(other.sessionHash).not.toBe(telemetry.sessionHash);
  });

  it("averages frames per second of wall clock, not per-frame readings", () => {
    const { telemetry } = client();
    telemetry.beginMatch();
    // 90 frames at 10 ms + 10 frames at 100 ms = 100 frames over 1.9 s.
    render(telemetry, 90, 10);
    render(telemetry, 10, 100);
    // Frame-weighted would report ~(90*100 + 10*10)/100 = 91 FPS; the honest
    // answer is 100 frames / 1.9 s ≈ 52.6.
    expect(telemetry.averageFps()).toBeCloseTo(52.63, 1);
  });

  it("drops stalls so a backgrounded tab does not fake a slow session", () => {
    const { telemetry } = client();
    telemetry.beginMatch();
    render(telemetry, 60, 16);
    telemetry.sampleFrame(5000); // alt-tabbed for five seconds
    expect(telemetry.averageFps()).toBeCloseTo(62.5, 1);
  });

  it("ignores frames sampled outside a match", () => {
    const { telemetry } = client();
    render(telemetry, 100, 16);
    expect(telemetry.averageFps()).toBeNull();
  });

  it("posts the bucketed report and nothing else", async () => {
    const { telemetry, fetchMock } = client();
    telemetry.beginMatch();
    render(telemetry, 100, 25); // 40 FPS → "30-45"
    await telemetry.endMatch({ qualityTier: "low", deviceProbe: { mobile: true } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/api/telemetry/client");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      sessionHash: HASH,
      fpsBucket: "30-45",
      deviceClass: "mobile",
      qualityTier: "low",
    });
  });

  it("maps the device probe to a device class", async () => {
    const { telemetry, fetchMock } = client();
    telemetry.beginMatch();
    render(telemetry, 10, 16);
    await telemetry.endMatch({ qualityTier: "high", deviceProbe: { mobile: false } });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).deviceClass).toBe("desktop");
  });

  it("reports at most once per match, and only after beginMatch", async () => {
    const { telemetry, fetchMock } = client();
    await telemetry.endMatch(tier); // never began
    expect(fetchMock).not.toHaveBeenCalled();

    telemetry.beginMatch();
    render(telemetry, 10, 16);
    await telemetry.endMatch(tier);
    await telemetry.endMatch(tier); // duplicate matchEnded event
    expect(fetchMock).toHaveBeenCalledTimes(1);

    telemetry.beginMatch();
    render(telemetry, 10, 16);
    await telemetry.endMatch(tier);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not report a match that never rendered a frame", async () => {
    const { telemetry, fetchMock } = client();
    telemetry.beginMatch();
    await telemetry.endMatch(tier);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resets the accumulator between matches", async () => {
    const { telemetry, fetchMock } = client();
    telemetry.beginMatch();
    render(telemetry, 100, 100); // 10 FPS
    await telemetry.endMatch(tier);

    telemetry.beginMatch();
    render(telemetry, 100, 10); // 100 FPS — must not be dragged down by the first match
    await telemetry.endMatch(tier);

    const second = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(second.fpsBucket).toBe("60+");
  });

  it("logs instead of sending when disabled (the dev default)", async () => {
    const { telemetry, fetchMock } = client({ enabled: false });
    telemetry.beginMatch();
    render(telemetry, 10, 16);
    await telemetry.endMatch(tier);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a network failure so the results screen never sees it", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const { telemetry } = client({ fetchImpl: failing as unknown as typeof fetch });
    telemetry.beginMatch();
    render(telemetry, 10, 16);
    await expect(telemetry.endMatch(tier)).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("TelemetryClient default fetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the global fetch when none is injected", async () => {
    const telemetry = new TelemetryClient({ baseUrl: "http://test.local", enabled: true, sessionHash: HASH });
    telemetry.beginMatch();
    render(telemetry, 10, 16);
    await telemetry.endMatch(tier);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
