// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { clearTutorialProgress, markTutorialCompleted, tutorialCompleted } from "./tutorialProgress.js";

afterEach(() => {
  clearTutorialProgress();
});

describe("tutorial progress", () => {
  it("starts unset and survives being marked", () => {
    expect(tutorialCompleted()).toBe(false);
    markTutorialCompleted();
    expect(tutorialCompleted()).toBe(true);
    expect(localStorage.getItem("sa.tutorial.completed")).toBe("1");
  });

  it("is idempotent", () => {
    markTutorialCompleted();
    markTutorialCompleted();
    expect(tutorialCompleted()).toBe(true);
  });

  it("clears", () => {
    markTutorialCompleted();
    clearTutorialProgress();
    expect(tutorialCompleted()).toBe(false);
  });

  it("treats a storage that throws as 'not done yet' rather than crashing the menu", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    expect(() => markTutorialCompleted()).not.toThrow();
    expect(tutorialCompleted()).toBe(false);
    if (original) Object.defineProperty(window, "localStorage", original);
  });
});
