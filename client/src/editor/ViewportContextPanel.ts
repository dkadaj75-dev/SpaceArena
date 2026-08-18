/**
 * Floating selection-context panel for viewport tools (Map, Ships). One shared
 * chrome: a draggable notched card INSIDE the shell's `.ed-viewport` cell —
 * the cell is pointer-events:none so the scene stays interactive, and only the
 * panel itself takes events back. Callers describe content declaratively
 * (`CtxView`) and re-show on every model change; per-frame gizmo motion streams
 * through {@link ViewportContextPanel.setNumber} without a rebuild.
 */

/** Rotation-per-minute is the designer-facing unit; configs store deg/sec. */
export function degPerSecToRpm(value: number): number { return value / 6; }
export function rpmToDegPerSec(value: number): number { return value * 6; }
/** Trim binding-noise decimals for display (4dp matches roundMarkerValue). */
export function trimNumber(value: number): number { return Number(value.toFixed(4)); }

/** Keep a dragged panel's top-left corner inside its host rect. */
export function clampPanelPosition(
  left: number, top: number, panel: { width: number; height: number }, host: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.min(Math.max(0, left), Math.max(0, host.width - panel.width)),
    top: Math.min(Math.max(0, top), Math.max(0, host.height - panel.height)),
  };
}

export type CtxField =
  | { kind: "static"; label: string; value: string }
  | { kind: "number"; label: string; value: number; key?: string; step?: number; min?: number; onCommit: (value: number) => void }
  | { kind: "select"; label: string; value: string; options: Array<{ value: string; label: string }>; onCommit: (value: string) => void }
  | { kind: "toggle"; label: string; value: boolean; onCommit: (value: boolean) => void }
  | { kind: "note"; text: string }
  | { kind: "link"; label: string; onClick: () => void };

export interface CtxAction { label: string; onClick: () => void; danger?: boolean }
export interface CtxView { title: string; subtitle?: string; fields: CtxField[]; actions: CtxAction[] }

export class ViewportContextPanel {
  private readonly root = document.createElement("div");
  private readonly head = document.createElement("div");
  private readonly title = document.createElement("span");
  private readonly subtitle = document.createElement("span");
  private readonly body = document.createElement("div");
  private readonly footer = document.createElement("div");
  private readonly numbers = new Map<string, HTMLInputElement>();

  constructor(private readonly onClose: () => void) {
    this.root.className = "ed-ctx ed-frame";
    this.root.style.display = "none";
    this.head.className = "ed-ctx-head";
    this.title.className = "ed-ctx-title";
    this.subtitle.className = "ed-ctx-subtitle";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ed-ctx-close";
    close.textContent = "×";
    close.title = "Deselect";
    close.addEventListener("click", () => this.onClose());
    this.head.append(this.title, this.subtitle, close);
    this.body.className = "ed-ctx-body";
    this.footer.className = "ed-ctx-actions";
    this.root.append(this.head, this.body, this.footer);
    this.bindDrag(close);
  }

  /** The shell's viewport cell when open; body as a fallback (tests, staging). */
  private mount(): void {
    if (this.root.isConnected) return;
    const cell = document.querySelector<HTMLElement>(".sa-editor .ed-viewport") ?? document.body;
    cell.append(this.root);
  }

  get visible(): boolean { return this.root.style.display !== "none"; }

  show(view: CtxView): void {
    this.mount();
    this.root.style.display = "";
    this.title.textContent = view.title;
    this.subtitle.textContent = view.subtitle ?? "";
    this.numbers.clear();
    this.body.replaceChildren(...view.fields.map((field) => this.renderField(field)));
    this.footer.replaceChildren(...view.actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ed-btn ed-btn--sm${action.danger ? " ed-btn--danger" : ""}`;
      button.textContent = action.label;
      button.addEventListener("click", action.onClick);
      return button;
    }));
  }

  hide(): void { this.root.style.display = "none"; }

  /** Live-sync a keyed number field (gizmo drag) without stealing typing focus. */
  setNumber(key: string, value: number): void {
    const input = this.numbers.get(key);
    if (!input || document.activeElement === input) return;
    input.value = String(trimNumber(value));
  }

  private renderField(field: CtxField): HTMLElement {
    if (field.kind === "note") {
      const note = document.createElement("p");
      note.className = "ed-ctx-note";
      note.textContent = field.text;
      return note;
    }
    if (field.kind === "link") {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "ed-ctx-link";
      link.textContent = field.label;
      link.addEventListener("click", field.onClick);
      return link;
    }
    const row = document.createElement("label");
    row.className = "ed-ctx-field";
    const label = document.createElement("span");
    label.textContent = field.label;
    row.append(label);
    if (field.kind === "static") {
      const value = document.createElement("span");
      value.className = "ed-ctx-static";
      value.textContent = field.value;
      row.append(value);
    } else if (field.kind === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.step = String(field.step ?? "any");
      if (field.min !== undefined) input.min = String(field.min);
      input.className = "ed-input ed-num";
      input.value = String(trimNumber(field.value));
      input.addEventListener("change", () => { const value = Number(input.value); if (Number.isFinite(value)) field.onCommit(value); });
      // Spinner/scroll steps (input events with no inputType) commit at once —
      // some engines defer `change` to blur for stepped number values.
      input.addEventListener("input", (ev) => {
        if ((ev as InputEvent).inputType) return;
        const value = Number(input.value);
        if (Number.isFinite(value)) field.onCommit(value);
      });
      if (field.key) this.numbers.set(field.key, input);
      row.append(input);
    } else if (field.kind === "select") {
      const select = document.createElement("select");
      for (const option of field.options) select.append(new Option(option.label, option.value, false, option.value === field.value));
      select.addEventListener("change", () => field.onCommit(select.value));
      row.append(select);
    } else {
      const wrap = document.createElement("span");
      wrap.className = "ed-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = field.value;
      input.addEventListener("change", () => field.onCommit(input.checked));
      const track = document.createElement("span");
      track.className = "ed-toggle-track";
      wrap.append(input, track);
      row.append(wrap);
    }
    return row;
  }

  /** Head-drag repositioning; touch-friendly via pointer capture. */
  private bindDrag(exclude: HTMLElement): void {
    let start: { x: number; y: number; left: number; top: number } | null = null;
    this.head.addEventListener("pointerdown", (event) => {
      if (event.target === exclude) return;
      start = { x: event.clientX, y: event.clientY, left: this.root.offsetLeft, top: this.root.offsetTop };
      this.head.setPointerCapture(event.pointerId);
    });
    this.head.addEventListener("pointermove", (event) => {
      if (!start) return;
      const host = this.root.parentElement;
      const position = clampPanelPosition(
        start.left + event.clientX - start.x,
        start.top + event.clientY - start.y,
        { width: this.root.offsetWidth, height: this.root.offsetHeight },
        { width: host?.clientWidth ?? Infinity, height: host?.clientHeight ?? Infinity },
      );
      this.root.style.left = `${position.left}px`;
      this.root.style.top = `${position.top}px`;
      this.root.style.right = "auto";
    });
    const end = (event: PointerEvent): void => { start = null; if (this.head.hasPointerCapture?.(event.pointerId)) this.head.releasePointerCapture(event.pointerId); };
    this.head.addEventListener("pointerup", end);
    this.head.addEventListener("pointercancel", end);
  }

  dispose(): void { this.root.remove(); }
}
