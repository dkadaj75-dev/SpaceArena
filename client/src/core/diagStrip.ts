/**
 * One-line permanent diagnostic strip (owner reports 2026-08-23, "everything is
 * black"). Its whole purpose is to make a screenshot a complete bug report.
 *
 * The black-canvas investigation cost a day because "still black" carries no
 * information: it is equally consistent with a stalled render loop, a zero-sized
 * backing store, a software rasterizer, a stale service worker, and an opaque
 * DOM element painted over a perfectly healthy canvas (which is what it turned
 * out to be). Every one of those is a different number, and every one of those
 * numbers is cheap to read. "Still black AND frame 0" and "still black AT frame
 * 4,812" are different bugs; the strip is what tells them apart.
 *
 * The `hit=` field is the load-bearing one. Sampling the canvas — `readPixels`,
 * `drawImage`, anything — reads the DRAWING BUFFER, upstream of the compositor,
 * so no pixel probe can see something stacked on top. `elementFromPoint` is the
 * only channel that can, and its absence is exactly what let an opaque
 * `.hangar-stage` backdrop hide behind "the pixels look fine".
 *
 * Cheap by construction: a 2 Hz `setInterval` writing one `textContent`, never
 * anything per frame, and `pointer-events:none` so it can never eat an input.
 */

import { createLogger } from "@space-arena/shared";

const log = createLogger("Diag");

/** Opt-in key for production builds; `?diag=1` sets it and then behaves the same. */
export const DIAG_STORAGE_KEY = "sa.diag";

export interface DiagEngine {
  getClassName(): string;
  getRenderWidth(): number;
  getRenderHeight(): number;
  getHardwareScalingLevel(): number;
  getFps(): number;
  webGLVersion?: number;
}

export interface DiagSources {
  engine: DiagEngine;
  canvas: HTMLCanvasElement;
  /** What the boot ASKED for vs what it actually got. */
  requestedRenderer: string;
  actualRenderer: string;
  /** `UNMASKED_RENDERER_WEBGL`, or null when the extension is unavailable. */
  gpu: string | null;
  /** Frames counted by the heartbeat — the number that splits the hypotheses. */
  frames: () => number;
  /** Live scene counters; null until the scene exists. */
  scene: () => { meshes: number; active: number } | null;
  /** The guard's own state string (`armed`, `fired:occluded`, `null×3`, …). */
  guard: () => string;
  /** Extra fields the context audit contributes once it has run. */
  extra?: () => string;
}

export interface DiagStrip {
  dispose: () => void;
  /** Force a refresh, for tests and for the moment just before a banner. */
  refresh: () => void;
  /** Current line, so the escalation banner can quote it verbatim. */
  line: () => string;
}

declare const __BUILD_ID__: string;

/** The compile-time stamp, also parked on `window` for console spelunking. */
export function buildId(): string {
  try {
    return typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
  } catch {
    return "dev";
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode, blocked storage, quota — never fatal here
  }
}

/**
 * Dev builds always show the strip; production needs `sa.diag=1`, which
 * `?diag=1` sets so a URL is enough to talk a player through turning it on.
 */
export function diagEnabled(search = window.location.search): boolean {
  try {
    const flag = new URLSearchParams(search).get("diag");
    // Opt-IN only, dev included (owner 2026-08-23: the band reads as clutter
    // the moment the screen is healthy). `?diag=1` shows it and remembers;
    // `?diag=0` forgets. The escalation banner still quotes the same line on a
    // black verdict whether or not the strip is mounted, so a failure is never
    // silent just because the strip is off.
    if (flag === "1" || flag === "0") {
      try {
        if (flag === "1") localStorage.setItem(DIAG_STORAGE_KEY, "1");
        else localStorage.removeItem(DIAG_STORAGE_KEY);
      } catch {
        /* still honour the flag this visit even if it cannot be remembered */
      }
      return flag === "1";
    }
  } catch {
    /* malformed query string is not a reason to change diagnostics */
  }
  return readStorage(DIAG_STORAGE_KEY) === "1";
}

/** Top-left, above everything, inert. */
const STRIP_CSS =
  "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;" +
  "font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#7fe08f;" +
  "background:rgba(0,0,0,.72);padding:2px 6px;white-space:pre;max-width:100vw;" +
  "overflow:hidden;text-overflow:ellipsis;opacity:.85";

/** The element under the canvas centre — the occlusion channel, in one word. */
function hitAtCanvasCentre(canvas: HTMLCanvasElement): string {
  try {
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return "nolayout";
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!el) return "none";
    if (el === canvas) return "canvas";
    const cls = String(el.className || "").split(/\s+/)[0] ?? "";
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  } catch {
    return "err";
  }
}

/**
 * The whole diagnostic line, composed on demand. Standalone so the escalation
 * banner can quote a complete line even when the strip is not mounted — the
 * strip is opt-in cosmetics, the line is the bug report.
 */
export function composeDiagLine(sources: DiagSources): string {
  const { engine, canvas } = sources;
  const counts = sources.scene();
  const sw = navigator.serviceWorker?.controller?.scriptURL;
  const gl = engine.webGLVersion !== undefined ? `gl${engine.webGLVersion}` : "gl?";
  const gpu = (sources.gpu ?? "unknown").slice(0, 40);
  const settings = [
    `renderer=${readStorage("spacearena.renderer") ?? "-"}`,
    `q=${readStorage("sa.quality") ?? "-"}`,
    `af=${readStorage("spacearena.rendererAutoFallback") ? "1" : "0"}`,
    `qs=${readStorage("spacearena.qualityAutoSafe") ? "1" : "0"}`,
  ].join(" ");
  return [
    `BUILD ${buildId()}`,
    `${engine.getClassName()} ${gl} req=${sources.requestedRenderer} act=${sources.actualRenderer}`,
    gpu,
    `cvs ${canvas.width}x${canvas.height} (client ${canvas.clientWidth}x${canvas.clientHeight}) ` +
      `rt ${engine.getRenderWidth()}x${engine.getRenderHeight()} dpr ${window.devicePixelRatio || 1} ` +
      `hs ${engine.getHardwareScalingLevel().toFixed(2)}`,
    `f ${sources.frames()} fps ${Math.round(engine.getFps() || 0)}`,
    `mesh ${counts ? `${counts.meshes}/${counts.active}` : "-"}`,
    `hit=${hitAtCanvasCentre(canvas)}`,
    `guard ${sources.guard()}`,
    `sw ${sw ? sw.split("/").pop() : "none"}`,
    settings,
    sources.extra?.() ?? "",
  ]
    .filter((part) => part !== "")
    .join(" | ");
}

export function mountDiagStrip(sources: DiagSources): DiagStrip {
  const el = document.createElement("div");
  el.id = "sa-diag";
  el.style.cssText = STRIP_CSS;
  let current = "";

  const compose = (): string => composeDiagLine(sources);

  const refresh = (): void => {
    current = compose();
    el.textContent = current;
  };

  refresh();
  (document.body ?? document.documentElement).append(el);
  // 2 Hz, off the render loop entirely: the strip must never be a frame cost.
  const timer = window.setInterval(refresh, 500);
  log.info("diagnostic strip mounted", { build: buildId() });

  return {
    dispose: () => {
      window.clearInterval(timer);
      el.remove();
    },
    refresh,
    line: () => current,
  };
}
