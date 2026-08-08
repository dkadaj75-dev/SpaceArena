import {
  createLogger,
  type ConfigEvents,
  type ConfigService,
  type EventBus,
  type ThemeConfig,
} from "@space-arena/shared";
import type { OwnershipStore } from "../ownershipStore.js";
import { cosmeticById } from "../cosmetics.js";
import {
  equipHint,
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

export interface ShopCallbacks {
  onClose: () => void;
}

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
  private readonly noticeEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribeTheme: (() => void) | null = null;
  private tab: ShopTab = "ships";
  /** The action in flight, as `kind:id` — non-null disables every action. */
  private pending: string | null = null;
  private notice = "";

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

  private applyTheme(): void {
    applyMenuTheme(this.root, this.configs.get<ThemeConfig>("theme", THEME_ID));
  }

  show(): void {
    this.notice = "";
    this.pending = null;
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
    this.render();
  }

  private render(): void {
    this.creditsEl.textContent = `${this.store.credits()} cr`;
    this.renderTabs();
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
    for (const group of groups) {
      grid.append(hint("shop-group-title", group.title));
      for (const entry of group.entries) {
        const card = this.card(entry);
        card.append(this.actions(entry, "module", () => this.store.buyModule(entry.id), "Owned"));
        grid.append(card);
      }
    }
  }

  private renderPaints(grid: HTMLDivElement): void {
    const entries = paintEntries(this.configs, this.store);
    if (entries.length === 0) {
      grid.append(hint("shop-empty", "No paints in this content pack."));
      return;
    }
    for (const entry of entries) {
      const card = this.card(entry, swatch(entry));
      if (entry.state === "buy") {
        card.append(this.actions(entry, "cosmetic", () => this.store.buyCosmetic(entry.id), "In locker"));
      } else {
        // Both rows: the badge answers "is this on a hull", the row answers
        // "on which one" — a bought paint sitting in the locker looks nothing
        // like a worn one.
        card.append(this.equipRow(entry), this.actions(entry, "cosmetic", () => this.store.buyCosmetic(entry.id), "In locker"));
      }
      grid.append(card);
    }
  }

  /** The shared card shell: name, price chip, sub-line, stat chips. */
  private card(entry: ShopEntry, lead?: HTMLElement): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "shop-card";
    card.dataset["state"] = entry.state;
    card.dataset["entry"] = entry.id;
    if (lead) card.append(lead);

    const head = document.createElement("div");
    head.className = "shop-card-head";
    const name = document.createElement("span");
    name.className = "shop-card-name";
    name.textContent = entry.name;
    const price = document.createElement("span");
    price.className = "shop-price";
    price.dataset["free"] = String(entry.price <= 0);
    price.textContent = priceLabel(entry.price);
    head.append(name, price);
    card.append(head, hint("shop-card-sub", entry.sub));

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
    const btn = document.createElement("button");
    btn.className = "sa-button sa-button--primary shop-buy";
    btn.type = "button";
    btn.textContent = this.pending === key ? "Buying…" : `Buy · ${priceLabel(entry.price)}`;
    btn.disabled = this.pending !== null;
    btn.addEventListener("click", () => void this.run(key, buy, "Purchase failed"));
    row.append(btn);
    return row;
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
    const cosmetic = cosmeticById(this.configs, entry.id);
    if (entry.targets.length === 0) {
      row.append(hint("shop-hint", equipHint(entry, cosmetic)));
      return row;
    }
    for (const target of entry.targets) {
      const key = `equip:${entry.id}:${target.shipId}`;
      const btn = document.createElement("button");
      btn.className = `sa-button ${target.equipped ? "sa-button--primary" : "sa-button--secondary"} shop-equip-btn`;
      btn.type = "button";
      btn.textContent = this.pending === key ? "…" : target.shipName;
      btn.dataset["ship"] = target.shipId;
      btn.setAttribute("aria-pressed", String(target.equipped));
      btn.disabled = this.pending !== null || target.equipped;
      btn.addEventListener("click", () =>
        void this.run(key, () => this.store.selectCosmetic(target.shipId, selectionValueFor(entry.id)), "Could not equip that paint"),
      );
      row.append(btn);
    }
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
  const glow = entry.paint.emissive;
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
