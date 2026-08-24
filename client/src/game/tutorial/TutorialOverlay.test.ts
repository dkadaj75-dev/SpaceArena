// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TutorialOverlay, showTutorialToast } from "./TutorialOverlay.js";
import type { TutorialStepView } from "./TutorialDirector.js";

function view(patch: Partial<TutorialStepView> = {}): TutorialStepView {
  return {
    stepId: "throttle",
    index: 1,
    total: 11,
    instructor: "ARENA COMMAND",
    title: "THROTTLE",
    text: "Push the lever up.",
    hint: undefined,
    highlight: undefined,
    stage: "flight",
    confirmable: false,
    ...patch,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("TutorialOverlay", () => {
  it("stays hidden until a step is presented", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const root = document.querySelector<HTMLElement>("[data-tutorial]")!;
    expect(root.style.display).toBe("none");
    overlay.present(view());
    expect(root.style.display).not.toBe("none");
    overlay.dispose();
  });

  it("shows the instructor, the counter and the step's words", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view({ index: 3, total: 11, hint: "Hold W." }));
    expect(document.querySelector(".sa-tutorial-badge")?.textContent).toBe("ARENA COMMAND");
    expect(document.querySelector(".sa-tutorial-counter")?.textContent).toBe("Step 3 / 11");
    expect(document.querySelector(".sa-tutorial-title")?.textContent).toBe("THROTTLE");
    expect(document.querySelector(".sa-tutorial-text")?.textContent).toBe("Push the lever up.");
    expect(document.querySelector<HTMLElement>(".sa-tutorial-hint")?.textContent).toBe("Hold W.");
    overlay.dispose();
  });

  it("hides the hint line when the step has none", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view());
    expect(document.querySelector<HTMLElement>(".sa-tutorial-hint")!.style.display).toBe("none");
    overlay.dispose();
  });

  it("offers a confirm button only on a step the player is meant to click past", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const confirm = () => document.querySelector<HTMLElement>("[data-tutorial-confirm]")!;
    overlay.present(view());
    expect(confirm().style.display).toBe("none");
    overlay.present(view({ confirmable: true }));
    expect(confirm().style.display).not.toBe("none");
    overlay.dispose();
  });

  it("reports skip and confirm", () => {
    const onSkip = vi.fn();
    const onConfirm = vi.fn();
    const overlay = new TutorialOverlay(document.body, { onSkip, onConfirm });
    overlay.present(view({ confirmable: true }));
    document.querySelector<HTMLElement>("[data-tutorial-skip]")!.click();
    document.querySelector<HTMLElement>("[data-tutorial-confirm]")!.click();
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
    overlay.dispose();
  });

  it("stays out of the way: only its buttons take pointer events", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const css = document.getElementById("sa-tutorial-style")!.textContent!;
    expect(css).toMatch(/\.sa-tutorial\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.sa-tutorial-actions\s*>\s*\*\s*\{\s*pointer-events:\s*auto/);
    overlay.dispose();
  });

  it("rings the control a step points at, and nothing when it points at none", () => {
    const control = document.createElement("div");
    control.className = "hud-throttle-track";
    control.getBoundingClientRect = () => ({ left: 100, top: 50, width: 40, height: 200 }) as DOMRect;
    document.body.append(control);

    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const ring = () => document.querySelector<HTMLElement>(".sa-tutorial-ring")!;
    overlay.present(view({ highlight: "throttle" }));
    expect(ring().style.display).not.toBe("none");
    // Standing off the control by a pad, so it reads as a pointer not a border.
    expect(ring().style.left).toBe("90px");
    expect(ring().style.top).toBe("40px");
    expect(ring().style.width).toBe("60px");
    expect(ring().style.height).toBe("220px");

    overlay.present(view({ highlight: undefined }));
    expect(ring().style.display).toBe("none");
    overlay.dispose();
  });

  it("draws no ring when the named control is not on screen", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view({ highlight: "shop-buy" }));
    expect(document.querySelector<HTMLElement>(".sa-tutorial-ring")!.style.display).toBe("none");
    overlay.dispose();
  });

  it("rings the whole module cluster, not just its first hex", () => {
    // The instruction names the SHIELD; ringing only the first button would
    // point at the laser. `.hud-modules` itself is a zero-size pivot.
    const pivot = document.createElement("div");
    pivot.className = "hud-modules";
    pivot.getBoundingClientRect = () => ({ left: 1200, top: 700, width: 0, height: 0 }) as DOMRect;
    const laser = document.createElement("div");
    laser.className = "hud-module-btn family-laser";
    laser.getBoundingClientRect = () => ({ left: 1100, top: 600, width: 60, height: 60 }) as DOMRect;
    const shield = document.createElement("div");
    shield.className = "hud-module-btn family-shield";
    shield.getBoundingClientRect = () => ({ left: 1180, top: 640, width: 60, height: 60 }) as DOMRect;
    document.body.append(pivot, laser, shield);

    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view({ highlight: "modules" }));
    const ring = document.querySelector<HTMLElement>(".sa-tutorial-ring")!;
    expect(ring.style.display).not.toBe("none");
    expect(ring.style.left).toBe("1090px"); // 1100 - pad
    expect(ring.style.top).toBe("590px"); // 600 - pad
    expect(ring.style.width).toBe("160px"); // 1180+60 - 1100 + 2*pad
    expect(ring.style.height).toBe("120px"); // 640+60 - 600 + 2*pad
    overlay.dispose();
  });

  it("prefers the EMPTY hangar slot, which is the one the lesson is about", () => {
    const filled = document.createElement("button");
    filled.className = "hangar-slot filled";
    filled.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 50 }) as DOMRect;
    const empty = document.createElement("button");
    empty.className = "hangar-slot";
    empty.getBoundingClientRect = () => ({ left: 300, top: 0, width: 50, height: 50 }) as DOMRect;
    document.body.append(filled, empty);

    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view({ stage: "hangar", highlight: "hangar-slots" }));
    expect(document.querySelector<HTMLElement>(".sa-tutorial-ring")!.style.left).toBe("290px");
    overlay.dispose();
  });

  it("holds back a pointing hint until the control it points at exists", () => {
    // Finding 55: step 1 said "Drag the throttle on the right" during the
    // countdown, when the throttle strip is still a 0x0 box.
    vi.useFakeTimers();
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const hint = () => document.querySelector<HTMLElement>(".sa-tutorial-hint")!;
    overlay.present(view({ hint: "Drag the throttle on the right.", highlight: "throttle" }));
    expect(hint().style.display).toBe("none");
    // The words are already written — only their moment is being waited for.
    expect(hint().textContent).toBe("Drag the throttle on the right.");

    const control = document.createElement("div");
    control.className = "hud-throttle-track";
    control.getBoundingClientRect = () => ({ left: 100, top: 50, width: 40, height: 200 }) as DOMRect;
    document.body.append(control);
    // The poll that moves the ring is the same clock that raises the hint.
    vi.advanceTimersByTime(400);
    expect(hint().style.display).not.toBe("none");
    overlay.dispose();
  });

  it("shows a hint that points at nothing straight away — that is general advice", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view({ hint: "Watch your energy.", highlight: undefined }));
    expect(document.querySelector<HTMLElement>(".sa-tutorial-hint")!.style.display).not.toBe("none");
    overlay.dispose();
  });

  it("sits below the loading panel and the settings sheet, and above the shop", () => {
    // Findings 52/53: at z-index 45 the card was read THROUGH — "PREPARING
    // ARENA" and "Resume match" both ended up behind it.
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const css = document.getElementById("sa-tutorial-style")!.textContent!;
    const base = /\.sa-tutorial\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
    const shop = /\.sa-tutorial\[data-stage="shop"\]\s*\{\s*z-index:\s*(\d+)/.exec(css);
    // MatchLoadingScreen is 26, SettingsScreen 40, ShopScreen 30, the HUD 10.
    expect(Number(base![1])).toBeLessThan(26);
    expect(Number(base![1])).toBeGreaterThan(10);
    expect(Number(shop![1])).toBeGreaterThan(30);
    expect(Number(shop![1])).toBeLessThan(40);
    overlay.dispose();
  });

  it("anchors the card to a corner instead of the middle of the screen", () => {
    // Finding 54: 520x178 dead-centre in 915x412 — over the player's own ship.
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    const css = document.getElementById("sa-tutorial-style")!.textContent!;
    const card = /\.sa-tutorial-card\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(card).toMatch(/top:/);
    expect(card).not.toMatch(/left:\s*50%/);
    expect(card).not.toMatch(/translateX\(-50%\)/);
    overlay.dispose();
  });

  it("clears itself when presented nothing", () => {
    const overlay = new TutorialOverlay(document.body, { onSkip: vi.fn(), onConfirm: vi.fn() });
    overlay.present(view());
    overlay.present(null);
    expect(document.querySelector<HTMLElement>("[data-tutorial]")!.style.display).toBe("none");
    overlay.dispose();
  });
});

describe("showTutorialToast", () => {
  it("raises the sign-off and takes it away again", () => {
    vi.useFakeTimers();
    showTutorialToast("Flight school complete.", 1000);
    expect(document.querySelector("[data-tutorial-toast]")?.textContent).toBe("Flight school complete.");
    vi.advanceTimersByTime(1001);
    expect(document.querySelector("[data-tutorial-toast]")).toBeNull();
  });
});
