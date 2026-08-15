import type { ConfigError, ContentBundle } from "@space-arena/shared";
import type { EditorRepository } from "./repository/EditorRepository.js";
import { EditorRepositoryError } from "./repository/EditorRepository.js";
import { DraftPackStore } from "./DraftPackStore.js";
import { GenericConfigPanel } from "./GenericConfigPanel.js";
import "./editor.css";

export class ConstellationApp {
  private root: HTMLDivElement | null = null;
  private draft: DraftPackStore | null = null;
  private problems: ConfigError[] = [];
  private status = document.createElement("span");
  private publishButton = document.createElement("button");
  private problemList = document.createElement("div");

  constructor(private readonly repository: EditorRepository, private readonly onClose: () => void) {}

  async open(): Promise<void> {
    const bundle = await this.repository.load();
    this.draft = DraftPackStore.restore(bundle);
    this.root = document.createElement("div"); this.root.className = "sa-editor constellation-standalone"; this.root.dataset.sheet = "full";
    this.root.append(this.topbar(), this.workspace(), this.actionbar()); document.body.append(this.root);
    this.draft.onChange(() => this.update()); await this.preflight(); this.update();
    window.addEventListener("beforeunload", this.guard);
  }

  private topbar(): HTMLElement {
    const bar = document.createElement("header"); bar.className = "ed-topbar";
    const brand = document.createElement("div"); brand.className = "ed-brand"; brand.textContent = "Constellation · Design Tools";
    this.status.className = "constellation-status";
    const close = this.button("Exit", "ed-btn ed-btn--danger", () => this.close());
    bar.append(brand, this.status, close); return bar;
  }

  private workspace(): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "constellation-workspace";
    const panel = new GenericConfigPanel(this.draft!, (errors) => { this.problems = errors; this.renderProblems(); this.update(); });
    this.problemList.className = "constellation-problems"; this.problemList.setAttribute("aria-live", "polite");
    wrap.append(panel.element, this.problemList); return wrap;
  }

  private actionbar(): HTMLElement {
    const bar = document.createElement("footer"); bar.className = "constellation-actions";
    this.publishButton = this.button("Preflight & Publish live", "ed-btn", () => void this.publish());
    const download = this.button("Download exact draft", "ed-btn", () => void this.download());
    const importInput = document.createElement("input"); importInput.type = "file"; importInput.accept = ".json,application/json"; importInput.hidden = true;
    importInput.addEventListener("change", () => { const file = importInput.files?.[0]; if (file) void this.import(file); });
    const importButton = this.button("Import JSON pack", "ed-btn", () => importInput.click());
    const discard = this.button("Discard draft", "ed-btn", () => { this.draft!.discard(); void this.preflight(); });
    const undo = this.button("Undo", "ed-btn", () => { this.draft!.undo(); this.rebuildWorkspace(); }); undo.dataset.action = "undo";
    const redo = this.button("Redo", "ed-btn", () => { this.draft!.redo(); this.rebuildWorkspace(); }); redo.dataset.action = "redo";
    const rollback = this.button("Roll back live", "ed-btn ed-btn--danger", () => void this.rollback());
    bar.append(undo, redo, this.publishButton, download, importButton, importInput, discard, rollback); return bar;
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

  private async import(file: File): Promise<void> {
    try {
      const raw = JSON.parse(await file.text()) as ContentBundle;
      const imported = new DraftPackStore(raw); const result = await imported.preflight();
      if (!result.ok) { this.problems = result.errors; this.renderProblems(); this.message("Imported pack is invalid; current draft was preserved."); return; }
      this.draft = imported; this.root?.querySelector(".constellation-workspace")?.replaceWith(this.workspace()); this.update();
    } catch { this.message("Import failed: choose a valid Orion's Arm JSON content pack."); }
  }

  private renderProblems(): void {
    if (!this.problems.length) { this.problemList.textContent = "Whole-pack preflight clean."; return; }
    const title = document.createElement("strong"); title.textContent = `${this.problems.length} publish blocker(s)`;
    this.problemList.replaceChildren(title, ...this.problems.map((error) => { const row = document.createElement("button"); row.type = "button"; row.className = "constellation-problem"; row.textContent = `${error.file} → ${error.path}: ${error.message}`; return row; }));
  }

  private update(): void { if (!this.draft) return; this.status.textContent = `${this.draft.dirtyCount()} changed file(s) · base ${this.draft.base.sourceHash.slice(0, 15)}…`; this.publishButton.disabled = this.problems.length > 0 || !this.draft.isDirty(); const undo = this.root?.querySelector<HTMLButtonElement>('[data-action="undo"]'); const redo = this.root?.querySelector<HTMLButtonElement>('[data-action="redo"]'); if (undo) undo.disabled = !this.draft.canUndo(); if (redo) redo.disabled = !this.draft.canRedo(); }
  private rebuildWorkspace(): void { this.root?.querySelector(".constellation-workspace")?.replaceWith(this.workspace()); void this.preflight(); }
  private message(text: string): void { this.status.textContent = text; }
  private handle(error: unknown): void { if (error instanceof EditorRepositoryError && error.errors.length) { this.problems = error.errors; this.renderProblems(); } this.message(error instanceof Error ? error.message : "Operation failed"); }
  private button(label: string, className: string, action: () => void): HTMLButtonElement { const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label; button.addEventListener("click", action); return button; }
  private confirm(message: string): Promise<boolean> { return new Promise((resolve) => { const dialog = document.createElement("dialog"); dialog.className = "constellation-confirm"; const copy = document.createElement("p"); copy.textContent = message; const no = this.button("Cancel", "ed-btn", () => { dialog.close(); resolve(false); }); const yes = this.button("Confirm", "ed-btn ed-btn--danger", () => { dialog.close(); resolve(true); }); dialog.append(copy, no, yes); document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove()); dialog.showModal(); }); }
  private guard = (event: BeforeUnloadEvent): void => { if (this.draft?.isDirty()) { event.preventDefault(); event.returnValue = ""; } };
  private close(): void { if (this.draft?.isDirty()) { void this.confirm("Exit with an unsaved draft? It will be offered again on this device.").then((ok) => { if (ok) this.finishClose(); }); } else this.finishClose(); }
  private finishClose(): void { window.removeEventListener("beforeunload", this.guard); this.root?.remove(); this.root = null; this.onClose(); }
}
