// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene, TransformNode } from "@babylonjs/core";
import type { HangarSlot } from "../hangarFitting.js";
import { HangarCallouts, type CalloutSpec } from "./HangarCallouts.js";

/**
 * The projection itself needs a live Babylon scene, so these cover everything
 * around it: which markers exist, what they say, what they do when clicked, and
 * the drag-and-drop handshake — which is the part a browser will silently
 * refuse if `dragover` forgets to preventDefault.
 */

function slot(hardpointIndex: number, kind: "hardpoint" | "internal", moduleId: string | null): HangarSlot {
  return {
    hardpointIndex,
    socketId: `s-${hardpointIndex}`,
    kind,
    accepts: kind === "internal" ? ["engine"] : ["laser"],
    moduleId,
  };
}

const specs = (): CalloutSpec[] => [
  { slot: slot(0, "hardpoint", "module.laser-mk1"), offset: [0, 0, 1] },
  { slot: slot(1, "hardpoint", null), offset: [1, 0, 0] },
  { slot: slot(2, "internal", "module.engine-civ"), offset: [0, 0, -1] },
];

/** Enough of a Babylon scene/node for construction; `update()` is not called. */
const fakeScene = (): Scene => ({ getViewMatrix: () => undefined }) as unknown as Scene;
const fakeRoot = (): TransformNode => ({ position: { x: 0, y: 0, z: 0 } }) as unknown as TransformNode;

function mount(callbacks: { onSelect?: ReturnType<typeof vi.fn>; onDrop?: ReturnType<typeof vi.fn> } = {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onSelect = callbacks.onSelect ?? vi.fn();
  const onDrop = callbacks.onDrop ?? vi.fn();
  const callouts = new HangarCallouts(parent, fakeScene(), fakeRoot(), { onSelect, onDrop });
  callouts.rebuild(specs(), (s) => (s.moduleId ? `mod-${s.hardpointIndex}` : "Empty"));
  return { parent, callouts, onSelect, onDrop };
}

const markers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".hangar-callout")];

/** Build a DragEvent happy-dom can carry a dataTransfer payload on. */
function dragEvent(type: string, data?: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { getData: () => data ?? "", setData: vi.fn(), effectAllowed: "" },
  });
  return ev;
}

describe("HangarCallouts", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("draws one tag per slot, labelled and colour-coded by bay", () => {
    mount();
    const all = markers();
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.querySelector(".tag")!.textContent)).toEqual(["mod-0", "Empty", "mod-2"]);
    expect(all[0]!.className).toContain("kind-hardpoint");
    expect(all[2]!.className).toContain("kind-internal");
    // An empty slot reads as empty.
    expect(all[1]!.className).toContain("empty");
    expect(all[0]!.className).not.toContain("empty");
  });

  it("clicking a tag opens that slot — by its real index, not its position", () => {
    const { onSelect } = mount();
    markers()[2]!.click();
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("marks the open slot so the 3D and the panel agree about the selection", () => {
    const { callouts } = mount();
    callouts.setSelected(1);
    expect(markers().map((m) => m.classList.contains("selected"))).toEqual([false, true, false]);
    callouts.setSelected(null);
    expect(markers().some((m) => m.classList.contains("selected"))).toBe(false);
  });

  it("highlights the legal drop targets while a module is dragged, and clears after", () => {
    const { callouts } = mount();
    callouts.setDropCandidates(new Set([0, 1]));
    const [a, b, c] = markers();
    expect(a!.classList.contains("droppable")).toBe(true);
    expect(b!.classList.contains("droppable")).toBe(true);
    expect(c!.classList.contains("dimmed")).toBe(true); // the internal bay refuses a laser

    callouts.setDropCandidates(null);
    expect(markers().some((m) => m.classList.contains("droppable") || m.classList.contains("dimmed"))).toBe(false);
  });

  it("accepts a drop and reports the module id with the slot it landed on", () => {
    const { onDrop } = mount();
    const target = markers()[1]!;
    target.dispatchEvent(dragEvent("dragover"));
    expect(target.classList.contains("drop-hover")).toBe(true);
    target.dispatchEvent(dragEvent("drop", "module.laser-mk1"));
    expect(onDrop).toHaveBeenCalledWith(1, "module.laser-mk1");
    expect(target.classList.contains("drop-hover")).toBe(false);
  });

  it("CANCELS the dragover event — without that the browser refuses every drop", () => {
    mount();
    const ev = dragEvent("dragover");
    markers()[0]!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores a drop carrying no module id", () => {
    const { onDrop } = mount();
    markers()[0]!.dispatchEvent(dragEvent("drop", ""));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("clears drag styling when the pointer leaves without dropping", () => {
    mount();
    const target = markers()[0]!;
    target.dispatchEvent(dragEvent("dragover"));
    target.dispatchEvent(new Event("dragleave"));
    expect(target.classList.contains("drop-hover")).toBe(false);
  });

  it("rebuilds cleanly for a new fitting and disposes its layer", () => {
    const { callouts } = mount();
    callouts.rebuild([{ slot: slot(0, "hardpoint", "module.kinetic-mk1"), offset: [0, 0, 0] }], () => "one");
    expect(markers()).toHaveLength(1);
    callouts.dispose();
    expect(document.querySelector(".hangar-callouts")).toBeNull();
  });
});
