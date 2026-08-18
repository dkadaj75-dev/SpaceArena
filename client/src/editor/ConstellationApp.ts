import type { ConfigError, ContentBundle } from "@space-arena/shared";
import type { EditorRepository } from "./repository/EditorRepository.js";
import { EditorRepositoryError } from "./repository/EditorRepository.js";
import { DraftPackStore } from "./DraftPackStore.js";
import { GenericConfigPanel } from "./GenericConfigPanel.js";
import { ConstellationViewport, type ConstellationHost } from "./ConstellationViewport.js";
import { ViewportEditor } from "./ViewportEditor.js";
import { repoSaveAvailable, saveActionState, saveDraftToRepo, type RepoAvailability, type RepoSaveSummary } from "./saveToRepo.js";
import "./editor.css";

export class ConstellationApp {
  private root: HTMLDivElement | null = null;
  private draft: DraftPackStore | null = null;
  private problems: ConfigError[] = [];
  private status = document.createElement("span");
  private publishButton = document.createElement("button");
  private repoButton = document.createElement("button");
  private downloadButton = document.createElement("button");
  /** Dirty badge — always on screen, never overwritten by transient messages. */
  private dirtyBadge = document.createElement("span");
  /** Off-screen live region: outcomes only, so edits are not narrated. */
  private announcer = document.createElement("p");
  private saveHint = document.createElement("span");
  /** Transient text shown in place of the status baseline; cleared by the next edit. */
  private pendingMessage: string | null = null;
  private repoAvailability: RepoAvailability = "checking";
  /** Set by a clean repo save, cleared by the next edit. Drives "Saved to repo". */
  private savedSinceEdit = false;
  private problemList = document.createElement("div");
  private viewport: ConstellationViewport | null = null;
  /** Viewport selection + gizmo editing; absent with no scene host (forms only). */
  private viewportEditor: ViewportEditor | null = null;
  private panel: GenericConfigPanel | null = null;

  constructor(
    private readonly repository: EditorRepository,
    private readonly onClose: () => void,
    /** Scene access for the 3D viewport; forms-only layout when absent. */
    private readonly host: ConstellationHost | null = null,
  ) {}

  async open(): Promise<void> {
    const bundle = await this.repository.load();
    this.draft = DraftPackStore.restore(bundle);
    // Built before the workspace so the first selection can stage itself.
    if (this.host) {
      this.viewport = new ConstellationViewport(this.host);
      this.viewportEditor = new ViewportEditor({
        host: this.host, viewport: this.viewport, draft: () => this.draft!,
        // A viewport commit already wrote to the draft and owns the restage, so
        // the catalogue redraws WITHOUT re-staging (see `GenericConfigPanel.render`).
        onDraftEdit: () => { this.panel?.render(false); void this.preflight(); },
        onReveal: (fieldPath) => this.panel?.reveal(fieldPath),
        onReport: (text) => this.message(text),
      });
    }
    this.root = document.createElement("div"); this.root.className = "sa-editor constellation-standalone"; this.root.dataset.sheet = "full";
    this.root.dataset.viewport = "off";
    this.root.append(this.topbar(), this.workspace(), this.actionbar()); document.body.append(this.root);
    this.draft.onChange(this.onDraftChange); await this.preflight(); this.update();
    window.addEventListener("beforeunload", this.guard);
  }

