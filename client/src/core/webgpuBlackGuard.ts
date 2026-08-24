/**
 * Black-canvas guard (owner reports 2026-08-23: "3D models do not appear").
 *
 * A renderer can come up, render every frame without a single error — scene
 * graph, camera, lights and even `readPixels` all look healthy — and yet the
 * player sees nothing but black. WebGPU does it on some GPUs (the Settings
 * screen warns about exactly that); a broken driver or a lost context can do it
 * to WebGL too; and an opaque DOM backdrop painted over an unpositioned canvas
 * does it with a perfectly healthy renderer underneath. This module only
 * DETECTS the condition; what to do about it — fall back to WebGL2, drop the
 * quality tier, reset to known-good, or own up on screen — is the boot's
 * escalation policy in main.ts.
 *
 * CORRECTION (was wrong in the first version of this file, and the wrong claim
 * misdirected a whole day of investigation): `drawImage(canvas)` reads the
 * canvas DRAWING BUFFER, upstream of the compositor — exactly like `readPixels`
 * does, just through a different path. NOTHING that samples the canvas can see
 * an opaque element stacked on top of it. That failure has its own detector
 * here (`occlusion`), because it is the one the pixel probe structurally cannot
 * reach.
 *
 * The guiding rule for every path below: THE GUARD MUST NEVER ANSWER WITH
 * SILENCE. Every early return in the first version was a permanent, unlogged
 * stand-down, and the one threshold it did apply (`BLACK_LEVEL = 12`) sat below
 * the app's own clear colour's blue channel (13) — so a canvas showing nothing
 * but a bare clear, i.e. precisely what a black viewer looks like, was filed as
 * healthy on the first probe. Absolute darkness is the wrong predicate. The
 * right one is "this frame is indistinguishable from a bare clear", which is
 * what {@link classifyGrid} tests, against the clear colour read live at probe
 * time (MenuDiorama swaps it at runtime).
 */

/** Set once the boot's policy has already swapped webgpu→webgl automatically. */
export const AUTO_FALLBACK_KEY = "spacearena.rendererAutoFallback";
/** Set once the policy has already dropped the quality tier to safe. */
export const AUTO_SAFE_QUALITY_KEY = "spacearena.qualityAutoSafe";

/** Why the guard reached a verdict. The escalation policy routes on this. */
export type BlackKind =
  /** Frames present as a bare clear: a renderer/present-path failure. */
  | "present"
  /** The canvas is fine; an opaque, non-interactive element is stacked over it. */
  | "occluded"
  /** The render loop is not ticking at all. */
  | "stalled"
  /** The canvas cannot be sampled (zero-sized backing store, tainted, gone). */
  | "unsamplable"
  /** Meshes are loaded but none reach the render list: a scene-graph failure. */
  | "no-active-meshes";

export type BlackReporter = (reason: string, kind: BlackKind) => void;

/** Linear 0..1 colour, the shape Babylon's `Color4`/`Color3` already have. */
export interface GuardRgb {
  r: number;
  g: number;
  b: number;
}

interface GuardScene {
  getActiveMeshes(): { length: number };
  /** Total scene graph size; separates "still loading" from "nothing reached the render list". */
  meshes?: { length: number };
  /** Read at PROBE time, never at arm time — the diorama swaps it mid-visit. */
  clearColor?: GuardRgb;
  onAfterRenderObservable: {
    add(cb: () => void): unknown;
    remove(handle: unknown): void;
  };
}

/* ------------------------------------------------------------------ timing */

/** Wall clock, not frames. 45 + 3×30 frames is ~2.3 s at 60 fps but over two
 *  MINUTES at 1 fps — and a broken present path usually also runs slow. */
const WARMUP_MS = 1_500;
const PROBE_INTERVAL_MS = 500;
/** Probes that must ALL read black, spaced apart, before the guard acts. */
const PROBE_COUNT = 4;
/** Clean probes in a row before the guard stands down (one is not proof). */
const CLEAN_PROBES_TO_DISARM = 3;
/** Consecutive unsamplable probes before an unsamplable canvas IS the verdict. */
const NULL_PROBES_TO_REPORT = 10;
/** Probes with a populated scene but an empty render list before reporting. */
const EMPTY_RENDER_LIST_PROBES = 8;

