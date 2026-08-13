import type { RenderRecipe } from "@space-arena/shared";
import type { AssetRegistry } from "./AssetRegistry.js";

export interface ModelLoadJob { id: string; render: RenderRecipe }
interface PendingJob extends ModelLoadJob { promise: Promise<void>; resolve: () => void }
export interface ModelLoadQueueOptions { gapMs?: number; isPaused?: () => boolean }

/** One-at-a-time, gap-throttled background model loader shared by Hangar/Shop. */
export class ModelLoadQueue {
  private readonly pending: PendingJob[] = [];
  private readonly byId = new Map<string, PendingJob>();
  private readonly loaded = new Set<string>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly gapMs: number;
  private readonly isPaused: () => boolean;

  constructor(private readonly assets: AssetRegistry, options: ModelLoadQueueOptions = {}) {
    this.gapMs = options.gapMs ?? 250;
    this.isPaused = options.isPaused ?? (() => false);
  }

  hasLoaded(id: string): boolean { return this.loaded.has(id); }
  enqueue(job: ModelLoadJob): Promise<void> { return this.insert(job, false); }

  prioritize(job: ModelLoadJob): Promise<void> {
    const existing = this.byId.get(job.id);
    if (existing) {
      const index = this.pending.indexOf(existing);
      if (index > 0) { this.pending.splice(index, 1); this.pending.unshift(existing); }
      return existing.promise;
    }
    return this.insert(job, true);
  }

  /** Phase one has no throttle or artificial minimum duration. */
  async loadBlocking(jobs: readonly ModelLoadJob[]): Promise<void> {
    await Promise.all(jobs.map(async (job) => {
      if (this.loaded.has(job.id)) return;
      const queued = this.byId.get(job.id);
      if (queued) {
        const index = this.pending.indexOf(queued);
        if (index < 0) { await queued.promise; return; }
        this.pending.splice(index, 1);
      }
      await this.assets.ensureModel(job.render);
      this.loaded.add(job.id);
      if (queued) { this.byId.delete(job.id); queued.resolve(); }
    }));
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    for (const job of this.pending) job.resolve();
    this.timer = null;
    this.pending.length = 0;
    this.byId.clear();
  }

  private insert(job: ModelLoadJob, front: boolean): Promise<void> {
    if (this.loaded.has(job.id)) return Promise.resolve();
    const existing = this.byId.get(job.id);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const pending = { ...job, promise, resolve };
    this.byId.set(job.id, pending);
    if (front) this.pending.unshift(pending);
    else this.pending.push(pending);
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.running || this.timer !== null || this.pending.length === 0) return;
    if (this.isPaused()) { this.schedule(); return; }
    const job = this.pending.shift()!;
    this.running = true;
    void this.assets.ensureModel(job.render).finally(() => {
      this.running = false;
      this.loaded.add(job.id);
      this.byId.delete(job.id);
      job.resolve();
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.pending.length === 0) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.gapMs);
  }
}