  /**
   * Saving lives here, not in the footer.
   *
   * The footer is a sideways-scrolling row of eight equal-looking buttons
   * pinned to the bottom of a full-height grid. "Save to repo" was the third of
   * them, greyed out whenever the draft happened to be clean, with every
   * explanation of its state hidden in a `title` nobody hovers on a tablet —
   * indistinguishable from an editor that simply cannot save.
   *
   * So the two actions that make work durable — write to `content/`, or
   * download the draft — plus the dirty badge now sit permanently in the top
   * bar, and the Save control always states its own condition in its label and,
   * when it is unusable, in a visible line beside it (see `saveActionState`).
   */
  private topbar(): HTMLElement {
    const bar = document.createElement("header"); bar.className = "ed-topbar";
    const brand = document.createElement("div"); brand.className = "ed-brand"; brand.textContent = "Constellation · Design Tools";
    this.status.className = "constellation-status";
    // No aria-live on the badge: it ticks on every committed keystroke, and a
    // screen reader reciting "4 unsaved change(s)… 5 unsaved change(s)…" over an
    // edit is noise. Outcomes worth hearing go to `announcer` via `message()`.
    this.dirtyBadge.className = "constellation-dirty";
    this.announcer.className = "constellation-announce";
    this.announcer.setAttribute("role", "status");
    this.announcer.setAttribute("aria-live", "polite");
    this.saveHint.className = "constellation-save-hint";

    const save = document.createElement("div"); save.className = "constellation-save";
    this.repoButton = this.button("Save to repo", "ed-btn ed-btn--primary", () => void this.saveToRepo());
    this.repoButton.dataset.action = "save-repo";
    this.downloadButton = this.button("Download draft", "ed-btn", () => void this.download());
    this.downloadButton.dataset.action = "download-draft";
    this.downloadButton.title = "Write the complete draft pack to a JSON file you can re-import later.";
    save.append(this.dirtyBadge, this.repoButton, this.downloadButton, this.saveHint);

    void repoSaveAvailable().then((available) => { this.repoAvailability = available ? "available" : "unavailable"; this.update(); });
    const close = this.button("Exit", "ed-btn ed-btn--danger", () => this.close());
    close.className = "ed-btn ed-btn--danger constellation-exit";
    bar.append(brand, this.status, save, close, this.announcer); return bar;
  }

