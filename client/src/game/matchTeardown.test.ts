import { describe, expect, it } from "vitest";
import { runTeardown, type TeardownLogger } from "./matchTeardown.js";

function recordingLogger(): TeardownLogger & { messages: string[] } {
  const messages: string[] = [];
  return { messages, error: (...args: unknown[]) => messages.push(String(args[0])) };
}

describe("runTeardown", () => {
  it("runs every step in order", () => {
    const order: string[] = [];
    const failed = runTeardown(
      [
        { label: "session", run: () => order.push("session") },
        { label: "hud", run: () => order.push("hud") },
        { label: "views", run: () => order.push("views") },
      ],
      recordingLogger(),
    );
    expect(order).toEqual(["session", "hud", "views"]);
    expect(failed).toEqual([]);
  });

  /**
   * The bug this function exists for: one throwing step used to abandon the
   * rest of teardown, leaving the match ticking and its ships in the Scene.
   */
  it("keeps going after a throwing step and reports the failures", () => {
    const order: string[] = [];
    const logger = recordingLogger();
    const failed = runTeardown(
      [
        { label: "session", run: () => order.push("session") },
        {
          label: "views",
          run: () => {
            order.push("views");
            throw new Error("babylon exploded");
          },
        },
        { label: "viewRoots", run: () => order.push("viewRoots") },
      ],
      logger,
    );
    // The belt step after the failure still ran.
    expect(order).toEqual(["session", "views", "viewRoots"]);
    expect(failed).toEqual(["views"]);
    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain("views");
  });

  it("never rethrows, even when every step fails", () => {
    const logger = recordingLogger();
    let failed: string[] = [];
    expect(() => {
      failed = runTeardown(
        [
          { label: "a", run: () => { throw new Error("a"); } },
          { label: "b", run: () => { throw new Error("b"); } },
        ],
        logger,
      );
    }).not.toThrow();
    expect(failed).toEqual(["a", "b"]);
  });

  it("accepts an empty sequence (teardown with no live match)", () => {
    expect(runTeardown([], recordingLogger())).toEqual([]);
  });
});