/* ---------------------------------------------------------------- sampling */

/** Sample grid per probe. 8×8 was small enough that one lit HUD pixel vetoed
 *  the verdict for the whole visit; a measured-healthy hangar stage is only
 *  ~52% non-black, so the grid has to be able to out-vote a stray sample. */
export const SAMPLE_GRID = 32;
/** The unsmoothed pass is drawn at 2× and reduced by MAX, so a bright pixel
 *  INFORMS the verdict instead of being averaged into the background. */
const MAX_PASS_GRID = SAMPLE_GRID * 2;

/** Per-channel spread across the grid that still counts as "flat". */
const FLATNESS_TOLERANCE = 4;
/** Per-channel distance from the live clear colour that still counts as "bare". */
const CLEAR_TOLERANCE = 6;
/** At or below this on every channel is true zero — the WebGPU present failure,
 *  which does not match a non-zero clear colour and needs its own arm. */
const TRUE_BLACK_LEVEL = 4;

export interface GridVerdict {
  black: boolean;
  /** Brightest channel value seen, for the stand-down log and the banner text. */
  brightest: number;
  detail: "true-black" | "bare-clear" | "content" | "flat-but-not-clear";
}

/**
 * Classify one sampled grid. Pure, and exported for exactly that reason: the
 * first version of this file shipped an inert threshold because every test case
 * injected `probeOverride` and the real predicate had zero coverage.
 */
export function classifyGrid(px: ArrayLike<number>, clear: GuardRgb): GridVerdict {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = px[i + c] ?? 0;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }
  const brightest = Math.max(max[0]!, max[1]!, max[2]!);
  const flat = [0, 1, 2].every((c) => max[c]! - min[c]! <= FLATNESS_TOLERANCE);
  if (!flat) return { black: false, brightest, detail: "content" };

  if ([0, 1, 2].every((c) => max[c]! <= TRUE_BLACK_LEVEL)) {
    return { black: true, brightest, detail: "true-black" };
  }
  const target = [clear.r, clear.g, clear.b].map((v) => Math.round(v * 255));
  const bare = [0, 1, 2].every(
    (c) => Math.abs(max[c]! - target[c]!) <= CLEAR_TOLERANCE && Math.abs(min[c]! - target[c]!) <= CLEAR_TOLERANCE,
  );
  return bare
    ? { black: true, brightest, detail: "bare-clear" }
    : { black: false, brightest, detail: "flat-but-not-clear" };
}

/* --------------------------------------------------------------- occlusion */

export interface OcclusionReport {
  /** Every probed point is covered by an opaque element that is not the canvas. */
  covered: boolean;
  /** The offender to name in the banner, or "" when the canvas is on top. */
  by: string;
  /** Topmost element at the canvas centre, for the diagnostic strip. */
  hit: string;
}

/** Fully-opaque background test; `transparent` and any alpha < 1 pass through. */
function isOpaqueBackground(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;
  if (!bg || bg === "transparent") return false;
  const m = /^rgba?\(([^)]+)\)$/.exec(bg);
  if (!m) return true; // a named/hex colour that reached computed style is opaque
  const parts = m[1]!.split(",").map((p) => Number.parseFloat(p));
  return parts.length < 4 || (parts[3] ?? 1) >= 1;
}

/**
 * The channel `drawImage` structurally cannot see: is anything painted OVER the
 * canvas? Only DECORATIVE cover counts — an opaque element that is also
 * `pointer-events:none` is a backdrop nobody can interact with, and one of those
 * sitting on the 3D window is never intentional. A settings modal or a shop
 * panel is interactive, so it is (correctly) ignored: covering the canvas is
 * exactly its job.
 */