  private workspace(): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "constellation-workspace";
    const panel = new GenericConfigPanel(this.draft!, (errors) => { this.problems = errors; this.renderProblems(); this.update(); }, {
      viewport: this.viewport,
      editor: this.viewportEditor,
      // Only a live 3D subject earns the transparent chrome; forms-only types
      // keep the opaque backdrop so nothing of the scene bleeds through them.
      onViewport: (active) => { if (this.root) this.root.dataset.viewport = active ? "on" : "off"; },
    });
    this.panel = panel;
    this.problemList.className = "constellation-problems"; this.problemList.setAttribute("aria-live", "polite");
    const dock = document.createElement("details"); dock.className = "constellation-problems-dock"; dock.open = true;
    const summary = document.createElement("summary"); summary.textContent = "Problems";
    dock.append(summary, this.problemList);
    wrap.append(panel.element, dock); return wrap;
  }

  /** Everything that is not "make my work durable" — that lives in the top bar. */
  private actionbar(): HTMLElement {
    const bar = document.createElement("footer"); bar.className = "constellation-actions";
    this.publishButton = this.button("Preflight & Publish live", "ed-btn", () => void this.publish());
    const importInput = document.createElement("input"); importInput.type = "file"; importInput.accept = ".json,application/json"; importInput.hidden = true;
    importInput.addEventListener("change", () => { const file = importInput.files?.[0]; if (file) void this.import(file); });
    const importButton = this.button("Import JSON pack", "ed-btn", () => importInput.click()); importButton.dataset.action = "import";
    const discard = this.button("Discard draft", "ed-btn", () => { void this.confirmDiscard(); });
    const undo = this.button("Undo", "ed-btn", () => { this.draft!.undo(); this.rebuildWorkspace(); }); undo.dataset.action = "undo";
    const redo = this.button("Redo", "ed-btn", () => { this.draft!.redo(); this.rebuildWorkspace(); }); redo.dataset.action = "redo";
    const rollback = this.button("Roll back live", "ed-btn ed-btn--danger", () => void this.rollback());
    bar.append(undo, redo, this.publishButton, importButton, importInput, discard, rollback); return bar;
  }

  /** Discarding is the one footer action that destroys work — it now asks first. */
  private async confirmDiscard(): Promise<void> {
    if (this.draft!.isDirty() && !await this.confirm(`Discard ${this.draft!.dirtyCount()} changed file(s)? This cannot be undone from here.`)) return;
    this.draft!.discard(); this.rebuildWorkspace();
  }

  /**
   * Write the whole dirty draft into the working copy's `content/` tree. This is
   * the repo-facing half of the editor: publishing pushes a pack to the live
   * server, this one puts the same edits under version control.
   *
   * The draft stays dirty either way: the repo and the live pack are separate
   * destinations, and clearing the draft here would throw away the state Publish
   * still needs. Anything that failed is simply retried by pressing again.
   */
  private async saveToRepo(): Promise<void> {
    if (!this.draft?.isDirty()) return;
    this.repoButton.disabled = true;
    this.message("Saving to repo…");
    try {
      const summary = await saveDraftToRepo(this.draft);
      this.renderRepoResults(summary);
      // Only a clean sweep counts as saved; one rejected file and the badge keeps
      // warning, because one rejected file is exactly the work that would be lost.
      this.savedSinceEdit = summary.failed === 0 && summary.saved > 0;
      if (!summary.failed) this.message(`${summary.saved} file(s) saved to content/ — publish separately to go live.`);
      else this.message(`${summary.saved} saved, ${summary.failed} failed — the draft stays dirty.`);
    } catch (error) {
      // `saveDraftToRepo` turns network failures into per-file results, so only
      // something like a structuredClone failure lands here. It must not leave
      // Save disabled for the rest of the session — that is the lost-work bug.
      this.message(error instanceof Error ? `Save to repo failed: ${error.message}` : "Save to repo failed.");
    } finally {
      this.update();
    }
  }

  /** Per-file outcome, shown in the problems dock next to the pack blockers. */
  private renderRepoResults(summary: RepoSaveSummary): void {
    const rows = summary.results.map((result) => {
      const row = document.createElement("p");
      row.className = result.ok ? "constellation-repo-ok" : "constellation-problem";
      row.textContent = `${result.ok ? "✓" : "✕"} ${result.kind} ${result.path}${result.error ? `: ${result.error}` : ""}`;
      return row;
    });
    const title = document.createElement("strong");
    title.textContent = `Save to repo · ${summary.saved} ok, ${summary.failed} failed`;
    this.problemList.replaceChildren(title, ...rows);
  }

  private async preflight(): Promise<boolean> {
    const result = await this.draft!.preflight(); this.problems = result.errors; this.renderProblems(); this.update(); return result.ok;
  }

  private async publish(): Promise<void> {
    if (!await this.preflight()) { this.message("Publish blocked: fix whole-pack errors first."); return; }
    if (!await this.confirm("Publish this complete pack live? Fresh clients and new rooms will use it; in-flight rooms remain pinned.")) return;
    try {
      const candidate = await this.draft!.publishable();
      const result = await this.repository.publish(candidate, this.draft!.base.sourceHash);
      this.message(`Published ${result.packId} v${result.packVersion} · ${result.sourceHash.slice(0, 20)}…`);
      window.removeEventListener("beforeunload", this.guard); this.root?.remove(); this.root = null;
      this.viewportEditor?.dispose(); this.viewportEditor = null;
      this.viewport?.dispose(); this.viewport = null;
      await this.open(); this.message(`Published ${result.packId} v${result.packVersion} · ${result.sourceHash.slice(0, 20)}…`);
    } catch (error) { this.handle(error); }
  }

  private async rollback(): Promise<void> {
    if (!await this.confirm("Roll back to the previous live pack? Your local draft can still be downloaded first.")) return;
    try { const result = await this.repository.rollback(); this.message(`Rolled back live pack to ${result.sourceHash.slice(0, 20)}…`); }
    catch (error) { this.handle(error); }
  }

  private async download(): Promise<void> {
    const candidate = await this.draft!.publishable();
    const blob = new Blob([JSON.stringify(candidate, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = `${candidate.packId}-v${candidate.packVersion}.pack.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
  }

  /**
   * Replace the whole draft with a pack from disk. Like Discard and Exit, this
   * throws away everything unsaved, so it asks first — the old draft is only
   * recoverable by knowing it still sits in this browser's storage.
   */
  private async import(file: File): Promise<void> {
    if (this.draft?.isDirty()
      && !await this.confirm(`Import replaces your draft — ${this.draft.dirtyCount()} changed file(s) will be dropped. Download the draft first if you want to keep it.`)) return;
    try {
      const raw = JSON.parse(await file.text()) as ContentBundle;
      const imported = new DraftPackStore(raw); const result = await imported.preflight();
      if (!result.ok) { this.problems = result.errors; this.renderProblems(); this.message("Imported pack is invalid; current draft was preserved."); return; }
      // The listener belonged to the replaced store — without re-registering,
      // an imported pack would edit fine but never move the dirty badge again.
      this.draft = imported; this.savedSinceEdit = false; this.pendingMessage = null;
      this.draft.onChange(this.onDraftChange);
      this.root?.querySelector(".constellation-workspace")?.replaceWith(this.workspace()); this.update();
    } catch { this.message("Import failed: choose a valid Orion's Arm JSON content pack."); }
  }

  private renderProblems(): void {
    if (!this.problems.length) { this.problemList.textContent = "Whole-pack preflight clean."; return; }
    const title = document.createElement("strong"); title.textContent = `${this.problems.length} publish blocker(s)`;
    this.problemList.replaceChildren(title, ...this.problems.map((error) => { const row = document.createElement("button"); row.type = "button"; row.className = "constellation-problem"; row.textContent = `${error.file} → ${error.path}: ${error.message}`; return row; }));
  }

  private update(): void {
    if (!this.draft) return;
    const state = saveActionState(this.repoAvailability, this.draft.dirtyCount(), this.savedSinceEdit);
    this.renderStatus();
    this.repoButton.textContent = state.label;
    this.repoButton.disabled = state.disabled;
    this.repoButton.title = state.title;
    this.dirtyBadge.textContent = state.status;
    this.dirtyBadge.dataset.tone = state.tone;
    this.saveHint.textContent = state.hint ?? "";
    this.saveHint.hidden = !state.hint;
    // When the repo route is gone, downloading the draft IS the save — promote it.
    this.downloadButton.classList.toggle("ed-btn--primary", state.fallback);
    if (this.root) this.root.dataset.dirty = state.tone;
    this.publishButton.disabled = this.problems.length > 0 || !this.draft.isDirty();
    const undo = this.root?.querySelector<HTMLButtonElement>('[data-action="undo"]');
    const redo = this.root?.querySelector<HTMLButtonElement>('[data-action="redo"]');
    if (undo) undo.disabled = !this.draft.canUndo();
    if (redo) redo.disabled = !this.draft.canRedo();
  }
  private rebuildWorkspace(): void { this.root?.querySelector(".constellation-workspace")?.replaceWith(this.workspace()); void this.preflight(); }
  /**
   * Report something that just happened. It borrows the status line until the
   * next edit, and it is the only thing spoken aloud — see the `announcer` note
   * in {@link topbar}.
   */
  private message(text: string): void { this.pendingMessage = text; this.announcer.textContent = text; this.renderStatus(); }

  /**
   * The status line always identifies the pack being edited; a message only
   * borrows it. Without a restorable baseline the editor went permanently quiet
   * about which pack a draft stood against — including after a publish had
   * swapped that pack for a new one.
   */
  private renderStatus(): void {
    if (!this.draft) return;
    this.status.textContent = this.pendingMessage
      ?? `${this.draft.dirtyCount()} changed file(s) · base ${this.draft.base.sourceHash.slice(0, 15)}…`;
  }

  /** An edit invalidates the last outcome: the badge and status line move on. */
  private onDraftChange = (): void => { this.savedSinceEdit = false; this.pendingMessage = null; this.update(); };
  private handle(error: unknown): void { if (error instanceof EditorRepositoryError && error.errors.length) { this.problems = error.errors; this.renderProblems(); } this.message(error instanceof Error ? error.message : "Operation failed"); }
  private button(label: string, className: string, action: () => void): HTMLButtonElement { const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label; button.addEventListener("click", action); return button; }
  private confirm(message: string): Promise<boolean> { return new Promise((resolve) => { const dialog = document.createElement("dialog"); dialog.className = "constellation-confirm"; const copy = document.createElement("p"); copy.textContent = message; const no = this.button("Cancel", "ed-btn", () => { dialog.close(); resolve(false); }); const yes = this.button("Confirm", "ed-btn ed-btn--danger", () => { dialog.close(); resolve(true); }); dialog.append(copy, no, yes); document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove()); dialog.showModal(); }); }
  private guard = (event: BeforeUnloadEvent): void => { if (this.draft?.isDirty()) { event.preventDefault(); event.returnValue = ""; } };
  private close(): void { if (this.draft?.isDirty()) { void this.confirm("Exit with an unsaved draft? It will be offered again on this device.").then((ok) => { if (ok) this.finishClose(); }); } else this.finishClose(); }
  private finishClose(): void { window.removeEventListener("beforeunload", this.guard); this.viewportEditor?.dispose(); this.viewportEditor = null; this.viewport?.dispose(); this.viewport = null; this.root?.remove(); this.root = null; this.onClose(); }
}
