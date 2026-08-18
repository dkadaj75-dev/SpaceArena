/**
 * Constellation's shared accordion vocabulary.
 *
 * Every tool is generated from the same schema walk, so "the props list floods
 * the screen" is never a per-tool bug — it is one default in one place. These
 * helpers are that place: a `<details>` factory that is FOLDED unless something
 * asks otherwise, plus the New-first-then-List arrangement long lists get.
 *
 * Two properties matter beyond the markup:
 *
 *  - Open state must survive a re-render. `SchemaFormGen` rebuilds the whole
 *    form on every committed edit, so without a memory the group you are typing
 *    in would slam shut under you. {@link AccordionState} is that memory, keyed
 *    by the field's dotted path and (optionally) persisted so a reload or a
 *    hop to another config comes back to the shape you left.
 *  - Keyboard access is free and must stay that way: `<details>`/`<summary>` is
 *    focusable and toggles on Enter/Space natively, so nothing here replaces the
 *    disclosure with a div-and-click-handler.
 */

const STORAGE_PREFIX = "sa.constellation.accordion.";

/** The sliver of `Storage` this module uses — lets tests hand in a fake. */
export interface AccordionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage` when the platform allows it (Safari private mode throws). */
function defaultStorage(): AccordionStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Remembered open/closed flags for one editing surface.
 *
 * `scope` separates surfaces that share field names — an arena's `bounds` and a
 * prop's `bounds` are different disclosures, and the config type keeps them so.
 * An empty scope means "in memory only", which is what a throwaway form wants.
 *
 * What is remembered is deliberately narrower than what is tracked. A scope
 * spans every config of one type, but a ROW key ("propPlacements.7") names a
 * position in one particular document — persisting it would mean expanding rows
 * 0-20 of one arena and then finding all 21 of them expanded in every other
 * arena, forever: precisely the flood this module exists to prevent. So indexed
 * keys stay in memory, live only as long as the form instance editing that
 * document, and never reach storage. Structural keys ("propPlacements",
 * "propPlacements[]") carry no document identity and do persist.
 */
export class AccordionState {
  private readonly open = new Map<string, boolean>();

  constructor(
    private readonly scope = "",
    private readonly storage: AccordionStorage | null = defaultStorage(),
  ) {
    this.load();
  }

  /** Has the user opened {@link key}? Falls back to the caller's default. */
  isOpen(key: string, fallback = false): boolean {
    return this.open.get(key) ?? fallback;
  }

  set(key: string, open: boolean): void {
    this.open.set(key, open);
    this.save();
  }

  /** Forget every remembered flag — used by tests and by "collapse all". */
  clear(): void {
    this.open.clear();
    this.save();
  }

  private get storageKey(): string | null {
    return this.scope ? STORAGE_PREFIX + this.scope : null;
  }

  private load(): void {
    const key = this.storageKey;
    if (!key || !this.storage) return;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
        // Indexed keys are never written any more; drop any an older build left
        // behind rather than letting one document's rows unfold another's.
        if (typeof value === "boolean" && !isDocumentLocal(field)) this.open.set(field, value);
      }
    } catch {
      /* Stale or unreadable memory: everything simply starts folded. */
    }
  }

  private save(): void {
    const key = this.storageKey;
    if (!key || !this.storage) return;
    try {
      const durable = [...this.open].filter(([field]) => !isDocumentLocal(field));
      this.storage.setItem(key, JSON.stringify(Object.fromEntries(durable)));
    } catch {
      /* Quota or private mode: the in-memory map still carries the session. */
    }
  }
}

/**
 * Does this key name a position inside one specific document rather than a
 * place in the schema? Any numeric path segment ("propPlacements.7",
 * "sockets.2.mounts[]") is an array index, and an index means nothing once the
 * editor moves to a different config. See {@link AccordionState}.
 */
export function isDocumentLocal(key: string): boolean {
  return key.split(".").some((segment) => /^\d+(\[\])?$/.test(segment));
}

export interface AccordionOptions {
  /** Text of the disclosure's summary. */
  title: string;
  /** Stable identity for the remembered open flag (a dotted field path). */
  key: string;
  /** Open when nothing has been remembered yet. Folded is the default. */
  defaultOpen?: boolean;
  /** Item count rendered as a quiet badge beside the title. */
  count?: number;
  /** Extra class alongside `ed-group`. */
  className?: string;
}

/**
 * One disclosure, folded unless {@link AccordionOptions.defaultOpen} or a
 * remembered flag says otherwise. The caller appends its body to the returned
 * element; the summary is already in place as the first child.
 */
export function accordion(state: AccordionState, options: AccordionOptions): HTMLDetailsElement {
  const box = document.createElement("details");
  box.className = options.className ? `ed-group ${options.className}` : "ed-group";
  box.dataset.accordion = options.key;
  box.open = state.isOpen(options.key, options.defaultOpen ?? false);

  const summary = document.createElement("summary");
  summary.className = "ed-group-title";
  const title = document.createElement("span");
  title.className = "ed-group-label";
  title.textContent = options.title;
  summary.append(title);
  if (options.count !== undefined) {
    const count = document.createElement("span");
    count.className = "ed-count";
    count.textContent = String(options.count);
    summary.append(count);
  }
  box.append(summary);

  // Only a real change is recorded. Assigning `open` above queues a `toggle`
  // event that fires after this listener is attached, so an unguarded handler
  // would write one storage entry per group on every single render.
  box.addEventListener("toggle", () => {
    if (state.isOpen(options.key, options.defaultOpen ?? false) === box.open) return;
    state.set(options.key, box.open);
  });
  return box;
}

export interface ListAccordionOptions {
  /** Dotted path of the list; the sub-accordion derives its own key from it. */
  key: string;
  /** Title of the outer, folded disclosure ("Prop placements"). */
  title: string;
  /** Rows to show once the inner "List of …" disclosure is opened. */
  items: HTMLElement[];
  /** The create action, offered ABOVE the list so it never needs a scroll. */
  create?: { label: string; onCreate: () => void };
  /** Title of the inner disclosure. Defaults to `List of <title lowercased>`. */
  listTitle?: string;
  /** Shown in place of the rows when there are none. */
  emptyLabel?: string;
  /** Force the outer disclosure open on first sight (single-purpose panels). */
  defaultOpen?: boolean;
  /** Extra class alongside `ed-group ed-list`. */
  className?: string;
}

/**
 * The shape every long list in Constellation takes:
 *
 *     ▸ Prop placements (24)          ← folded
 *         [ New prop placement ]      ← create first, one click from folded
 *         ▸ List of prop placements (24)   ← folded
 *             ▸ Prop placement 1      ← each row folded too
 *
 * Three folds sound like a lot, but the flood they replace was 24 fully
 * expanded object forms — and the thing a designer reaches for most (adding
 * one) is now the shallowest thing on screen rather than the deepest.
 */
export function listAccordion(state: AccordionState, options: ListAccordionOptions): HTMLDetailsElement {
  const outer = accordion(state, {
    key: options.key,
    title: options.title,
    count: options.items.length,
    defaultOpen: options.defaultOpen,
    className: options.className ? `ed-list ${options.className}` : "ed-list",
  });

  if (options.create) {
    const row = document.createElement("div");
    row.className = "ed-list-create";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-btn ed-btn--primary ed-btn--sm";
    button.dataset.action = "add";
    button.textContent = options.create.label;
    button.addEventListener("click", options.create.onCreate);
    row.append(button);
    outer.append(row);
  }

  const inner = accordion(state, {
    key: `${options.key}[]`,
    title: options.listTitle ?? `List of ${options.title.toLowerCase()}`,
    count: options.items.length,
    className: "ed-list-items",
  });
  const list = document.createElement("div");
  list.className = "editor-array";
  if (options.items.length) list.append(...options.items);
  else {
    const empty = document.createElement("p");
    empty.className = "ed-list-empty";
    empty.textContent = options.emptyLabel ?? "Nothing here yet.";
    list.append(empty);
  }
  inner.append(list);
  outer.append(inner);
  return outer;
}

/**
 * `propPlacements` → `Prop Placements`; already-spaced labels pass through.
 *
 * Interior capitals are word starts, so they are kept rather than flattened —
 * lowercasing the tail turned `lodBias` into "Lod bias" and would do worse to
 * an acronym. Only the very first character is forced up.
 */
export function humanizeLabel(label: string): string {
  const spaced = label
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return label;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Naive singular for a create label ("Prop placements" → "prop placement").
 * Wrong for irregulars, but every shipped config field is a plain `-s` plural.
 */
export function singularLabel(label: string): string {
  const lower = humanizeLabel(label).toLowerCase();
  // "status", "bonus", "axis" are not plurals — leave them alone.
  if (/(ss|us|is)$/.test(lower)) return lower;
  if (/ies$/.test(lower)) return `${lower.slice(0, -3)}y`;
  // "boxes" → "box", but NOT "bases" → "bas": an `s` before `es` is handled by
  // the plain rule below, which yields "base".
  if (/(ch|sh|x|z)es$/.test(lower)) return lower.slice(0, -2);
  if (/s$/.test(lower)) return lower.slice(0, -1);
  return lower;
}
