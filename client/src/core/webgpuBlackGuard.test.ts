import { describe, expect, it, vi } from "vitest";
import {
  armBlackCanvasGuard,
  armRenderHeartbeat,
  classifyGrid,
  probeOcclusion,
  SAMPLE_GRID,
  type BlackKind,
} from "./webgpuBlackGuard.js";

/** A hand-cranked scene: `tick()` is one rendered frame. */
function fakeScene(activeMeshes = () => 5, totalMeshes = () => 5) {
  const observers = new Set<() => void>();
  return {
    getActiveMeshes: () => ({ length: activeMeshes() }),
    get meshes() {
      return { length: totalMeshes() };
    },
    clearColor: { r: 0.02, g: 0.03, b: 0.05 },
    onAfterRenderObservable: {
      add: (cb: () => void) => {
        observers.add(cb);
        return cb;
      },
      remove: (handle: unknown) => observers.delete(handle as () => void),
    },
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) for (const cb of [...observers]) cb();
    },
    observerCount: () => observers.size,
  };
}

/** jsdom canvases have no layout, so occlusion always reports "not covered". */
const canvas = {
  width: 800,
  height: 600,
  clientWidth: 800,
  clientHeight: 600,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
} as unknown as HTMLCanvasElement;

/**
 * A clock the test drives. The guard probes on WALL time now (1.5 s warm-up,
 * then every 500 ms), so a frame and a millisecond are separate axes.
 */
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Run `scene` far enough forward, in wall time, to collect `probes` probes. */
function runProbes(scene: ReturnType<typeof fakeScene>, clock: ReturnType<typeof fakeClock>, probes: number) {
  clock.advance(1_600); // past the warm-up
  for (let i = 0; i < probes; i++) {
    scene.tick();
    clock.advance(600); // past one probe interval
  }
  scene.tick();
}

/** Flatten one RGB triple across a whole SAMPLE_GRID×SAMPLE_GRID sample grid. */
function flatGrid(r: number, g: number, b: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SAMPLE_GRID * SAMPLE_GRID * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
}

const MAIN_CLEAR = { r: 0.02, g: 0.03, b: 0.05 }; // main.ts — renders as RGB(5,8,13)
const DIORAMA_CLEAR = { r: 0.004, g: 0.005, b: 0.012 }; // MenuDiorama — RGB(1,1,3)

describe("classifyGrid (the real predicate — untested when BLACK_LEVEL=12 shipped)", () => {
  it("calls the app's own clear colour BLACK", () => {
    // REGRESSION LOCK for B1. `main.ts` clears to Color4(0.02,0.03,0.05), i.e.
    // RGB(5,8,13). The first guard used an absolute BLACK_LEVEL of 12 and
    // returned "not black" the instant any channel exceeded it — so 13 > 12
    // made a bare-clear canvas, the exact look of a dead viewer, score healthy
    // on the very first probe, which then disarmed the guard for the visit.
    const v = classifyGrid(flatGrid(5, 8, 13), MAIN_CLEAR);
    expect(v.black).toBe(true);
    expect(v.detail).toBe("bare-clear");
    expect(v.brightest).toBe(13);
  });

  it("calls the diorama's much darker clear BLACK too, against its own colour", () => {
    expect(classifyGrid(flatGrid(1, 1, 3), DIORAMA_CLEAR).black).toBe(true);
  });

  it("does not call a flat frame in some OTHER colour a bare clear", () => {
    // Flat, but nowhere near this scene's clear and nowhere near zero: whatever
    // that is, it is not "the renderer drew nothing".
    const v = classifyGrid(flatGrid(30, 30, 30), MAIN_CLEAR);
    expect(v.black).toBe(false);
    expect(v.detail).toBe("flat-but-not-clear");
  });

  it("treats a near-zero frame as black even against a brighter clear colour", () => {
    // The diorama's clear read against main's: below TRUE_BLACK_LEVEL nothing
    // reached the canvas at all, whichever scene was supposed to be on screen.
    expect(classifyGrid(flatGrid(1, 1, 3), MAIN_CLEAR).detail).toBe("true-black");
  });

  it("calls a true-zero frame BLACK whatever the clear colour is", () => {
    // The WebGPU present failure: nothing reaches the canvas, not even the clear.
    expect(classifyGrid(flatGrid(0, 0, 0), MAIN_CLEAR).black).toBe(true);
    expect(classifyGrid(flatGrid(0, 0, 0), MAIN_CLEAR).detail).toBe("true-black");
  });

  it("calls a frame with actual content NOT black", () => {
    // The measured healthy hangar stage: mean ~27, max 240, ~72% non-black.
    const px = flatGrid(5, 8, 13);
    for (let i = 0; i < px.length; i += 4 * 3) {
      px[i] = 240;
      px[i + 1] = 200;
      px[i + 2] = 160;
    }
    const v = classifyGrid(px, MAIN_CLEAR);
    expect(v.black).toBe(false);
    expect(v.detail).toBe("content");
    expect(v.brightest).toBe(240);
  });

  it("is not fooled by a single stray lit sample being absent (flatness, not darkness)", () => {
    // Slightly noisy but still within the flatness tolerance of the clear.
    const px = flatGrid(5, 8, 13);
    px[0] = 7;
    px[1] = 10;
    px[2] = 15;
    expect(classifyGrid(px, MAIN_CLEAR).black).toBe(true);
  });
});

