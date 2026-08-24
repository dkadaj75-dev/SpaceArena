import {
  createLogger,
  type ConfigEvents,
  type ConfigService,
  type EventBus,
  type ThemeConfig,
} from "@space-arena/shared";
import type { OwnershipStore } from "../ownershipStore.js";
import {
  equipHint,
  matchesShopFilter,
  moduleGroups,
  paintEntries,
  priceLabel,
  selectionValueFor,
  shipEntries,
  SHOP_TABS,
  type PaintEntry,
  type ShopEntry,
  type ShopTab,
} from "../shopModel.js";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";
import { injectShopStyle } from "./shopStyle.js";

const log = createLogger("Shop");

const THEME_ID = "theme.default";

/** What the server would judge a purchase against: the pilot's own numbers. */
export interface ShopPilot {
  level: number;
}

export interface ShopCallbacks {
  onClose: () => void;
  /**
   * The signed-in pilot, or null when there is no account.
   *
   * Null is not "level 0" — it is "nobody is enforcing anything here". The
   * offline ledger has no level and a permanently-zero wallet (see
   * `ownershipStore.ts`), and gating against that would lock a shop where
   * every purchase is free. Absent entirely for callers that predate the gate,
   * which behave exactly as they did.
   */
  pilot?: () => ShopPilot | null;
}

/** Why a Buy button is off, or "" when it is not. */
type BuyBlock = "" | "level" | "credits";

/**
 * The shop (contract §5) — hulls, modules and paints, bought through the
 * ownership store and nothing else.
 *
 * The screen holds no ownership state of its own: every render asks the store
 * what is owned, so an offline ledger write and a server round-trip land on
 * screen by exactly the same path. Actions are OPTIMISTICALLY DISABLED rather
 * than optimistically applied — a purchase is a credit movement, and showing it
 * as done before the store confirms would be lying about the one part of the
 * flow that is real (see `offlineOwnership.ts`: the buy step is real, only the
 * cost is not).
 */
export class ShopScreen {
  private readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly creditsEl: HTMLSpanElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly filterEl: HTMLDivElement;
  private readonly filterInput: HTMLInputElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribeTheme: (() => void) | null = null;
  private tab: ShopTab = "ships";
  /** The action in flight, as `kind:id` — non-null disables every action. */
  private pending: string | null = null;
  private notice = "";
  /** Live text filter over the current tab's list; "" shows everything. */
  private filter = "";