export function probeOcclusion(canvas: HTMLCanvasElement): OcclusionReport {
  const empty: OcclusionReport = { covered: false, by: "", hit: "" };
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return empty;
  const r = canvas.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return empty;

  const fractions: Array<[number, number]> = [
    [0.5, 0.5],
    [0.28, 0.4],
    [0.72, 0.4],
    [0.28, 0.72],
    [0.72, 0.72],
  ];
  let hit = "";
  let by = "";
  for (const [fx, fy] of fractions) {
    const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    const label = el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/)[0]}` : ""}` : "none";
    if (!hit) hit = label;
    if (!el || el === canvas) return { covered: false, by: "", hit };
    const style = getComputedStyle(el);
    // Interactive cover is a screen doing its job; only inert cover is a bug.
    if (style.pointerEvents !== "none" || !isOpaqueBackground(style)) return { covered: false, by: "", hit };
    if (!by) by = `${label} bg=${style.backgroundColor}`;
  }
  return { covered: true, by, hit };
}

/* ------------------------------------------------------------------- guard */

export interface GuardOptions {
  /** Tests: jsdom has no 2D raster to sample, so they hand in the verdicts. */
  probeOverride?: () => boolean | null;
  /** Tests: injectable wall clock, so nothing here sleeps for real. */
  now?: () => number;
  /** Tests: run the verdict inline instead of deferring it off the render loop. */
  defer?: (cb: () => void) => void;
}

export interface BlackCanvasGuard {
  /** Detach every observer and timer. */
  disarm: () => void;
  /**
   * Start a fresh window. Screen transitions swap the scene's clear colour and
   * its whole content, so a healthy menu must never vouch for a black hangar.
   */
  rearm: () => void;
  /** One-line state for the diagnostic strip. */
  status: () => string;
}

const DEFAULT_CLEAR: GuardRgb = { r: 0, g: 0, b: 0 };

/**
 * Arm the pixel/occlusion guard. Call once the render loop is running. `onBlack`
 * fires at most once per armed window, always with a reason AND a kind, and
 * always outside `scene.render()` so the render-loop catch cannot eat it.
 */
