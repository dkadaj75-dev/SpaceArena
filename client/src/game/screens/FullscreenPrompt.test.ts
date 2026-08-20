// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FullscreenPrompt, type FullscreenPromptDeps } from "./FullscreenPrompt.js";

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
