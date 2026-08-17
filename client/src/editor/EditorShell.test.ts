import { describe, expect, it } from "vitest";
import { viewportRectFor } from "./EditorShell.js";

/** Desktop: 1280×720 window, 44px top bar + 34px tool row, 400px inspector. */
const DESKTOP_SPACER = { left: 0, top: 78, width: 880, height: 642 };
const DESKTOP_INSPECTOR = { left: 880, top: 78, width: 400, height: 642 };
/** Phone: full-width viewport cell with the sheet drawn over its bottom half. */
const PHONE_SPACER = { left: 0, top: 78, width: 390, height: 766 };
const PHONE_SHEET = { left: 0, top: 500, width: 390, height: 344 };

describe("viewportRectFor", () => {
  it("hands the docked layout the spacer cell verbatim — the inspector is beside it, not over it", () => {
    expect(viewportRectFor(DESKTOP_SPACER, DESKTOP_INSPECTOR, false)).toEqual(DESKTOP_SPACER);
  });

  it("stops the viewport at the top of a full-width bottom sheet", () => {
    expect(viewportRectFor(PHONE_SPACER, PHONE_SHEET, false)).toEqual({ left: 0, top: 78, width: 390, height: 422 });
  });

  it("keeps the full cell when the sheet is collapsed to its handle", () => {
    const collapsed = { left: 0, top: 808, width: 390, height: 36 };
    expect(viewportRectFor(PHONE_SPACER, collapsed, true)).toEqual(PHONE_SPACER);
  });

  it("never returns a degenerate rect — a zero-height cell would divide by zero downstream", () => {
    const rect = viewportRectFor({ left: 0, top: 78, width: 0, height: 0 }, PHONE_SHEET, false);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it("ignores a missing inspector (mid-teardown) rather than collapsing the viewport", () => {
    expect(viewportRectFor(PHONE_SPACER, null, false)).toEqual(PHONE_SPACER);
  });
});