export function armBlackCanvasGuard(
  scene: GuardScene,
  canvas: HTMLCanvasElement,
  onBlack: BlackReporter,
  // Back-compat: the fourth positional argument stayed a bare probe override.
  options: GuardOptions | (() => boolean | null) = {},
): BlackCanvasGuard {
  const opts: GuardOptions = typeof options === "function" ? { probeOverride: options } : options;
  const now = opts.now ?? (() => Date.now());
  const defer = opts.defer ?? ((cb: () => void) => queueMicrotask(cb));

  let armedAt = now();
  let lastProbeAt = 0;
  let blackProbes = 0;
  let cleanProbes = 0;
  let nullProbes = 0;
  let emptyRenderList = 0;
  let fired = false;
  let standing = true;
  let state = "armed";
  let brightestSeen = 0;
  let sampler: CanvasRenderingContext2D | null = null;
  let maxSampler: CanvasRenderingContext2D | null = null;

  const scratch = (size: number, smoothing: boolean): CanvasRenderingContext2D | null => {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (ctx) ctx.imageSmoothingEnabled = smoothing;
    return ctx;
  };

  /** Reduce the 2× unsmoothed pass to the sample grid by MAX, not by mean. */
  const reduceByMax = (src: Uint8ClampedArray): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(SAMPLE_GRID * SAMPLE_GRID * 4);
    for (let y = 0; y < SAMPLE_GRID; y++) {
      for (let x = 0; x < SAMPLE_GRID; x++) {
        const o = (y * SAMPLE_GRID + x) * 4;
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const i = ((y * 2 + dy) * MAX_PASS_GRID + (x * 2 + dx)) * 4 + c;
              const s = src[i] ?? 0;
              if (s > v) v = s;
            }
          }
          out[o + c] = v;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  };

  let lastNullError = "";

  const realProbe = (): boolean | null => {
    // Guard the SOURCE before drawImage: a 0×0 backing store throws
    // InvalidStateError, and the first version filed that as "unjudgeable" and
    // walked away — from what is itself one of the likeliest causes of black.
    if (!canvas.width || !canvas.height) {
      lastNullError = "zero-sized backing store";
      return null;
    }
    try {
      sampler ??= scratch(SAMPLE_GRID, true);
      maxSampler ??= scratch(MAX_PASS_GRID, false);
      if (!sampler || !maxSampler) {
        lastNullError = "no 2d sampler context";
        return null;
      }
      sampler.drawImage(canvas, 0, 0, SAMPLE_GRID, SAMPLE_GRID);
      maxSampler.drawImage(canvas, 0, 0, MAX_PASS_GRID, MAX_PASS_GRID);
      const clear = scene.clearColor ?? DEFAULT_CLEAR;
      const mean = classifyGrid(sampler.getImageData(0, 0, SAMPLE_GRID, SAMPLE_GRID).data, clear);
      const peak = classifyGrid(
        reduceByMax(maxSampler.getImageData(0, 0, MAX_PASS_GRID, MAX_PASS_GRID).data),
        clear,
      );
      brightestSeen = Math.max(mean.brightest, peak.brightest);
      lastNullError = "";
      // Both passes must agree the frame has content before it counts as drawn.
      return mean.black || peak.black;
    } catch (err) {
      lastNullError = err instanceof Error ? err.message : String(err);
      return null;
    }
  };

  const probe = opts.probeOverride ?? realProbe;

  let observer: (() => void) | null = null;
  let handle: unknown = null;
  const detach = (): void => {
    if (handle !== null) scene.onAfterRenderObservable.remove(handle);
    handle = null;
  };

  const report = (reason: string, kind: BlackKind): void => {
    if (fired) return;
    fired = true;
    standing = false;
    state = `fired:${kind}`;
    detach();
    // Outside scene.render(), so an exception in the escalation policy is not
    // swallowed by the render loop's frame catch.
    defer(() => onBlack(reason, kind));
  };

  const runProbe = (): void => {
    const active = scene.getActiveMeshes().length;
    const total = scene.meshes?.length ?? active;

    // Nothing in the scene at all: still loading, black is the right picture.
    if (total === 0) {
      blackProbes = 0;
      emptyRenderList = 0;
      return;
    }
    // Meshes exist but none reach the render list. That is an asset/scene-graph
    // failure ONLY when the canvas is what the player is looking at: a DOM
    // screen over the canvas empties the render list BY DESIGN (the shop hides
    // the diorama while it is up — playtest 2026-08-24 caught the banner
    // painted over the shop header for exactly this). If anything but the
    // canvas is on top, the empty list is a screen doing its job.
    if (active === 0) {
      const cover = probeOcclusion(canvas);
      if (cover.hit !== "" && cover.hit !== "canvas") {
        emptyRenderList = 0;
        blackProbes = 0;
        return;
      }
      emptyRenderList += 1;
      blackProbes = 0;
      if (emptyRenderList >= EMPTY_RENDER_LIST_PROBES) {
        report(
          `${total} meshes loaded but 0 active for ${emptyRenderList} probes with the canvas on top`,
          "no-active-meshes",
        );
      }
      return;
    }
    emptyRenderList = 0;

    // The channel a pixel probe cannot reach. Checked first: when an opaque
    // backdrop is stacked on the canvas the pixels below it are irrelevant.
    const occ = probeOcclusion(canvas);
    if (occ.covered) {
      report(`canvas fully covered by inert opaque element ${occ.by}`, "occluded");
      return;
    }

    const black = probe();
    if (black === null) {
      nullProbes += 1;
      blackProbes = 0;
      cleanProbes = 0;
      state = `null×${nullProbes}`;
      // Never silent, and never a stand-down: an unsamplable canvas is the bug.
      console.warn(
        `[BlackGuard] canvas unsamplable (${nullProbes}/${NULL_PROBES_TO_REPORT}) ` +
          `backing=${canvas.width}x${canvas.height} client=${canvas.clientWidth}x${canvas.clientHeight} ` +
          `err=${lastNullError}`,
      );
      if (nullProbes >= NULL_PROBES_TO_REPORT) {
        report(
          `canvas unsamplable ${nullProbes}× backing=${canvas.width}x${canvas.height} ` +
            `client=${canvas.clientWidth}x${canvas.clientHeight} err=${lastNullError}`,
          "unsamplable",
        );
      }
      return;
    }
    nullProbes = 0;

    if (!black) {
      blackProbes = 0;
      cleanProbes += 1;
      if (cleanProbes >= CLEAN_PROBES_TO_DISARM) {
        standing = false;
        state = "disarmed:healthy";
        detach();
        console.info(
          `[BlackGuard] stood down after ${cleanProbes} clean probes (brightest sample ${brightestSeen})`,
        );
      }
      return;
    }
    cleanProbes = 0;
    blackProbes += 1;
    if (blackProbes < PROBE_COUNT) return;
    report(
      `presented ${PROBE_COUNT} consecutive bare-clear probes with ${active} meshes on stage ` +
        `(brightest sample ${brightestSeen})`,
      "present",
    );
  };

  observer = () => {
    if (!standing) return;
    const t = now();
    if (t - armedAt < WARMUP_MS) return;
    if (lastProbeAt !== 0 && t - lastProbeAt < PROBE_INTERVAL_MS) return;
    lastProbeAt = t;
    runProbe();
  };
  handle = scene.onAfterRenderObservable.add(observer);

  return {
    disarm: () => {
      standing = false;
      state = "disarmed:manual";
      detach();
    },
    rearm: () => {
      if (fired) return;
      armedAt = now();
      lastProbeAt = 0;
      blackProbes = cleanProbes = nullProbes = emptyRenderList = 0;
      brightestSeen = 0;
      if (handle === null && observer) handle = scene.onAfterRenderObservable.add(observer);
      standing = true;
      state = "armed";
    },
    status: () => state,
  };
}

