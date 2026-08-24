/**
 * "FIND FIELD" — substring search over a generated form's field tree.
 *
 * A shipped pack renders panels 1800px tall in a 276px window (Modules), or
 * 1401 controls in one flat scroll (Theme). The Tuning panel already proved the
 * answer to that: one search box that hides every field whose label does not
 * match. This module is that mechanism, lifted out of TuningPanel so any panel
 * over a SchemaFormGen can mount it — the filtering rules stay in ONE place, so
 * a fix to how labels are read reaches every panel at once.
 */

/**
 * Node label used for substring filtering: a field's own text, or null for
 * plain containers.
 *
 * Read from `firstElementChild` rather than a `:scope >` selector. Both shapes
 * put their caption FIRST — the field's title span, the group's summary — so
 * this is the same answer without depending on a selector happy-dom does not
 * resolve, which left the filter matching nothing at all under test.
 */
export function nodeLabel(el: HTMLElement): string | null {
  const first = el.firstElementChild;
  if (el.classList.contains("editor-field")) return first?.tagName === "SPAN" ? first.textContent ?? "" : "";
  if (el.tagName === "DETAILS") return first?.tagName === "SUMMARY" ? first.textContent ?? "" : "";
  return null;
}

export interface FilterOptions {
  /**
   * Open a `<details>` that still holds a match, and put it back the way the
   * designer left it once the query clears.
   *
   * Off for the Tuning panel, whose {@link import("./TuningPanel.js").TuningPanel}
   * sections own their fold state directly. On for panels whose whole form is
   * generated accordions — searching a wall of shut groups and being shown a
   * list of shut groups is not a search.
   */
  openGroups?: boolean;
}

/**
 * Fold state a filter forced open, so clearing the query restores it rather
 * than leaving every group the search happened to touch hanging open. Keyed by
 * the element, so groups SchemaFormGen rebuilds simply drop out.
 */
const forcedOpen = new WeakMap<HTMLDetailsElement, boolean>();

/** Hides child elements (and their subtrees) whose label doesn't contain `query`. Returns whether anything stayed visible. */
export function filterTree(el: HTMLElement, query: string, options: FilterOptions = {}): boolean {
  let anyVisible = false;
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement) || child.tagName === "SUMMARY") continue;
    const label = nodeLabel(child);
    const childrenVisible = filterTree(child, query, options);
    const visible = query === "" || (label !== null && label.toLowerCase().includes(query)) || childrenVisible;
    child.style.display = visible ? "" : "none";
    if (options.openGroups && child instanceof HTMLDetailsElement) revealGroup(child, query, visible);
    anyVisible = anyVisible || visible;
  }
  return anyVisible;
}

function revealGroup(group: HTMLDetailsElement, query: string, visible: boolean): void {
  if (query === "") {
    const restored = forcedOpen.get(group);
    if (restored !== undefined) {
      forcedOpen.delete(group);
      group.open = restored;
    }
    return;
  }
  if (!visible) return;
  if (!forcedOpen.has(group)) forcedOpen.set(group, group.open);
  group.open = true;
}

export interface FieldFilterOptions {
  /** Example field names, shown in the empty box. */
  placeholder?: string;
  /** Applies the query. Called on every keystroke and on {@link FieldFilter.refresh}. */
  onQuery: (query: string) => void;
}

/**
 * The search box itself: caption + input, ready to drop into a panel toolbar.
 *
 * It owns no form. `onQuery` is where a panel decides what "filter" means —
 * TuningPanel fans it out over its config sections, single-form panels pipe it
 * straight into {@link filterTree}.
 */
export class FieldFilter {
  readonly element: HTMLLabelElement;
  private readonly input: HTMLInputElement;
  private observer: MutationObserver | null = null;

  constructor(private readonly options: FieldFilterOptions) {
    this.element = document.createElement("label");
    this.element.className = "ed-field-filter";
    const caption = document.createElement("span");
    caption.className = "ed-label";
    caption.textContent = "Find field";
    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "ed-input";
    this.input.placeholder = options.placeholder ?? "e.g. damage, cooldownMs";
    this.input.addEventListener("input", () => this.refresh());
    this.element.append(caption, this.input);
  }

  /** The live query, lower-cased — the form the label comparison wants. */
  get query(): string {
    return this.input.value.trim().toLowerCase();
  }

  /** Re-apply the current query, e.g. after a panel rebuilt the form under it. */
  refresh(): void {
    this.options.onQuery(this.query);
  }

  /**
   * Re-apply on every rebuild of `form`. SchemaFormGen replaces its whole field
   * tree on each successful commit, which would otherwise wipe an active filter
   * until the next keystroke. Re-pointing at a new form replaces the old watch.
   */
  watch(form: HTMLElement): void {
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(form, { childList: true });
    this.refresh();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
