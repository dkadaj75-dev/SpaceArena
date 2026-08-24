/**
 * What kind of graphics context did we actually get?
 *
 * Nothing in this codebase asked, before today: `EngineFactory.CreateAsync` was
 * called with an empty options object and resolved happily on a software or
 * fallback adapter, `new Engine(canvas, aa)` was never validated, and the
 * device-tier probe's `desktopClassGpu` regex matches no software rasterizer —
 * so a SwiftShader/llvmpipe machine scored as a healthy desktop GPU and was
 * handed the mid tier, complete with four punctual lights at the
 * `maxSimultaneousLights` ceiling, PBR+IBL, an ESM shadow map needing a
 * float-renderable target, and a GlowLayer. That is the shader permutation most
 * likely to blow `MAX_FRAGMENT_UNIFORM_VECTORS` and fail to link — and Babylon's
 * response to a failed link is silent: `Effect.isReady()` stays false and the
 * draw is skipped, leaving a frame containing nothing but the clear colour.
 *
 * The deliverable is not a warning. It is CODE THAT DEGRADES INTO SOMETHING
 * THAT DRAWS: on a degraded context the boot forces the low tier (which drops
 * the GlowLayer), and the caller uses {@link ContextAudit} to skip the shadow
 * generator and clamp the light rig. Runtime construction flags only — no
 * authored content is touched.
 */

import { createLogger } from "@space-arena/shared";

const log = createLogger("Context");

export interface AuditEngine {
  getClassName(): string;
  webGLVersion?: number;
  getCaps?: () => {
    maxTexturesImageUnits?: number;
    maxTextureSize?: number;
    textureFloatRender?: boolean;
    textureHalfFloatRender?: boolean;
  };
  _gl?: WebGLRenderingContext;
}

export interface ContextAudit {
  className: string;
  webGLVersion: number;
  gpu: string | null;
  maxFragmentUniformVectors: number | null;
  maxVaryingVectors: number | null;
  maxTextureImageUnits: number | null;
  maxTextureSize: number | null;
  /** A float or half-float renderable target actually exists (shadow maps need one). */
  floatRenderTargets: boolean;
  /** True when this context cannot be trusted with the normal material rig. */
  degraded: boolean;
  /** Human-readable list of the reasons, for the log, the strip and the banner. */
  reasons: string[];
}

/** Renderer strings that mean "no GPU is involved". */
export const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|software|basic render|microsoft basic|generic renderer|softpipe|paravirtual/i;

/** Below this a mid-tier PBR permutation cannot be expected to link. */
const MIN_FRAGMENT_UNIFORM_VECTORS = 128;

