import { computeSourceHash, validateBundle, type BundleValidation, type ContentBundle } from "@space-arena/shared";

const KEY_PREFIX = "sa.constellation.draft.";
export type DraftListener = () => void;

export class DraftPackStore {
  readonly base: ContentBundle;
  private bundle: ContentBundle;
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<DraftListener>();

  constructor(bundle: ContentBundle) {
    this.base = structuredClone(bundle);
    this.bundle = structuredClone(bundle);
  }

  static restore(base: ContentBundle): DraftPackStore {
    const store = new DraftPackStore(base);
    try {
      const raw = localStorage.getItem(KEY_PREFIX + base.sourceHash);
      if (raw) store.bundle = JSON.parse(raw) as ContentBundle;
    } catch { /* Safari private mode or stale JSON: start clean. */ }
    for (const [path, value] of Object.entries(store.bundle.files)) {
      if (JSON.stringify(value) !== JSON.stringify(base.files[path])) store.dirty.add(path);
    }
    return store;
  }

  snapshot(): ContentBundle { return structuredClone(this.bundle); }
  dirtyCount(): number { return this.dirty.size; }
  isDirty(): boolean { return this.dirty.size > 0; }
  onChange(listener: DraftListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  setFile(path: string, value: unknown): void {
    this.bundle.files[path] = structuredClone(value);
    if (JSON.stringify(value) === JSON.stringify(this.base.files[path])) this.dirty.delete(path); else this.dirty.add(path);
    this.persist();
  }

  deleteFile(path: string): void {
    delete this.bundle.files[path];
    const manifest = this.bundle.manifest as { files: string[] };
    manifest.files = manifest.files.filter((file) => file !== path);
    this.dirty.add(path); this.persist();
  }

  addFile(path: string, value: unknown): void {
    this.bundle.files[path] = structuredClone(value);
    const manifest = this.bundle.manifest as { files: string[] };
    if (!manifest.files.includes(path)) manifest.files.push(path);
    this.dirty.add(path); this.persist();
  }

  discard(): void { this.bundle = structuredClone(this.base); this.dirty.clear(); this.persist(); }

  async preflight(): Promise<BundleValidation> {
    const candidate = this.snapshot();
    candidate.sourceHash = await computeSourceHash(candidate.manifest, candidate.files);
    return validateBundle(candidate);
  }

  async publishable(): Promise<ContentBundle> {
    const candidate = this.snapshot();
    const manifest = candidate.manifest as { version?: number };
    manifest.version = Math.max(candidate.packVersion + 1, (manifest.version ?? 0) + 1);
    candidate.packVersion = manifest.version;
    candidate.generatedAt = new Date().toISOString();
    candidate.sourceHash = await computeSourceHash(candidate.manifest, candidate.files);
    return candidate;
  }

  private persist(): void {
    try {
      if (this.dirty.size) localStorage.setItem(KEY_PREFIX + this.base.sourceHash, JSON.stringify(this.bundle));
      else localStorage.removeItem(KEY_PREFIX + this.base.sourceHash);
    } catch { /* draft still remains in memory */ }
    for (const listener of this.listeners) listener();
  }
}