/* --------------------------------------------------------------- heartbeat */

interface HeartbeatScene {
  onAfterRenderObservable: {
    add(cb: () => void): unknown;
    remove(handle: unknown): void;
  };
}

export interface HeartbeatOptions {
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** ms with zero frames after the scene attaches before "the loop never started". */
  startTimeoutMs?: number;
  /** ms with a frozen counter, after frames HAD been arriving, before "stopped". */
  stallTimeoutMs?: number;
  /**
   * ms from arming before "the bootstrap never reached the render loop". Long,
   * because boot legitimately waits on the network probe and on a fullscreen
   * prompt the player has to dismiss — but not infinite, because a bootstrap
   * that hangs there is exactly the silent failure this exists to name.
   */
  bootTimeoutMs?: number;
  /**
   * Is the page currently being composited? A hidden or background tab stops
   * `requestAnimationFrame` outright, so "no frames for 3 s" is the NORMAL
   * state there and reporting it would be a guaranteed false positive on every
   * tab switch. Defaults to the real `document.visibilityState`.
   */
  visible?: () => boolean;
}

export interface RenderHeartbeat {
  disarm: () => void;
  frames: () => number;
  /** Late binding: the scene does not exist yet when this is armed at boot. */
  attach: (scene: HeartbeatScene) => void;
  /**
   * Call at the moment `engine.runRenderLoop` is REGISTERED. Only from here on
   * is "0 frames" a failure on the short window: the scene attaches seconds
   * before the loop starts (the boot awaits a network probe and a fullscreen
   * dialog in between), and measuring from attach fired a false "render loop
   * never ticked" error on essentially every launch (playtest 2026-08-24,
   * 26 of 27 boots).
   */
  loopStarted: () => void;
}

/**
 * The case with NO detection at all before today. The pixel guard's only clock
 * was `onAfterRenderObservable`, so if `scene.render()` never ran the guard
 * could not tick, could not time out, and could not report — a lost context, a
 * throwing `renderFrame`, a loop that never started and a bootstrap that hung
 * all produced the same perfect silence.
 *
 * Armed straight after engine creation (main.ts), long before the scene exists,
 * because ~1,400 lines of awaited boot work — a network probe, a dismissable
 * fullscreen prompt, diorama warm-up — sit between the engine and the first
 * line of self-diagnosis today, and nothing failing in that window can report.
 */