function param(gl: WebGLRenderingContext | undefined, name: number): number | null {
  try {
    const v = gl?.getParameter(name);
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Audit the live engine. Never throws: a boot that cannot audit its context
 * still has to boot, and every field degrades to null rather than to an
 * exception.
 */
export function auditContext(engine: AuditEngine, gpu: string | null): ContextAudit {
  const gl = engine._gl;
  const caps = engine.getCaps?.();
  const webGLVersion = engine.webGLVersion ?? (engine.getClassName().includes("WebGPU") ? 2 : 1);

  // 0x8DFD MAX_FRAGMENT_UNIFORM_VECTORS, 0x8DFC MAX_VARYING_VECTORS.
  const maxFragmentUniformVectors = param(gl, 0x8dfd);
  const maxVaryingVectors = param(gl, 0x8dfc);
  const maxTextureImageUnits = caps?.maxTexturesImageUnits ?? param(gl, 0x8872);
  const maxTextureSize = caps?.maxTextureSize ?? param(gl, 0x0d33);
  const floatRenderTargets = Boolean(caps?.textureFloatRender || caps?.textureHalfFloatRender);

  const reasons: string[] = [];
  const isWebGPU = engine.getClassName().includes("WebGPU");
  if (!isWebGPU && webGLVersion < 2) reasons.push(`webgl${webGLVersion}`);
  if (gpu && SOFTWARE_RENDERER_RE.test(gpu)) reasons.push("software rasterizer");
  if (maxFragmentUniformVectors !== null && maxFragmentUniformVectors < MIN_FRAGMENT_UNIFORM_VECTORS) {
    reasons.push(`fragment uniform vectors ${maxFragmentUniformVectors}`);
  }

  const audit: ContextAudit = {
    className: engine.getClassName(),
    webGLVersion,
    gpu,
    maxFragmentUniformVectors,
    maxVaryingVectors,
    maxTextureImageUnits,
    maxTextureSize,
    floatRenderTargets,
    degraded: reasons.length > 0,
    reasons,
  };
  // Unconditional: on the one machine that matters this is the line that says
  // whether the GPU was ever a suspect.
  log[audit.degraded ? "warn" : "info"]("graphics context audit", audit);
  return audit;
}

/**
 * The live audit, published for the scene builders that have to react to it.
 *
 * A module-level accessor rather than a constructor argument threaded down from
 * boot, deliberately: the screens in between (`Hangar`) are mid-redesign and
 * off-limits, and "what kind of GPU is this" is genuinely process-global — there
 * is exactly one engine per page. Defaults to "not degraded" so nothing has to
 * null-check and so tests get the full rig unless they ask otherwise.
 */
let current: ContextAudit | null = null;

export function setContextAudit(audit: ContextAudit): void {
  current = audit;
}

export function currentContextAudit(): Pick<ContextAudit, "degraded" | "floatRenderTargets" | "reasons"> {
  return current ?? { degraded: false, floatRenderTargets: true, reasons: [] };
}

/**
 * Would a WebGPU adapter be a real GPU? `EngineFactory.CreateAsync` resolves
 * happily on a fallback adapter, so `actualRenderer` stayed "webgpu" on a
 * software device and the catch never fired. Refuse it and fall to WebGL2
 * instead, which at least has a driver behind it.
 */
export async function webgpuAdapterUsable(): Promise<{ usable: boolean; why: string }> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return { usable: false, why: "no navigator.gpu" };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { usable: false, why: "no adapter" };
    const fallback = (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
    if (fallback) return { usable: false, why: "fallback adapter" };
    const info = (adapter as GPUAdapter & { info?: { description?: string; vendor?: string } }).info;
    const description = `${info?.vendor ?? ""} ${info?.description ?? ""}`.trim();
    if (description && SOFTWARE_RENDERER_RE.test(description)) {
      return { usable: false, why: `software adapter (${description})` };
    }
    return { usable: true, why: description || "adapter ok" };
  } catch (error) {
    return { usable: false, why: `requestAdapter threw: ${String(error)}` };
  }
}

export interface ContextWatchers {
  /** Shader programs that failed to link — pixel-free proof of a degraded context. */
  effectErrors: () => number;
  /** True while the GL context is lost. */
  contextLost: () => boolean;
  dispose: () => void;
}

interface Observableish<T> {
  add(cb: (payload: T) => void): unknown;
  remove(h: unknown): void;
}

interface WatchableEngine {
  onContextLostObservable?: Observableish<unknown>;
  onContextRestoredObservable?: Observableish<unknown>;
  onEffectErrorObservable?: Observableish<{ effect?: { name?: unknown }; errors?: string }>;
}

/**
 * Subscribe to the failure signals nothing in `client/src` listened for: a lost
 * context (grep for `onContextLostObservable` returned zero hits before today)
 * and shader link failures. A lost context makes Babylon skip the entire render
 * callback while `_contextWasLost` is set — the canvas holds its last frame and
 * the page looks completely alive, which is exactly the reported symptom.
 */
export function watchContext(
  engine: WatchableEngine,
  onLostTooLong: (reason: string) => void,
  options: { graceMs?: number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } = {},
): ContextWatchers {
  const graceMs = options.graceMs ?? 2_000;
  const setT = options.setTimeout ?? globalThis.setTimeout;
  const clearT = options.clearTimeout ?? globalThis.clearTimeout;
  let effectErrors = 0;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // A nonzero count here is PIXEL-FREE proof that shaders are not linking, and
  // a skipped draw looks identical to a dead renderer from the outside.
  const errorHandle = engine.onEffectErrorObservable?.add((payload) => {
    effectErrors += 1;
    log.error("shader effect failed to compile/link — its draws are silently skipped", {
      effect: String(payload?.effect?.name ?? "?"),
      errors: payload?.errors,
      total: effectErrors,
    });
  });

  const lostHandle = engine.onContextLostObservable?.add(() => {
    lost = true;
    log.error("graphics context LOST — the render callback is skipped entirely while this holds");
    timer = setT(() => {
      if (lost) onLostTooLong(`graphics context lost and not restored within ${graceMs}ms`);
    }, graceMs);
  });
  const restoredHandle = engine.onContextRestoredObservable?.add(() => {
    lost = false;
    if (timer !== null) clearT(timer);
    timer = null;
    log.warn("graphics context restored");
  });

  return {
    effectErrors: () => effectErrors,
    contextLost: () => lost,
    dispose: () => {
      if (timer !== null) clearT(timer);
      if (errorHandle) engine.onEffectErrorObservable?.remove(errorHandle);
      if (lostHandle) engine.onContextLostObservable?.remove(lostHandle);
      if (restoredHandle) engine.onContextRestoredObservable?.remove(restoredHandle);
    },
  };
}
