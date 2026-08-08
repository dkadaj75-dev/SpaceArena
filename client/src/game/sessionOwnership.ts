import type { ConfigService } from "@space-arena/shared";
import type { AuthService } from "../core/AuthService.js";
import { HangarApi } from "./HangarApi.js";
import { createOwnershipStore, type OwnershipStore } from "./ownershipStore.js";

/**
 * The session's ownership store, across a login.
 *
 * `createOwnershipStore` picks its backing ONCE, from whether it was handed an
 * api — but a session crosses that line at runtime: the boot screen's "Skip
 * (offline practice)" starts anonymous on the local ledger, and a later guest
 * login has a server ledger to read. The screens hold their store for the whole
 * session, so the swap has to happen underneath them rather than by handing
 * them a new object.
 *
 * Everything else is pass-through: this owns WHICH ledger answers, never what
 * the answer is.
 */
class SessionOwnershipStore implements OwnershipStore {
  private backing: OwnershipStore;
  private authed: boolean;
  private readonly listeners = new Set<() => void>();
  private unbindBacking: () => void;
  private readonly unbindAuth: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly configs: ConfigService,
  ) {
    this.authed = this.isAuthed();
    this.backing = this.build(this.authed);
    this.unbindBacking = this.backing.onChange(() => this.emit());
    this.unbindAuth = this.auth.onChange(() => this.syncBacking());
  }

  private isAuthed(): boolean {
    return this.auth.getState().status === "authed";
  }

  private build(authed: boolean): OwnershipStore {
    // An unauthenticated api would answer every read with `unauthorized`, so
    // anonymous play gets the offline ledger — contract §3.
    return createOwnershipStore({ api: authed ? new HangarApi(this.auth) : null, configs: this.configs });
  }

  private syncBacking(): void {
    const authed = this.isAuthed();
    if (authed === this.authed) return;
    this.authed = authed;
    this.unbindBacking();
    this.backing = this.build(authed);
    this.unbindBacking = this.backing.onChange(() => this.emit());
    // The new ledger is empty until it is read; the screens repaint off the
    // notification, not off the swap.
    void this.backing.refresh().then(
      () => this.emit(),
      () => this.emit(),
    );
  }

  refresh(): Promise<void> {
    return this.backing.refresh();
  }
  ownedShips(): ReadonlySet<string> {
    return this.backing.ownedShips();
  }
  ownedModules(): ReadonlySet<string> {
    return this.backing.ownedModules();
  }
  ownedCosmetics(): ReadonlySet<string> {
    return this.backing.ownedCosmetics();
  }
  selectedCosmetic(shipId: string): string | null {
    return this.backing.selectedCosmetic(shipId);
  }
  credits(): number {
    return this.backing.credits();
  }
  buyShip(id: string): Promise<void> {
    return this.backing.buyShip(id);
  }
  buyModule(id: string): Promise<void> {
    return this.backing.buyModule(id);
  }
  buyCosmetic(id: string): Promise<void> {
    return this.backing.buyCosmetic(id);
  }
  selectCosmetic(shipId: string, cosmeticId: string | null): Promise<void> {
    return this.backing.selectCosmetic(shipId, cosmeticId);
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.unbindAuth();
    this.unbindBacking();
    this.listeners.clear();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export type SessionOwnership = OwnershipStore & { dispose(): void };

/** The one ownership store a session runs on. */
export function createSessionOwnership(auth: AuthService, configs: ConfigService): SessionOwnership {
  return new SessionOwnershipStore(auth, configs);
}
