import {
  cosmeticAppliesTo,
  createLogger,
  baseCosmeticIdFor,
  resolveCosmeticFor,
  type ConfigService,
  type CosmeticConfig,
} from "@space-arena/shared";
import { HangarApiError, type HangarApi } from "./HangarApi.js";
import {
  buyCosmeticLocal,
  buyModuleLocal,
  buyShipLocal,
  ownedCosmetics as localCosmetics,
  ownedModules as localModules,
  ownedShips as localShips,
  selectCosmeticLocal,
  selectedCosmetic as localSelectedCosmetic,
} from "./offlineOwnership.js";

const log = createLogger("ownershipStore");

/**
 * The ONE seam the Shop and the Hangar talk to about what a pilot owns.
 *
 * Online and offline are the same interface on purpose: the buy step is real in
 * both (only the cost is not — see `offlineOwnership.ts`), so a screen that has
 * to branch on "are we signed in" would be branching on the wrong thing. The
 * backing store is chosen once, at construction.
 *
 * Reads are SYNCHRONOUS and served from a cached snapshot; writes are async and
 * refresh that cache before resolving, so a caller that awaits a buy and then
 * re-reads sees the purchase. Every mutation notifies {@link onChange}.
 */
export interface OwnershipStore {
  refresh(): Promise<void>;
  ownedShips(): ReadonlySet<string>;
  ownedModules(): ReadonlySet<string>;
  ownedCosmetics(): ReadonlySet<string>;
  selectedCosmetic(shipId: string): string;
  credits(): number; // for the header readout
  buyShip(id: string): Promise<void>;
  buyModule(id: string): Promise<void>;
  buyCosmetic(id: string): Promise<void>;
  selectCosmetic(shipId: string, cosmeticId: string | null): Promise<void>;
  onChange(fn: () => void): () => void;
}

interface Snapshot {
  ships: Set<string>;
  modules: Set<string>;
  cosmetics: Set<string>;
  selections: Map<string, string>;
  credits: number;
}

function emptySnapshot(): Snapshot {
  return { ships: new Set(), modules: new Set(), cosmetics: new Set(), selections: new Map(), credits: 0 };
}

/**
 * Applicability gate shared by both backings. Ownership is enforced by whoever
 * holds the ledger (the server, or `offlineOwnership`); this is the rule that
 * needs CONTENT, so it lives here rather than being duplicated in each.
 */
function appliesTo(configs: Pick<ConfigService, "get">, cosmeticId: string, shipId: string): boolean {
  const cosmetic = configs.get<CosmeticConfig>("cosmetic", cosmeticId);
  return !!cosmetic && cosmeticAppliesTo(cosmetic, shipId);
}

abstract class BaseOwnershipStore implements OwnershipStore {
  protected snapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();

  constructor(protected readonly configs: ConfigService) {}

  abstract refresh(): Promise<void>;
  protected abstract commitBuyShip(id: string): Promise<void>;
  protected abstract commitBuyModule(id: string): Promise<void>;
  protected abstract commitBuyCosmetic(id: string): Promise<void>;
  protected abstract commitSelect(shipId: string, cosmeticId: string | null): Promise<void>;

  ownedShips(): ReadonlySet<string> {
    return this.snapshot.ships;
  }

  ownedModules(): ReadonlySet<string> {
    return this.snapshot.modules;
  }

  ownedCosmetics(): ReadonlySet<string> {
    return this.snapshot.cosmetics;
  }

  selectedCosmetic(shipId: string): string {
    const selected = this.snapshot.selections.get(shipId);
    const resolved = resolveCosmeticFor(this.configs, shipId, selected);
    return this.snapshot.cosmetics.has(resolved) ? resolved : baseCosmeticIdFor(shipId);
  }

  credits(): number {
    return this.snapshot.credits;
  }

  async buyShip(id: string): Promise<void> {
    await this.commitBuyShip(id);
    await this.refresh();
    this.emit();
  }

  async buyModule(id: string): Promise<void> {
    await this.commitBuyModule(id);
    await this.refresh();
    this.emit();
  }

  async buyCosmetic(id: string): Promise<void> {
    await this.commitBuyCosmetic(id);
    await this.refresh();
    this.emit();
  }

  async selectCosmetic(shipId: string, cosmeticId: string | null): Promise<void> {
    if (cosmeticId !== null && !appliesTo(this.configs, cosmeticId, shipId)) {
      throw new Error(`${cosmeticId} cannot be equipped on ${shipId}`);
    }
    await this.commitSelect(shipId, cosmeticId);
    await this.refresh();
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Authenticated backing: the server's ledger is the truth, cached per refresh. */
class ApiOwnershipStore extends BaseOwnershipStore {
  constructor(
    configs: ConfigService,
    private readonly api: HangarApi,
  ) {
    super(configs);
  }

  async refresh(): Promise<void> {
    const { profile, inventory } = await this.api.inventory();
    this.snapshot = {
      ships: new Set(inventory.ships),
      modules: new Set(inventory.modules),
      cosmetics: new Set(inventory.cosmetics),
      selections: new Map(Object.entries(inventory.selections)),
      credits: profile.credits,
    };
  }

  protected async commitBuyShip(id: string): Promise<void> {
    await this.api.buyShip(id);
  }

  protected async commitBuyModule(id: string): Promise<void> {
    try {
      await this.api.buyModule(id);
    } catch (err) {
      // `/api/modules/buy` predates the shop and answers a repeat buy with 409
      // rather than the idempotent success the hull/paint routes give. Owning it
      // already is the outcome the caller asked for, so it is not an error here.
      if (err instanceof HangarApiError && err.code === "already-owned") {
        log.info("module already owned; treating the buy as a no-op", { id });
        return;
      }
      throw err;
    }
  }

  protected async commitBuyCosmetic(id: string): Promise<void> {
    await this.api.buyCosmetic(id);
  }

  protected async commitSelect(shipId: string, cosmeticId: string | null): Promise<void> {
    await this.api.selectCosmetic(shipId, cosmeticId);
  }
}

/**
 * Offline backing: the localStorage ledger. Credits are 0 and stay 0 — there is
 * no offline wallet to spend from, and inventing one would make the header read
 * a number the server would never agree with.
 */
class LocalOwnershipStore extends BaseOwnershipStore {
  async refresh(): Promise<void> {
    const ships = localShips();
    const selections = new Map<string, string>();
    for (const shipId of ships) {
      selections.set(shipId, localSelectedCosmetic(this.configs, shipId));
    }
    this.snapshot = {
      ships,
      modules: localModules(this.configs),
      cosmetics: localCosmetics(this.configs),
      selections,
      credits: 0,
    };
  }

  protected async commitBuyShip(id: string): Promise<void> {
    buyShipLocal(id);
  }

  protected async commitBuyModule(id: string): Promise<void> {
    buyModuleLocal(id);
  }

  protected async commitBuyCosmetic(id: string): Promise<void> {
    buyCosmeticLocal(id);
  }

  protected async commitSelect(shipId: string, cosmeticId: string | null): Promise<void> {
    selectCosmeticLocal(this.configs, shipId, cosmeticId);
  }
}

/**
 * Build the store for this session. `api: null` (or an unauthenticated one)
 * gets the offline ledger. The returned store is EMPTY until the first
 * {@link OwnershipStore.refresh} resolves — callers must await it before
 * rendering, exactly as the Hangar awaits its own read.
 */
export function createOwnershipStore(opts: { api: HangarApi | null; configs: ConfigService }): OwnershipStore {
  return opts.api ? new ApiOwnershipStore(opts.configs, opts.api) : new LocalOwnershipStore(opts.configs);
}
