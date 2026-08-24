import { describe, expect, it, vi } from "vitest";
import { auditContext, currentContextAudit, setContextAudit, watchContext } from "./contextAudit.js";

/** A GL context that answers only the parameters the audit asks about. */
function fakeGl(params: Record<number, number>) {
  return { getParameter: (p: number) => params[p] } as unknown as WebGLRenderingContext;
}

const HEALTHY_PARAMS = { 0x8dfd: 1024, 0x8dfc: 32, 0x8872: 16, 0x0d33: 16384 };

function fakeEngine(overrides: Record<string, unknown> = {}) {
  return {
    getClassName: () => "Engine",
    webGLVersion: 2,
    getCaps: () => ({ textureHalfFloatRender: true, maxTexturesImageUnits: 16, maxTextureSize: 16384 }),
    _gl: fakeGl(HEALTHY_PARAMS),
    ...overrides,
  };
}

describe("auditContext", () => {
  it("passes a healthy WebGL2 desktop context", () => {
    const audit = auditContext(fakeEngine(), "NVIDIA GeForce RTX 4070");
    expect(audit.degraded).toBe(false);
    expect(audit.reasons).toEqual([]);
    expect(audit.maxFragmentUniformVectors).toBe(1024);
    expect(audit.floatRenderTargets).toBe(true);
  });

  it("flags a software rasterizer", () => {
    // The tier probe's `desktopClassGpu` regex matches none of these, so a
    // SwiftShader box scored as a healthy desktop GPU and got the mid tier.
    const audit = auditContext(fakeEngine(), "Google SwiftShader");
    expect(audit.degraded).toBe(true);
    expect(audit.reasons).toContain("software rasterizer");
  });

  it("flags WebGL1", () => {
    const audit = auditContext(fakeEngine({ webGLVersion: 1 }), "Intel(R) UHD Graphics 620");
    expect(audit.degraded).toBe(true);
    expect(audit.reasons).toContain("webgl1");
  });

  it("flags a context too small for the mid-tier shader permutation", () => {
    const engine = fakeEngine({ _gl: fakeGl({ ...HEALTHY_PARAMS, 0x8dfd: 64 }) });
    const audit = auditContext(engine, "Some Mobile GPU");
    expect(audit.degraded).toBe(true);
    expect(audit.reasons).toContain("fragment uniform vectors 64");
  });

  it("does not call WebGPU degraded merely for reporting no webGLVersion", () => {
    const engine = fakeEngine({ getClassName: () => "WebGPUEngine", webGLVersion: undefined, _gl: undefined });
    expect(auditContext(engine, "Apple M2").degraded).toBe(false);
  });

  it("never throws on an engine that answers nothing", () => {
    const audit = auditContext({ getClassName: () => "Engine" }, null);
    expect(audit.maxFragmentUniformVectors).toBeNull();
    expect(audit.floatRenderTargets).toBe(false);
  });

  it("reports a healthy default before boot has published anything", () => {
    expect(currentContextAudit().degraded).toBe(false);
    setContextAudit(auditContext(fakeEngine(), "Google SwiftShader"));
    expect(currentContextAudit().degraded).toBe(true);
    setContextAudit(auditContext(fakeEngine(), "NVIDIA GeForce RTX 4070"));
  });
});

describe("watchContext", () => {
  function observable() {
    const cbs = new Set<(p: never) => void>();
    return {
      add: (cb: (p: never) => void) => (cbs.add(cb), cb),
      remove: (h: unknown) => cbs.delete(h as (p: never) => void),
      emit: (payload?: unknown) => {
        for (const cb of [...cbs]) cb(payload as never);
      },
    };
  }

  it("counts shader link failures — pixel-free proof of a degraded context", () => {
    const onEffectErrorObservable = observable();
    const watch = watchContext({ onEffectErrorObservable }, () => expect.unreachable());
    onEffectErrorObservable.emit({ effect: { name: "pbr" }, errors: "too many uniforms" });
    onEffectErrorObservable.emit({ effect: { name: "glow" }, errors: "link failed" });
    expect(watch.effectErrors()).toBe(2);
  });

  it("reports a context lost and never restored", () => {
    // Nothing in client/src subscribed to this before today: Babylon skips the
    // whole render callback while `_contextWasLost` is set, so the canvas holds
    // its last frame and the page looks entirely alive.
    const onContextLostObservable = observable();
    const onContextRestoredObservable = observable();
    let reason = "";
    const timers: Array<() => void> = [];
    const watch = watchContext(
      { onContextLostObservable, onContextRestoredObservable },
      (r) => (reason = r),
      {
        graceMs: 2_000,
        setTimeout: ((cb: () => void) => (timers.push(cb), timers.length)) as unknown as typeof setTimeout,
        clearTimeout: (() => timers.splice(0, timers.length)) as unknown as typeof clearTimeout,
      },
    );
    onContextLostObservable.emit();
    expect(watch.contextLost()).toBe(true);
    expect(reason).toBe(""); // still inside the grace window
    for (const t of timers) t();
    expect(reason).toContain("not restored");
  });

  it("stays quiet when the context comes back inside the grace window", () => {
    const onContextLostObservable = observable();
    const onContextRestoredObservable = observable();
    const timers: Array<() => void> = [];
    const watch = watchContext(
      { onContextLostObservable, onContextRestoredObservable },
      () => expect.unreachable(),
      {
        setTimeout: ((cb: () => void) => (timers.push(cb), timers.length)) as unknown as typeof setTimeout,
        clearTimeout: (() => timers.splice(0, timers.length)) as unknown as typeof clearTimeout,
      },
    );
    onContextLostObservable.emit();
    expect(watch.contextLost()).toBe(true);
    onContextRestoredObservable.emit();
    expect(watch.contextLost()).toBe(false);
    for (const t of timers) t();
  });

  it("detaches everything it attached", () => {
    const onEffectErrorObservable = observable();
    const remove = vi.spyOn(onEffectErrorObservable, "remove");
    watchContext({ onEffectErrorObservable }, () => undefined).dispose();
    expect(remove).toHaveBeenCalled();
  });
});
