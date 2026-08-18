import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccordionState, accordion, humanizeLabel, isDocumentLocal, listAccordion, singularLabel } from "./accordion.js";

beforeEach(() => {
  localStorage.clear();
});

/** State with no persistence — the default for an isolated assertion. */
function memory(): AccordionState {
  return new AccordionState("", null);
}

describe("accordion", () => {
  it("is a folded <details>/<summary> disclosure by default", () => {
    const box = accordion(memory(), { key: "propPlacements", title: "Prop placements" });

    expect(box.tagName).toBe("DETAILS");
    expect(box.open).toBe(false);
    const summary = box.firstElementChild!;
    // <summary> is natively focusable and toggles on Enter/Space — the whole
    // reason this is not a div with a click handler.
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.textContent).toContain("Prop placements");
    expect(box.dataset.accordion).toBe("propPlacements");
  });

  it("honours an explicit open default and renders a count badge", () => {
    const box = accordion(memory(), { key: "bounds", title: "Bounds", defaultOpen: true, count: 3 });

    expect(box.open).toBe(true);
    expect(box.querySelector(".ed-count")?.textContent).toBe("3");
  });

  it("remembers the user's choice across a re-render, in both directions", () => {
    const state = memory();

    const first = accordion(state, { key: "props", title: "Props" });
    first.open = true;
    first.dispatchEvent(new Event("toggle"));

    // A form re-render builds a brand-new element with the same key.
    expect(accordion(state, { key: "props", title: "Props" }).open).toBe(true);

    // Folding a group whose default is open must also stick.
    const nested = accordion(state, { key: "render", title: "Render", defaultOpen: true });
    nested.open = false;
    nested.dispatchEvent(new Event("toggle"));
    expect(accordion(state, { key: "render", title: "Render", defaultOpen: true }).open).toBe(false);
  });

  it("persists a scoped memory and keeps separate scopes apart", () => {
    const arena = new AccordionState("arena");
    const box = accordion(arena, { key: "propPlacements", title: "Prop placements" });
    box.open = true;
    box.dispatchEvent(new Event("toggle"));

    // A fresh state for the same scope (a reload, or another config of the type).
    expect(accordion(new AccordionState("arena"), { key: "propPlacements", title: "Prop placements" }).open).toBe(true);
    // A different tool sharing the field name is unaffected.
    expect(accordion(new AccordionState("prop"), { key: "propPlacements", title: "Prop placements" }).open).toBe(false);
  });

  it("never persists a row-level fold, so one document cannot re-flood another", () => {
    // The scenario this guards: expand rows 0-20 of lunar-rift's props, then
    // open any other arena and find all 21 rows expanded — forever.
    const editing = new AccordionState("arena");
    const list = accordion(editing, { key: "propPlacements", title: "Prop Placements" });
    list.open = true; list.dispatchEvent(new Event("toggle"));
    for (let index = 0; index <= 20; index++) {
      const row = accordion(editing, { key: `propPlacements.${index}`, title: `Prop placement ${index + 1}` });
      row.open = true; row.dispatchEvent(new Event("toggle"));
    }

    // Within this document the rows stay open across the form's own re-renders.
    expect(accordion(editing, { key: "propPlacements.7", title: "Prop placement 8" }).open).toBe(true);

    // The next config of the same type gets a fresh state: structure survives…
    const nextDocument = new AccordionState("arena");
    expect(accordion(nextDocument, { key: "propPlacements", title: "Prop Placements" }).open).toBe(true);
    // …but not one row of the previous document's 21.
    for (let index = 0; index <= 20; index++) {
      expect(accordion(nextDocument, { key: `propPlacements.${index}`, title: "row" }).open).toBe(false);
    }
    expect(JSON.parse(localStorage.getItem("sa.constellation.accordion.arena")!)).toEqual({ propPlacements: true });
  });

  it("drops indexed keys an older build may have persisted", () => {
    localStorage.setItem("sa.constellation.accordion.arena", JSON.stringify({ propPlacements: true, "propPlacements.3": true, "propPlacements.3.mounts[]": true }));
    const state = new AccordionState("arena");

    expect(state.isOpen("propPlacements")).toBe(true);
    expect(state.isOpen("propPlacements.3")).toBe(false);
    expect(state.isOpen("propPlacements.3.mounts[]")).toBe(false);
  });

  it("classifies keys that name a position in one document", () => {
    expect(isDocumentLocal("propPlacements")).toBe(false);
    expect(isDocumentLocal("propPlacements[]")).toBe(false);
    expect(isDocumentLocal("propPlacements.7")).toBe(true);
    expect(isDocumentLocal("sockets.2.mounts")).toBe(true);
    expect(isDocumentLocal("sockets.2.mounts[]")).toBe(true);
    // A field that merely starts with a digit-looking word is not an index.
    expect(isDocumentLocal("bounds.floorY")).toBe(false);
  });

  it("writes nothing to storage for the folds a plain render sets up", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const state = new AccordionState("arena", storage);

    // Rendering a form: `open` is assigned, and the queued toggle event lands
    // after the listener is attached. None of that is a user decision.
    for (const key of ["bounds", "render", "propPlacements"]) {
      const box = accordion(state, { key, title: key, defaultOpen: key !== "propPlacements" });
      box.dispatchEvent(new Event("toggle"));
    }
    expect(storage.setItem).not.toHaveBeenCalled();

    // An actual toggle still writes.
    const box = accordion(state, { key: "propPlacements", title: "Props" });
    box.open = true;
    box.dispatchEvent(new Event("toggle"));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("survives unreadable storage rather than throwing", () => {
    const storage = {
      getItem: vi.fn(() => "not json"),
      setItem: vi.fn(() => { throw new Error("quota"); }),
    };
    const state = new AccordionState("arena", storage);

    const box = accordion(state, { key: "props", title: "Props" });
    expect(box.open).toBe(false);
    expect(() => { box.open = true; box.dispatchEvent(new Event("toggle")); }).not.toThrow();
    // The in-memory half still carried the session.
    expect(state.isOpen("props")).toBe(true);
  });

  it("clear() forgets every remembered flag", () => {
    const state = memory();
    state.set("props", true);
    state.clear();
    expect(state.isOpen("props")).toBe(false);
  });
});