describe("black-canvas guard", () => {
  it("reports after a full window of black frames with content on stage, then disarms", () => {
    const scene = fakeScene();
    const clock = fakeClock();
    let reason = "";
    let kind: BlackKind | "" = "";
    let fired = 0;
    armBlackCanvasGuard(
      scene,
      canvas,
      (r, k) => {
        reason = r;
        kind = k;
        fired++;
      },
      { probeOverride: () => true, now: clock.now, defer: (cb) => cb() },
    );
    runProbes(scene, clock, 10);
    expect(fired).toBe(1);
    expect(kind).toBe("present");
    expect(reason).toContain("bare-clear probes");
    // fired means disarmed — the observer must not linger on the scene
    expect(scene.observerCount()).toBe(0);
  });

  it("needs several clean probes in a row before standing down, not one", () => {
    // ADAPTED from "stands down for good on the first non-black frame" (B4).
    // One clean probe is not proof: the menu, the hangar and a match are
    // different scenes with different clear colours, and a healthy menu must
    // never vouch for a black hangar.
    const scene = fakeScene();
    const clock = fakeClock();
    const verdicts = [false, true, true, true, true, true];
    armBlackCanvasGuard(scene, canvas, () => expect.unreachable(), {
      probeOverride: () => verdicts.shift() ?? true,
      now: clock.now,
      defer: (cb) => cb(),
    });
    runProbes(scene, clock, 3);
    // One clean probe went by and the guard is STILL watching.
    expect(scene.observerCount()).toBe(1);
  });

  it("stands down after three consecutive clean probes", () => {
    const scene = fakeScene();
    const clock = fakeClock();
    armBlackCanvasGuard(scene, canvas, () => expect.unreachable(), {
      probeOverride: () => false,
      now: clock.now,
      defer: (cb) => cb(),
    });
    runProbes(scene, clock, 4);
    expect(scene.observerCount()).toBe(0);
  });

  it("rearms after a screen transition so a healthy menu cannot vouch for the next scene", () => {
    const scene = fakeScene();
    const clock = fakeClock();
    let fired = 0;
    let black = false;
    const guard = armBlackCanvasGuard(scene, canvas, () => fired++, {
      probeOverride: () => black,
      now: clock.now,
      defer: (cb) => cb(),
    });
    runProbes(scene, clock, 4); // healthy menu → stood down
    expect(scene.observerCount()).toBe(0);
    black = true;
    guard.rearm();
    expect(scene.observerCount()).toBe(1);
    runProbes(scene, clock, 6);
    expect(fired).toBe(1);
  });

  it("never counts frames where the scene had nothing to show", () => {
    let meshes = 0;
    const scene = fakeScene(() => meshes, () => meshes);
    const clock = fakeClock();
    let fired = 0;
    armBlackCanvasGuard(scene, canvas, () => fired++, {
      probeOverride: () => true,
      now: clock.now,
      defer: (cb) => cb(),
    });
    runProbes(scene, clock, 12);
    expect(fired).toBe(0);
    // content arrives: the streak starts from zero, so one probe must not fire
    meshes = 5;
    runProbes(scene, clock, 1);
    expect(fired).toBe(0);
  });

  it("reports meshes-loaded-but-none-active as its own verdict instead of waiting forever", () => {
    // B3: an empty render list used to reset the streak with no timeout and no
    // log, so "nothing ever got on stage" — a leading cause of a black viewer —
    // was treated as correct behaviour for the whole visit.
    const scene = fakeScene(() => 0, () => 42);
    const clock = fakeClock();
    let reason = "";
    let kind: BlackKind | "" = "";
    armBlackCanvasGuard(
      scene,
      canvas,
      (r, k) => {
        reason = r;
        kind = k;
      },
      { probeOverride: () => true, now: clock.now, defer: (cb) => cb() },
    );
    runProbes(scene, clock, 12);
    expect(kind).toBe("no-active-meshes");
    expect(reason).toContain("42 meshes loaded but 0 active");
  });

  it("does NOT stand down when the canvas cannot be sampled", () => {
    // ADAPTED from "stands down when the canvas cannot be sampled rather than
    // guessing" (B2). A canvas the 2D context cannot source from is usually a
    // 0×0 backing store — itself one of the likeliest causes of a black screen.
    // Filing it as "unjudgeable" and walking away was the worst possible answer.
    const scene = fakeScene();
    const clock = fakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    armBlackCanvasGuard(scene, canvas, () => expect.unreachable(), {
      probeOverride: () => null,
      now: clock.now,
      defer: (cb) => cb(),
    });
    runProbes(scene, clock, 3);
    expect(scene.observerCount()).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports after ten consecutive unsamplable probes", () => {
    const scene = fakeScene();
    const clock = fakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reason = "";
    let kind: BlackKind | "" = "";
    armBlackCanvasGuard(
      scene,
      canvas,
      (r, k) => {
        reason = r;
        kind = k;
      },
      { probeOverride: () => null, now: clock.now, defer: (cb) => cb() },
    );
    runProbes(scene, clock, 12);
    expect(kind).toBe("unsamplable");
    expect(reason).toContain("backing=800x600");
    warn.mockRestore();
  });

  it("waits out the warm-up on the wall clock, not on a frame count", () => {
    // B: 45 + 3×30 frames is ~2.3 s at 60 fps but over two minutes at 1 fps,
    // and a broken present path usually also runs slow.
    const scene = fakeScene();
    const clock = fakeClock();
    let fired = 0;
    armBlackCanvasGuard(scene, canvas, () => fired++, {
      probeOverride: () => true,
      now: clock.now,
      defer: (cb) => cb(),
    });
    scene.tick(10_000); // ten thousand frames inside the warm-up window
    expect(fired).toBe(0);
    runProbes(scene, clock, 6); // four seconds of wall time
    expect(fired).toBe(1);
  });
});

