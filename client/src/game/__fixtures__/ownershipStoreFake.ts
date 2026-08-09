import type { OwnershipStore } from "../ownershipStore.js";

/**
 * TEST DOUBLE for the ownership seam (contract §3), used by the shop, lobby and
 * hangar-gating suites. It implements the shipped interface rather than a
 * convenient subset, so a drift between the shop and the real store is a
 * compile error here rather than a runtime surprise in the screen.
 *
 * Deliberately synchronous under the promises: these suites are about what the
 * UI does with the ledger, not about transport.
 */
export interface FakeStoreSeed {
  ships?: string[];
  modules?: string[];
  cosmetics?: string[];
  selections?: Record<string, string>;
  credits?: number;
  /** Rejects every mutation with this message — the error-notice path. */
  failWith?: string;
  /** Held promises: resolve manually to assert the optimistic-disabled window. */
  manual?: boolean;
}

export class FakeOwnershipStore implements OwnershipStore {
  readonly calls: string[] = [];
  refreshes = 0;
  private readonly listeners = new Set<() => void>();
  private readonly ships: Set<string>;
  private readonly modules: Set<string>;
  private readonly cosmetics: Set<string>;
  private readonly selections: Map<string, string | null>;
  private creditBalance: number;
  /** Resolver for the pending mutation while `manual` is set. */
  private release: (() => void) | null = null;

  constructor(private readonly seed: FakeStoreSeed = {}) {
    this.ships = new Set(seed.ships ?? []);
    this.modules = new Set(seed.modules ?? []);
    this.cosmetics = new Set(seed.cosmetics ?? []);
    this.selections = new Map(Object.entries(seed.selections ?? {}));
    this.creditBalance = seed.credits ?? 0;
  }

  refresh(): Promise<void> {
    this.refreshes++;
    return Promise.resolve();
  }
  ownedShips(): ReadonlySet<string> {
    return this.ships;
  }
  ownedModules(): ReadonlySet<string> {
    return this.modules;
  }
  ownedCosmetics(): ReadonlySet<string> {
    return this.cosmetics;
  }
  selectedCosmetic(shipId: string): string {
    return this.selections.get(shipId) ?? `cosmetic.paint-${shipId.split(".").pop()}-standard`;
  }
  credits(): number {
    return this.creditBalance;
  }
  buyShip(id: string): Promise<void> {
    return this.mutate(`buyShip:${id}`, () => this.ships.add(id));
  }
  buyModule(id: string): Promise<void> {
    return this.mutate(`buyModule:${id}`, () => this.modules.add(id));
  }
  buyCosmetic(id: string): Promise<void> {
    return this.mutate(`buyCosmetic:${id}`, () => this.cosmetics.add(id));
  }
  selectCosmetic(shipId: string, cosmeticId: string | null): Promise<void> {
    return this.mutate(`selectCosmetic:${shipId}:${cosmeticId ?? "null"}`, () =>
      this.selections.set(shipId, cosmeticId),
    );
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve the mutation held open by `manual`. */
  settle(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }

  private mutate(call: string, apply: () => void): Promise<void> {
    this.calls.push(call);
    if (this.seed.failWith) return Promise.reject(new Error(this.seed.failWith));
    const commit = (): void => {
      apply();
      for (const fn of this.listeners) fn();
    };
    if (!this.seed.manual) {
      commit();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.release = () => {
        commit();
        resolve();
      };
    });
  }
}