describe("listAccordion", () => {
  function rows(count: number): HTMLElement[] {
    return Array.from({ length: count }, (_, i) => {
      const row = document.createElement("div");
      row.className = "editor-array-row";
      row.textContent = `row ${i}`;
      return row;
    });
  }

  it("nests New-first-then-List, with every level folded", () => {
    const onCreate = vi.fn();
    const outer = listAccordion(memory(), {
      key: "propPlacements",
      title: "Prop placements",
      items: rows(24),
      create: { label: "New prop placement", onCreate },
    });

    expect(outer.open).toBe(false);
    expect(outer.firstElementChild!.textContent).toContain("Prop placements");
    expect(outer.firstElementChild!.querySelector(".ed-count")?.textContent).toBe("24");

    // Direct children in order: summary, the create action, the list disclosure.
    const children = Array.from(outer.children).map((el) => el.tagName + (el.className ? `.${el.className.split(" ")[0]}` : ""));
    expect(children).toEqual(["SUMMARY.ed-group-title", "DIV.ed-list-create", "DETAILS.ed-group"]);

    const inner = outer.children[2] as HTMLDetailsElement;
    expect(inner.open).toBe(false);
    expect(inner.firstElementChild!.textContent).toContain("List of prop placements");
    expect(inner.querySelectorAll(".editor-array-row")).toHaveLength(24);

    outer.querySelector<HTMLButtonElement>('[data-action="add"]')!.click();
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("gives the inner list its own remembered key so the two folds are independent", () => {
    const state = memory();
    const first = listAccordion(state, { key: "spawnPoints", title: "Spawn points", items: rows(2) });
    const inner = first.querySelector<HTMLDetailsElement>('[data-accordion="spawnPoints[]"]')!;
    inner.open = true;
    inner.dispatchEvent(new Event("toggle"));

    const second = listAccordion(state, { key: "spawnPoints", title: "Spawn points", items: rows(2) });
    expect(second.open).toBe(false);
    expect(second.querySelector<HTMLDetailsElement>('[data-accordion="spawnPoints[]"]')!.open).toBe(true);
  });

  it("shows a placeholder instead of an empty list, and omits the create row when there is no create action", () => {
    const outer = listAccordion(memory(), { key: "flagBases", title: "Flag bases", items: [], emptyLabel: "No flag bases yet." });

    expect(outer.querySelector(".ed-list-create")).toBeNull();
    expect(outer.querySelector(".ed-list-empty")?.textContent).toBe("No flag bases yet.");
    expect(outer.firstElementChild!.querySelector(".ed-count")?.textContent).toBe("0");
  });

  it("can be forced open for a panel whose whole purpose is that one list", () => {
    const outer = listAccordion(memory(), { key: "only", title: "Only", items: rows(1), defaultOpen: true });
    expect(outer.open).toBe(true);
  });
});

describe("label helpers", () => {
  it("humanizes camelCase and snake_case field names, keeping interior capitals", () => {
    expect(humanizeLabel("propPlacements")).toBe("Prop Placements");
    expect(humanizeLabel("spawn_points")).toBe("Spawn points");
    expect(humanizeLabel("sockets")).toBe("Sockets");
    // Lowercasing the tail mangled real field names — and acronyms worst of all.
    expect(humanizeLabel("lodBias")).toBe("Lod Bias");
    expect(humanizeLabel("maxHP")).toBe("Max HP");
  });

  it("singularizes the common plural shapes used by the shipped schemas", () => {
    expect(singularLabel("propPlacements")).toBe("prop placement");
    expect(singularLabel("flagBases")).toBe("flag base");
    expect(singularLabel("entries")).toBe("entry");
    expect(singularLabel("tags")).toBe("tag");
    // Not a plural at all — left intact rather than mangled into "statu".
    expect(singularLabel("status")).toBe("status");
  });
});