describe("probeOcclusion (the channel drawImage structurally cannot see)", () => {
  it("reports nothing for a canvas with no layout", () => {
    expect(probeOcclusion(canvas).covered).toBe(false);
  });

  it("names an inert opaque element stacked over the canvas", () => {
    const el = document.createElement("div");
    el.className = "hangar-stage";
    const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
    const styleSpy = vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      pointerEvents: "none",
      backgroundColor: "rgb(5, 8, 15)",
    } as unknown as CSSStyleDeclaration);
    const laidOut = {
      width: 800,
      height: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement;
    const report = probeOcclusion(laidOut);
    expect(report.covered).toBe(true);
    expect(report.by).toContain("div.hangar-stage");
    spy.mockRestore();
    styleSpy.mockRestore();
  });

  it("ignores an INTERACTIVE overlay — covering the canvas is a modal's job", () => {
    const el = document.createElement("div");
    el.className = "settings-overlay";
    const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
    const styleSpy = vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      pointerEvents: "auto",
      backgroundColor: "rgb(10, 18, 32)",
    } as unknown as CSSStyleDeclaration);
    const laidOut = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement;
    expect(probeOcclusion(laidOut).covered).toBe(false);
    spy.mockRestore();
    styleSpy.mockRestore();
  });
});

