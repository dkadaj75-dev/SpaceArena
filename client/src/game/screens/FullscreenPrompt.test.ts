// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FullscreenPrompt, type FullscreenPromptDeps, type IosHintDeps } from "./FullscreenPrompt.js";

function makeDeps(overrides: Partial<FullscreenPromptDeps> = {}): FullscreenPromptDeps & {
  request: ReturnType<typeof vi.fn>;
  fireChange: () => void;
} {
  let changeHandler: () => void = () => {};
  const deps = {
    supported: () => true,
    active: () => false,
    request: vi.fn(),
    onChange: (handler: () => void) => {
      changeHandler = handler;
      return () => {
        changeHandler = () => {};
      };
    },
    ...overrides,
  };
  return { ...deps, fireChange: () => changeHandler() } as never;
}

describe("FullscreenPrompt", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows at launch when fullscreen is supported and not engaged", () => {
    const prompt = FullscreenPrompt.maybeShow(document.body, makeDeps());
    expect(prompt).not.toBeNull();
    expect(prompt!.visible).toBe(true);
    expect(document.querySelector(".sa-fullscreen-prompt")).not.toBeNull();
    prompt!.dismiss();
  });

  it("never shows when unsupported (iPhone Safari) or already fullscreen", () => {
    expect(FullscreenPrompt.maybeShow(document.body, makeDeps({ supported: () => false }))).toBeNull();
    expect(FullscreenPrompt.maybeShow(document.body, makeDeps({ active: () => true }))).toBeNull();
    expect(document.querySelector(".sa-fullscreen-prompt")).toBeNull();
  });

  it("GO FULLSCREEN requests fullscreen (the required user gesture) and closes", () => {
    const deps = makeDeps();
    const prompt = FullscreenPrompt.maybeShow(document.body, deps)!;
    (document.querySelector(".sa-fullscreen-prompt-go") as HTMLButtonElement).click();
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);
  });

  it("'Not now' closes without requesting", () => {
    const deps = makeDeps();
    const prompt = FullscreenPrompt.maybeShow(document.body, deps)!;
    (document.querySelector(".sa-fullscreen-prompt-skip") as HTMLButtonElement).click();
    expect(deps.request).not.toHaveBeenCalled();
    expect(prompt.visible).toBe(false);
  });

  it("auto-dismisses when fullscreen is entered some other way", () => {
    let active = false;
    const deps = makeDeps({ active: () => active });
    const prompt = FullscreenPrompt.maybeShow(document.body, deps)!;
    active = true;
    deps.fireChange();
    expect(prompt.visible).toBe(false);
  });
});

describe("iOS Add-to-Home-Screen hint", () => {
  function makeIos(overrides: Partial<IosHintDeps> = {}): IosHintDeps & { marked: ReturnType<typeof vi.fn> } {
    const marked = vi.fn();
    return {
      isIphone: () => true,
      installed: () => false,
      hintShown: () => false,
      markHintShown: marked,
      marked,
      ...overrides,
    };
  }
  const unsupported = () => makeDeps({ supported: () => false });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("stands in for the offer on an iPhone, where fullscreen is impossible", () => {
    const ios = makeIos();
    const prompt = FullscreenPrompt.maybeShow(document.body, unsupported(), ios);
    expect(prompt).not.toBeNull();
    const text = document.querySelector(".sa-fullscreen-prompt-text")!.textContent!;
    expect(text).toContain("Add to Home Screen");
    // The instruction points at the exact toolbar button: the share glyph.
    expect(document.querySelector(".sa-fullscreen-prompt-share svg")).not.toBeNull();
    prompt!.dismiss();
  });

  it("is one-time, marked at SHOW so a mid-dialog reload cannot re-nag", () => {
    const ios = makeIos();
    FullscreenPrompt.maybeShow(document.body, unsupported(), ios)!.dismiss();
    expect(ios.marked).toHaveBeenCalledTimes(1);
    expect(FullscreenPrompt.maybeShow(document.body, unsupported(), makeIos({ hintShown: () => true }))).toBeNull();
  });

  it("never shows off-iPhone, when already installed, or where fullscreen works", () => {
    expect(FullscreenPrompt.maybeShow(document.body, unsupported(), makeIos({ isIphone: () => false }))).toBeNull();
    expect(FullscreenPrompt.maybeShow(document.body, unsupported(), makeIos({ installed: () => true }))).toBeNull();
    // Supported browsers get the real offer, not the hint.
    const prompt = FullscreenPrompt.maybeShow(document.body, makeDeps(), makeIos())!;
    expect(document.querySelector(".sa-fullscreen-prompt-share")).toBeNull();
    prompt.dismiss();
  });

  it("'Got it' closes it and settles the launch sequence's promise", async () => {
    const prompt = FullscreenPrompt.maybeShow(document.body, unsupported(), makeIos())!;
    (document.querySelector(".sa-fullscreen-prompt-go") as HTMLButtonElement).click();
    expect(prompt.visible).toBe(false);
    await expect(prompt.closed).resolves.toBeUndefined();
  });
});

describe("FullscreenPrompt closed promise", () => {
  /**
   * The launch sequence waits on this before handing over to the menu, so a
   * promise that never settles would strand the player on the title screen.
   */
  it("resolves when the player accepts", async () => {
    const prompt = FullscreenPrompt.maybeShow(document.body, makeDeps())!;
    let settled = false;
    void prompt.closed.then(() => (settled = true));
    (document.querySelector(".sa-fullscreen-prompt-go") as HTMLButtonElement).click();
    await prompt.closed;
    expect(settled).toBe(true);
  });

  it("resolves when the player declines", async () => {
    const prompt = FullscreenPrompt.maybeShow(document.body, makeDeps())!;
    (document.querySelector(".sa-fullscreen-prompt-skip") as HTMLButtonElement).click();
    await expect(prompt.closed).resolves.toBeUndefined();
  });

  it("resolves when fullscreen is reached some other way", async () => {
    // F11, or the browser's own control: the question has been answered even
    // though nothing on the panel was clicked.
    let fire = () => {};
    let active = false;
    const prompt = FullscreenPrompt.maybeShow(
      document.body,
      makeDeps({ active: () => active, onChange: (h) => { fire = h; return () => {}; } }),
    )!;
    active = true;
    fire();
    await expect(prompt.closed).resolves.toBeUndefined();
  });
});
