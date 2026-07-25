import {
  bucketFps,
  createLogger,
  deviceClassOf,
  type ClientMetricBody,
  type DeviceClass,
  type QualityTier,
} from "@space-arena/shared";
import { httpServerUrl } from "./serverConfig.js";

const log = createLogger("Telemetry");

/**
 * Anonymous per-match client telemetry (ROADMAP §11 6.8).
 *
 * Measures the average frame rate over a match, buckets it, and posts that
 * bucket together with the device class and the active quality tier. That is the
 * whole payload — see shared/src/net/telemetry.ts for the privacy contract it
 * has to satisfy.
 *
 * ## What "average FPS" means here
 *
 * Frames divided by seconds, not the mean of per-frame `engine.getFps()`
 * readings. The two differ: averaging instantaneous readings weights every frame
 * equally, so a hundred cheap 120 FPS frames drown out the ten 15 FPS frames the
 * player actually felt. Frames-per-second-of-wall-clock is the number that
 * matches the experience, and it is the one the roadmap's "≥ 30 FPS on a
 * mid-range phone" criterion is written against.
 *
 * (`QualityManager`'s auto-tier sampler stays frame-weighted — it is choosing a
 * tier from a short warm-up window, a different question with a different right
 * answer.)
 *
 * ## Dev behaviour
 *
 * Off in development: the report is logged, not sent, so a day of `npm run dev`
 * does not fill the working database with rows from one machine. Set
 * `VITE_SPACE_ARENA_TELEMETRY=1` to send from a dev build; production always
 * sends.
 */

/** Frames longer than this were a stall (backgrounded tab, GC pause, alt-tab). */
const MAX_FRAME_MS = 250;

export interface TelemetryClientOptions {
  /** API origin. Defaults to the same resolution AuthService/HangarApi use. */
  baseUrl?: string;
  /** Override the environment gate (tests, and the dev opt-in flag). */
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  /** Session-hash source. Injected by tests; production uses `crypto`. */
  sessionHash?: string;
}

export class TelemetryClient {
  /**
   * Random 128-bit handle, minted once per page load. Never persisted, never
   * derived from anything about the user, never sent anywhere but the telemetry
   * endpoint.
   */
  readonly sessionHash: string;
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly fetchImpl: typeof fetch;

  private frames = 0;
  private elapsedMs = 0;
  /** True between {@link beginMatch} and the report; stops double-reporting. */
  private armed = false;

  constructor(options: TelemetryClientOptions = {}) {
    this.sessionHash = options.sessionHash ?? randomSessionHash();
    this.baseUrl = options.baseUrl ?? httpServerUrl();
    this.enabled = options.enabled ?? telemetryEnabledByEnv();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Start (or restart) the per-match FPS accumulator. */
  beginMatch(): void {
    this.frames = 0;
    this.elapsedMs = 0;
    this.armed = true;
  }

  /** One rendered frame. Stalls are dropped rather than counted as slow frames. */
  sampleFrame(dtMs: number): void {
    if (!this.armed) return;
    if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > MAX_FRAME_MS) return;
    this.frames++;
    this.elapsedMs += dtMs;
  }

  /** Average FPS across the match so far, or null when nothing was sampled. */
  averageFps(): number | null {
    if (this.frames === 0 || this.elapsedMs <= 0) return null;
    return (this.frames * 1000) / this.elapsedMs;
  }

  /**
   * Report the finished match. Idempotent per match — a second call before the
   * next {@link beginMatch} does nothing, so it is safe to hook from both the
   * `matchEnded` event and a state-derived fallback.
   *
   * Fire-and-forget: the promise resolves even when the request failed, because
   * a telemetry failure must never surface to a player looking at their results
   * screen. `keepalive` lets the request outlive a tab closed on that screen.
   */
  async endMatch(input: { qualityTier: QualityTier; deviceProbe: { mobile: boolean } }): Promise<void> {
    if (!this.armed) return;
    this.armed = false;

    const fps = this.averageFps();
    // No frames sampled means the match never rendered (a join that failed, a
    // tab hidden throughout). Reporting it would put a phantom session in the
    // slowest bucket; see bucketFps's contract.
    if (fps === null) return;

    const deviceClass: DeviceClass = deviceClassOf(input.deviceProbe);
    const body: ClientMetricBody = {
      sessionHash: this.sessionHash,
      fpsBucket: bucketFps(fps),
      deviceClass,
      qualityTier: input.qualityTier,
    };

    if (!this.enabled) {
      log.info("match telemetry (dev — not sent; set VITE_SPACE_ARENA_TELEMETRY=1 to send)", {
        ...body,
        averageFps: Math.round(fps),
        frames: this.frames,
      });
      return;
    }

    try {
      await this.fetchImpl(`${this.baseUrl}/api/telemetry/client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      });
    } catch (err) {
      log.warn("telemetry post failed (ignored)", err);
    }
  }
}

/** 32 lowercase hex characters (128 bits) from the platform CSPRNG. */
function randomSessionHash(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Production always reports; a dev build only with `VITE_SPACE_ARENA_TELEMETRY=1`. */
function telemetryEnabledByEnv(): boolean {
  return import.meta.env.PROD || import.meta.env.VITE_SPACE_ARENA_TELEMETRY === "1";
}