describe("render heartbeat (the case with no detection at all before today)", () => {
  function fakeTimers() {
    const cbs: Array<() => void> = [];
    return {
      setInterval: (cb: () => void) => {
        cbs.push(cb);
        return cbs.length;
      },
      clearInterval: () => cbs.splice(0, cbs.length),
      fire: () => {
        for (const cb of [...cbs]) cb();
      },
    };
  }

  it("reports when the render loop never ticks after the scene attaches", () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    let reason = "";
    let kind: BlackKind | "" = "";
    const hb = armRenderHeartbeat(
      (r, k) => {
        reason = r;
        kind = k;
      },
      { now: clock.now, setInterval: timers.setInterval, clearInterval: timers.clearInterval },
    );
    hb.attach(fakeScene());
    hb.loopStarted(); // the loop is REGISTERED — and then never ticks
    clock.advance(3_500);
    timers.fire();
    expect(kind).toBe("stalled");
    expect(reason).toContain("registered but never ticked");
  });

  it("does not blame a scene that exists while the boot still holds the loop back", () => {
    // REGRESSION LOCK (playtest 2026-08-24, 26 of 27 boots): the scene attaches
    // seconds before `runRenderLoop` — the boot awaits a network probe and a
    // fullscreen dialog in between — and measuring the short window from attach
    // fired a false "render loop never ticked" error on essentially every launch.
    const clock = fakeClock();
    const timers = fakeTimers();
    let fired = 0;
    const hb = armRenderHeartbeat(() => fired++, {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    hb.attach(fakeScene());
    clock.advance(30_000); // half a minute of legitimate awaited boot work
    timers.fire();
    expect(fired).toBe(0);
    // The loop registers late and ticks promptly: still nothing to report.
    hb.loopStarted();
    const scene = fakeScene();
    hb.attach(scene);
    scene.tick(5);
    clock.advance(600);
    timers.fire();
    expect(fired).toBe(0);
  });

  it("reports when frames stop after having arrived", () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const scene = fakeScene();
    let reason = "";
    const hb = armRenderHeartbeat((r) => (reason = r), {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    hb.attach(scene);
    scene.tick(120);
    clock.advance(600);
    timers.fire();
    expect(reason).toBe("");
    expect(hb.frames()).toBe(120);
    // ...and now the loop dies.
    clock.advance(3_500);
    timers.fire();
    expect(reason).toContain("frames stopped after 120");
  });

  it("does not blame a boot that is legitimately still awaiting its scene", () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    let fired = 0;
    armRenderHeartbeat(() => fired++, {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    clock.advance(10_000); // network probe + a fullscreen prompt nobody tapped
    timers.fire();
    expect(fired).toBe(0);
  });

  it("eventually reports a bootstrap that never reaches the render loop at all", () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    let reason = "";
    armRenderHeartbeat((r) => (reason = r), {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      bootTimeoutMs: 20_000,
    });
    clock.advance(21_000);
    timers.fire();
    expect(reason).toContain("bootstrap never reached the render loop");
  });

  it("does not blame a tab that is not being composited", () => {
    // Found live: a hidden or background tab stops requestAnimationFrame
    // outright, so "no frames for 3 s" is the NORMAL state there. Without this
    // the heartbeat would fire on every tab switch.
    const clock = fakeClock();
    const timers = fakeTimers();
    const scene = fakeScene();
    let visible = true;
    let fired = 0;
    const hb = armRenderHeartbeat(() => fired++, {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      visible: () => visible,
    });
    hb.attach(scene);
    scene.tick(60);
    visible = false;
    clock.advance(60_000); // a minute in another tab
    timers.fire();
    expect(fired).toBe(0);
    // ...and it picks straight back up on return without a stale stall.
    visible = true;
    clock.advance(400);
    timers.fire();
    expect(fired).toBe(0);
    scene.tick(60);
    clock.advance(400);
    timers.fire();
    expect(fired).toBe(0);
  });

  it("credits hidden time against the boot window too", () => {
    // A tab opened in the background has not failed to boot; it has not been
    // asked to.
    const clock = fakeClock();
    const timers = fakeTimers();
    let visible = false;
    let fired = 0;
    armRenderHeartbeat(() => fired++, {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      visible: () => visible,
      bootTimeoutMs: 20_000,
    });
    clock.advance(120_000);
    timers.fire();
    visible = true;
    clock.advance(1_000);
    timers.fire();
    expect(fired).toBe(0);
  });

  it("keeps quiet while frames keep arriving", () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const scene = fakeScene();
    let fired = 0;
    const hb = armRenderHeartbeat(() => fired++, {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    hb.attach(scene);
    for (let i = 0; i < 20; i++) {
      scene.tick(30);
      clock.advance(500);
      timers.fire();
    }
    expect(fired).toBe(0);
    expect(hb.frames()).toBe(600);
  });
});