export function armRenderHeartbeat(onBlack: BlackReporter, options: HeartbeatOptions = {}): RenderHeartbeat {
  const now = options.now ?? (() => Date.now());
  const setIv = options.setInterval ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms));
  const clearIv = options.clearInterval ?? ((h: unknown) => globalThis.clearInterval(h as number));
  const startTimeoutMs = options.startTimeoutMs ?? 3_000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 3_000;
  const bootTimeoutMs = options.bootTimeoutMs ?? 45_000;
  const visible =
    options.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");

  const armedAt = now();
  let loopStartedAt: number | null = null;
  let frames = 0;
  let lastFrameAt = 0;
  let lastSeen = 0;
  let lastSeenAt = armedAt;
  let fired = false;
  let scene: HeartbeatScene | null = null;
  let sceneHandle: unknown = null;
  /** Wall time the page spent uncomposited; never charged against the boot. */
  let blindMs = 0;
  // Seeded at arm time, not at the first interval tick: a tab that was ALREADY
  // in the background when the engine came up must be credited from the start.
  let hiddenSince: number | null = visible() ? null : armedAt;

  const tick = (): void => {
    frames += 1;
    lastFrameAt = now();
  };

  const stop = (): void => {
    clearIv(timer);
    if (scene && sceneHandle !== null) scene.onAfterRenderObservable.remove(sceneHandle);
  };

  const check = (): void => {
    if (fired) return;
    if (!visible()) {
      // Not being composited: no frames is correct, and the clock must not run
      // against the page while it is away or every tab switch fires the guard.
      // The boot window is credited the hidden time too — a tab opened in the
      // background has not failed to boot, it has not been asked to.
      const t = now();
      if (hiddenSince === null) hiddenSince = t;
      lastSeenAt = t;
      lastSeen = frames;
      return;
    }
    if (hiddenSince !== null) {
      blindMs += now() - hiddenSince;
      hiddenSince = null;
    }
    const t = now();
    if (frames === 0) {
      // Until the loop is REGISTERED there is nothing that should be ticking —
      // the boot legitimately spends seconds on the health probe and on a
      // dialog the player has to answer. Only a bootstrap that never gets to
      // `runRenderLoop` at all is a failure there, and it gets the long window.
      const since = (loopStartedAt === null ? t - armedAt : t - loopStartedAt) - blindMs;
      const limit = loopStartedAt === null ? bootTimeoutMs : startTimeoutMs;
      if (since >= limit) {
        fired = true;
        stop();
        onBlack(
          loopStartedAt === null
            ? `bootstrap never reached the render loop after ${Math.round(since / 1000)}s`
            : `render loop registered but never ticked — 0 frames in ${Math.round(since / 100) / 10}s`,
          "stalled",
        );
      }
      return;
    }
    if (frames !== lastSeen) {
      lastSeen = frames;
      lastSeenAt = t;
      return;
    }
    if (t - lastSeenAt >= stallTimeoutMs) {
      fired = true;
      stop();
      onBlack(
        `frames stopped after ${frames} (last frame ${Math.round((t - lastFrameAt) / 100) / 10}s ago)`,
        "stalled",
      );
    }
  };

  const timer = setIv(check, 500);

  return {
    disarm: stop,
    frames: () => frames,
    attach: (s: HeartbeatScene) => {
      if (scene && sceneHandle !== null) scene.onAfterRenderObservable.remove(sceneHandle);
      scene = s;
      sceneHandle = s.onAfterRenderObservable.add(tick);
      lastSeenAt = now();
    },
    loopStarted: () => {
      // The short window starts HERE, not at attach: a loop must tick within
      // seconds of being registered, or it never will.
      loopStartedAt = now();
      lastSeenAt = loopStartedAt;
      // The pre-loop wait must not be charged against the short window — and
      // neither may blind time banked during the boot be CREDITED to it, or
      // `since` goes negative and silently disables the start timeout for as
      // long as the tab was away.
      blindMs = 0;
      if (hiddenSince !== null) hiddenSince = loopStartedAt;
    },
  };
}
