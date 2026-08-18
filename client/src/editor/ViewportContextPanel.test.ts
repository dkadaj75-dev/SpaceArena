// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampPanelPosition, degPerSecToRpm, rpmToDegPerSec, trimNumber, ViewportContextPanel } from "./ViewportContextPanel.js";

describe("spin unit conversion", () => {
  it("maps deg/sec to RPM and back (360°/s = 60 RPM)", () => {
    expect(degPerSecToRpm(360)).toBe(60);
    expect(degPerSecToRpm(6)).toBe(1);
    expect(rpmToDegPerSec(1)).toBe(6);
    expect(rpmToDegPerSec(degPerSecToRpm(24))).toBeCloseTo(24);
  });

  it("trims float32 noise for display", () => {
    expect(trimNumber(-0.4000000059604645)).toBe(-0.4);
  });
});

describe("clampPanelPosition", () => {
  it("keeps the panel inside the host rect", () => {
    const panel = { width: 300, height: 200 };
    const host = { width: 800, height: 600 };
    expect(clampPanelPosition(50, 60, panel, host)).toEqual({ left: 50, top: 60 });
    expect(clampPanelPosition(-40, -10, panel, host)).toEqual({ left: 0, top: 0 });
    expect(clampPanelPosition(900, 900, panel, host)).toEqual({ left: 500, top: 400 });
  });

  it("pins an oversized panel to the origin instead of going negative", () => {
    expect(clampPanelPosition(20, 20, { width: 500, height: 500 }, { width: 300, height: 300 })).toEqual({ left: 0, top: 0 });
  });
});

describe("ViewportContextPanel", () => {
  afterEach(() => { document.body.replaceChildren(); });

  it("renders fields, commits edits, and live-syncs keyed numbers", () => {
    const onClose = vi.fn();
    const onNumber = vi.fn();
    const onSelect = vi.fn();
    const panel = new ViewportContextPanel(onClose);
    panel.show({
      title: "Prop #2",
      subtitle: "prop.block",
      fields: [
        { kind: "static", label: "kind", value: "structure" },
        { kind: "number", label: "pos x", key: "px", value: 4.25, onCommit: onNumber },
        { kind: "select", label: "prop", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], onCommit: onSelect },
        { kind: "note", text: "shared config" },
      ],
      actions: [{ label: "Delete", onClick: vi.fn(), danger: true }],
    });
    expect(panel.visible).toBe(true);
    const root = document.querySelector<HTMLElement>(".ed-ctx")!;
    expect(root.querySelector(".ed-ctx-title")!.textContent).toBe("Prop #2");
    const input = root.querySelector<HTMLInputElement>("input[type=number]")!;
    input.value = "7.5";
    input.dispatchEvent(new Event("change"));
    expect(onNumber).toHaveBeenCalledWith(7.5);

    const select = root.querySelector<HTMLSelectElement>("select")!;
    select.value = "b";
    select.dispatchEvent(new Event("change"));
    expect(onSelect).toHaveBeenCalledWith("b");

    // Gizmo-drag streaming updates the keyed field without a re-render.
    panel.setNumber("px", 9.12345);
    expect(input.value).toBe("9.1235");

    root.querySelector<HTMLButtonElement>(".ed-ctx-close")!.click();
    expect(onClose).toHaveBeenCalled();
    panel.dispose();
    expect(document.querySelector(".ed-ctx")).toBeNull();
  });

  it("hide() keeps the panel mounted but invisible until the next show()", () => {
    const panel = new ViewportContextPanel(vi.fn());
    panel.show({ title: "T", fields: [], actions: [] });
    panel.hide();
    expect(panel.visible).toBe(false);
    panel.show({ title: "T2", fields: [], actions: [] });
    expect(document.querySelectorAll(".ed-ctx")).toHaveLength(1);
    expect(document.querySelector(".ed-ctx-title")!.textContent).toBe("T2");
    panel.dispose();
  });
});