  constructor(
    parent: HTMLElement,
    private readonly configs: ConfigService,
    private readonly store: OwnershipStore,
    private readonly callbacks: ShopCallbacks,
    bus?: EventBus<ConfigEvents>,
  ) {
    injectScreenStyle();
    injectShopStyle();

    this.root = document.createElement("div");
    this.root.className = "shop-overlay game-screen sa-screen sa-menu";
    this.root.style.zIndex = "30";
    this.root.append(createMenuBackdrop());

    this.header = document.createElement("div");
    this.header.className = "sa-screen-header";
    const credits = document.createElement("span");
    credits.className = "sa-menu-account shop-credits";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = "Credits";
    this.creditsEl = document.createElement("span");
    this.creditsEl.className = "v";
    credits.append(k, this.creditsEl);
    const close = document.createElement("button");
    close.className = "sa-screen-chip shop-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.callbacks.onClose());
    this.header.append(credits, close);
    this.root.append(this.header);

    const titleWrap = document.createElement("div");
    titleWrap.className = "sa-menu-titlewrap";
    const title = document.createElement("h1");
    title.className = "sa-screen-title";
    title.textContent = "Shop";
    const subtitle = document.createElement("div");
    subtitle.className = "sa-menu-subtitle";
    subtitle.textContent = "Requisition";
    const rule = document.createElement("div");
    rule.className = "sa-menu-rule";
    titleWrap.append(title, subtitle, rule);
    this.root.append(titleWrap);

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "shop-tabs sa-tab-group";
    this.tabsEl.setAttribute("role", "tablist");
    this.root.append(this.tabsEl);

    // Above the list, outside the re-rendered body: the grid is rebuilt on
    // every keystroke, and a box that was rebuilt with it would lose focus and
    // the caret mid-word.
    this.filterEl = document.createElement("div");
    this.filterEl.className = "shop-filter";
    this.filterInput = document.createElement("input");
    this.filterInput.type = "search";
    this.filterInput.className = "shop-filter-input";
    this.filterInput.dataset["shopFilter"] = "";
    this.filterInput.setAttribute("aria-label", "Filter this list");
    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value;
      this.render();
    });
    this.filterEl.append(this.filterInput);
    this.root.append(this.filterEl);

    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "shop-notice";
    this.noticeEl.setAttribute("role", "status");
    this.root.append(this.noticeEl);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "shop-body";
    this.root.append(this.bodyEl);

    parent.append(this.root);

    this.applyTheme();
    if (bus) {
      this.unsubscribeTheme = bus.on("config:changed", (evt) => {
        if (evt.type === "theme") this.applyTheme();
      });
    }
    // The store is the single source of truth: a purchase re-renders because
    // the LEDGER changed, never because the click handler said so.
    this.unsubscribeStore = this.store.onChange(() => {
      if (this.isVisible) this.render();
    });

    this.root.style.display = "none";
    this.render();
  }

  private get isVisible(): boolean {
    return this.root.style.display !== "none";
  }

  /** Whether the screen is on — a re-`show()` would reset the tab and refetch. */
  get isOpen(): boolean {
    return this.isVisible;
  }

  private applyTheme(): void {
    applyMenuTheme(this.root, this.configs.get<ThemeConfig>("theme", THEME_ID));
  }

  show(): void {
    this.notice = "";
    this.pending = null;
    this.setFilter("");
    this.root.style.display = "flex";
    this.root.scrollTop = 0;
    this.render();
    // A visit re-reads ownership: another device (or the Hangar) may have
    // bought something since this screen was last open.
    void this.store.refresh().catch((err: unknown) => {
      log.warn("ownership refresh failed", err);
      this.fail(err, "Could not read your inventory");
    });
  }

  hide(): void {
    this.root.style.display = "none";
  }

  dispose(): void {
    this.unsubscribeStore();
    this.unsubscribeTheme?.();
    this.root.remove();
  }

  /** Which tab is showing — the screenshot rig and tests drive this directly. */
  selectTab(tab: ShopTab): void {
    this.tab = tab;
    this.notice = "";
    // A filter typed against modules would silently hide most of the paints.
    this.setFilter("");
    this.render();
  }

  private setFilter(value: string): void {
    this.filter = value;
    this.filterInput.value = value;
  }

  private render(): void {
    this.creditsEl.textContent = `${this.store.credits()} cr`;
    this.renderTabs();
    // Two hulls need no search box; 58 modules and 36 paints do (finding 46).
    this.filterEl.hidden = this.tab === "ships";
    this.filterInput.placeholder = this.tab === "modules" ? "Filter modules…" : "Filter paints…";
    this.noticeEl.textContent = this.notice;
    this.noticeEl.classList.toggle("visible", this.notice.length > 0);

    const grid = document.createElement("div");
    grid.className = "shop-grid";
    grid.dataset["tab"] = this.tab;
    if (this.tab === "ships") this.renderShips(grid);
    else if (this.tab === "modules") this.renderModules(grid);
    else this.renderPaints(grid);
    this.bodyEl.replaceChildren(grid);
  }

  /**
   * What the server would say about this purchase, decided BEFORE the tap.
   *
   * Both refusals were invisible until the request came back: a level-locked
   * module offered a fully enabled "Buy · 1500 cr" and answered with a 403
   * (finding 43), and there was no affordability state at all — zero disabled
   * buy buttons among 58 cards on a 250 cr balance (finding 45). The server
   * stays the backstop; this is only the part the player can see.
   */
  private blockFor(entry: ShopEntry): BuyBlock {
    if (entry.state !== "buy") return "";
    const pilot = this.callbacks.pilot?.() ?? null;
    if (!pilot) return "";
    if (entry.requiresLevel !== undefined && entry.requiresLevel > pilot.level) return "level";
    return entry.price > this.store.credits() ? "credits" : "";
  }

  private renderTabs(): void {
    this.tabsEl.replaceChildren();
    for (const { tab, label } of SHOP_TABS) {
      const btn = document.createElement("button");
      btn.className = "sa-tab";
      btn.type = "button";
      btn.textContent = label;
      btn.dataset["tab"] = tab;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(tab === this.tab));
      btn.addEventListener("click", () => this.selectTab(tab));
      this.tabsEl.append(btn);
    }
  }

  private renderShips(grid: HTMLDivElement): void {
    const entries = shipEntries(this.configs, this.store);
    if (entries.length === 0) {
      grid.append(hint("shop-empty", "No hulls in this content pack."));
      return;
    }
    for (const entry of entries) {
      const card = this.card(entry);
      card.append(this.actions(entry, "ship", () => this.store.buyShip(entry.id), "Owned"));
      grid.append(card);
    }
  }

  private renderModules(grid: HTMLDivElement): void {
    const groups = moduleGroups(this.configs, this.store);
    if (groups.length === 0) {
      grid.append(hint("shop-empty", "No modules in this content pack."));
      return;
    }
    // A family whose every module was filtered out loses its heading too — a
    // bare "KINETIC" over nothing reads as a list that failed to load.
    const matched = groups
      .map((group) => ({ ...group, entries: group.entries.filter((e) => matchesShopFilter(e, this.filter)) }))
      .filter((group) => group.entries.length > 0);
    if (matched.length === 0) {
      grid.append(hint("shop-empty", `No modules match “${this.filter.trim()}”.`));
      return;
    }
    for (const group of matched) {
      grid.append(hint("shop-group-title", group.title));
      for (const entry of group.entries) {
        const card = this.card(entry);
        card.append(this.actions(entry, "module", () => this.store.buyModule(entry.id), "Owned"));
        grid.append(card);
      }
    }
  }

  private renderPaints(grid: HTMLDivElement): void {
    const all = paintEntries(this.configs, this.store);
    if (all.length === 0) {
      grid.append(hint("shop-empty", "No paints in this content pack."));
      return;
    }
    const entries = all.filter((entry) => matchesShopFilter(entry, this.filter));
    if (entries.length === 0) {
      grid.append(hint("shop-empty", `No paints match “${this.filter.trim()}”.`));
      return;
    }
    for (const entry of entries) {
      const card = this.card(entry, swatch(entry));
      if (entry.state === "buy") {
        card.append(
          this.equipRow(entry),
          this.actions(
            entry,
            "cosmetic",
            async () => {
              await this.store.buyCosmetic(entry.id);
              if (entry.target.kind === "ship" && entry.target.owned) {
                await this.store.selectCosmetic(entry.target.shipId, entry.id);
              }
            },
            "In locker",
          ),
        );
      } else {
        // Both rows: the badge answers "is this on a hull", the row answers
        // "on which one" — a bought paint sitting in the locker looks nothing
        // like a worn one.
        card.append(
          this.equipRow(entry),
          this.actions(entry, "cosmetic", () => this.store.buyCosmetic(entry.id), "In locker"),
        );
      }
      grid.append(card);
    }
  }

  /** The shared card shell: name, price chip, sub-line, stat chips. */
  private card(entry: ShopEntry, lead?: HTMLElement): HTMLDivElement {
    const block = this.blockFor(entry);
    const card = document.createElement("div");
    card.className = "shop-card";
    card.dataset["state"] = entry.state;
    card.dataset["entry"] = entry.id;
    if (block) card.dataset["blocked"] = block;
    if (lead) card.append(lead);

    const head = document.createElement("div");
    head.className = "shop-card-head";
    const name = document.createElement("span");
    name.className = "shop-card-name";
    name.textContent = entry.name;
    const price = document.createElement("span");
    price.className = "shop-price";
    price.dataset["free"] = String(entry.price <= 0);
    // A price you cannot meet is the bad number on the card, and it is the one
    // the pilot is comparing against the balance in the header.
    price.dataset["afford"] = String(block !== "credits");
    price.textContent = priceLabel(entry.price);
    head.append(name, price);
    card.append(head, hint("shop-card-sub", entry.sub));
    if (block) card.append(hint("shop-card-blocked", this.blockReason(entry, block)));

    if (entry.chips.length > 0) {
      const chips = document.createElement("div");
      chips.className = "shop-chips";
      for (const chip of entry.chips) {
        const el = document.createElement("span");
        el.className = "shop-chip";
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = chip.label;
        const v = document.createElement("span");
        v.className = "v";
        v.textContent = chip.value;
        el.append(k, v);
        chips.append(el);
      }
      card.append(chips);
    }
    return card;
  }

  /** OWNED badge, or the buy button for what is still on the shelf. */
  private actions(entry: ShopEntry, kind: string, buy: () => Promise<void>, ownedLabel: string): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "shop-card-actions";
    if (entry.state !== "buy") {
      const badge = document.createElement("div");
      badge.className = "shop-badge";
      badge.dataset["state"] = entry.state;
      badge.textContent = entry.state === "equipped" ? "Equipped" : ownedLabel;
      row.append(badge);
      return row;
    }
    const key = `${kind}:${entry.id}`;
    const block = this.blockFor(entry);
    const btn = document.createElement("button");
    btn.className = "sa-button sa-button--primary shop-buy";
    btn.type = "button";
    btn.textContent =
      this.pending === key
        ? "Buying…"
        : block === "level"
          ? `Requires Lv ${entry.requiresLevel}`
          : `Buy · ${priceLabel(entry.price)}`;
    btn.disabled = this.pending !== null || block !== "";
    if (block) {
      btn.dataset["blocked"] = block;
      btn.title = this.blockReason(entry, block);
    }
    btn.addEventListener("click", () => void this.run(key, buy, "Purchase failed"));
    row.append(btn);
    return row;
  }

  /** The one sentence a blocked card owes the player. */
  private blockReason(entry: ShopEntry, block: BuyBlock): string {
    if (block === "level") return `Unlocks at level ${entry.requiresLevel}.`;
    if (block === "credits") return `Costs ${priceLabel(entry.price)} — you have ${this.store.credits()} cr.`;
    return "";
  }

  /**
   * The per-ship equip row. Only owned hulls the paint applies to appear —
   * offering a hull the pilot cannot fly would be offering a purchase the
   * server would reject anyway.
   */
  private equipRow(entry: PaintEntry): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "shop-card-actions shop-equip";
    row.append(hint("shop-equip-label", "Equip on"));
    const target = entry.target;
    if (target.kind === "module" || !target.owned || entry.state === "buy") {
      row.append(hint("shop-hint", equipHint(entry)));
      return row;
    }
    const key = `equip:${entry.id}:${target.shipId}`;
    const btn = document.createElement("button");
    btn.className = `sa-button ${target.equipped ? "sa-button--primary" : "sa-button--secondary"} shop-equip-btn`;
    btn.type = "button";
    btn.textContent = this.pending === key ? "…" : target.equipped ? "Equipped" : `Equip · ${target.shipName}`;
    btn.dataset["ship"] = target.shipId;
    btn.setAttribute("aria-pressed", String(target.equipped));
    btn.disabled = this.pending !== null || target.equipped;
    btn.addEventListener("click", () =>
      void this.run(key, () => this.store.selectCosmetic(target.shipId, selectionValueFor(entry.id)), "Could not equip that paint"),
    );
    row.append(btn);
    return row;
  }

  /**
   * Run one store action with the whole screen's actions disabled. Nothing is
   * applied here — the store's own change notification is what repaints.
   */
  private async run(key: string, action: () => Promise<void>, failure: string): Promise<void> {
    if (this.pending) return;
    this.pending = key;
    this.notice = "";
    this.render();
    try {
      await action();
    } catch (err) {
      this.fail(err, failure);
    } finally {
      this.pending = null;
      this.render();
    }
  }

  private fail(err: unknown, fallback: string): void {
    log.warn(fallback, err);
    const detail = err instanceof Error && err.message ? err.message : "";
    this.notice = detail ? `⚠ ${fallback} — ${detail}` : `⚠ ${fallback}`;
    if (this.isVisible) {
      this.noticeEl.textContent = this.notice;
      this.noticeEl.classList.add("visible");
    }
  }
}

/** The diagonal split swatch — primary, accent, and the emissive corner. */
function swatch(entry: PaintEntry): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "shop-swatch";
  el.setAttribute("aria-hidden", "true");
  el.style.setProperty("--shop-primary", entry.paint.primary);
  el.style.setProperty("--shop-accent", entry.paint.accent);
  const glow = entry.paint.glow;
  el.dataset["glow"] = String(Boolean(glow));
  if (glow) el.style.setProperty("--shop-glow", glow);
  return el;
}

function hint(className: string, text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}
