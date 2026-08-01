import { describe, expect, it } from "vitest";
import { HangarRefreshScope } from "./HangarApi.js";

describe("HangarRefreshScope", () => {
  it("rejects a stale result after a newer request starts", () => {
    const scope = new HangarRefreshScope();
    const first = scope.begin();
    const second = scope.begin();

    expect(first.signal.aborted).toBe(true);
    expect(scope.isCurrent(first.token, first.signal)).toBe(false);
    expect(scope.isCurrent(second.token, second.signal)).toBe(true);
  });

  it("lets only the newest request apply regardless of completion order", () => {
    const scope = new HangarRefreshScope();
    const older = scope.begin();
    const newer = scope.begin();

    // Model the newer response arriving first, then the older network response.
    expect(scope.isCurrent(newer.token, newer.signal)).toBe(true);
    expect(scope.isCurrent(older.token, older.signal)).toBe(false);
  });

  it("aborts and invalidates the in-flight request", () => {
    const scope = new HangarRefreshScope();
    const request = scope.begin();

    scope.invalidate();

    expect(request.signal.aborted).toBe(true);
    expect(scope.isCurrent(request.token, request.signal)).toBe(false);
  });

  it("invalidates a prior visit before its request can apply", () => {
    const scope = new HangarRefreshScope();
    const hiddenVisit = scope.begin();
    scope.invalidate(); // hide()
    const nextVisit = scope.begin(); // show()

    expect(scope.isCurrent(hiddenVisit.token, hiddenVisit.signal)).toBe(false);
    expect(scope.isCurrent(nextVisit.token, nextVisit.signal)).toBe(true);
  });
});
