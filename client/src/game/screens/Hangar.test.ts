// @vitest-environment happy-dom
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, ModuleConfig, ShipConfig, UpgradeConfig } from "@space-arena/shared";
import { AssetRegistry } from "../../core/AssetRegistry.js";
import type { AuthService, AuthState } from "../../core/AuthService.js";
import type { ModelLoadQueue } from "../../core/modelLoadQueue.js";
import type { TacticalCamera } from "../TacticalCamera.js";
import { FakeOwnershipStore } from "../__fixtures__/ownershipStoreFake.js";
import { COSMETICS } from "../__fixtures__/shopContent.js";
import { Hangar } from "./Hangar.js";

/**
 * The Hangar's STATE MACHINE, driven through the DOM the player actually
 * presses. Since the 2026-08-22 LOADOUT DECK that is a short list: a grid of
 * slot TILES on the right, the card SHEET those tiles slide up over the ship,
 * and the ‹ › arrows that walk the bay. There is no rail, no fitting submenu
 * and no radial any more — fitting a module IS saving it — so the persistence
 * assertions hang off the card picks themselves. `hangarLoadout.test.ts`
 * already covers the storage helpers and `hangarDeck.test.ts` the deck's
 * arithmetic; nothing here re-tests either in isolation.
 *
 * The screen takes real collaborators, so the fakes below are the smallest
 * things that satisfy them:
 *  - a REAL Babylon `Scene` on a `NullEngine` (the in-directory precedent is
 *    `HangarBay.test.ts`), because the constructor builds transform nodes, an
 *    `AssetRegistry` and a `ShipPaintBank` against it;
 *  - a stage-camera stub wrapped around a real `ArcRotateCamera`, since
 *    `frameShip` reads its fov/alpha/beta;
 *  - an ANONYMOUS `AuthService`, which is what keeps every path in this file
 *    offline: `refreshFromServer` short-circuits to `localStorage` fittings and
 *    never touches `/api/*`;
 *  - an inert `ModelLoadQueue`, so the reveal resolves without loading a GLB.
 *
 * The ownership seam is the shipped {@link FakeOwnershipStore}, so "can this be
 * flown / fitted / bought" is seeded rather than mocked.
 */

// --- content ---------------------------------------------------------------

/**
 * Five weapons across two families and one internal. The sheet lists what a
 * socket accepts FLAT — the tier grouping went with the radial — so what these
 * exercise is availability rather than a ladder: `module.laser-mk2` and
 * `module.laser-burst` are the two the pilot has not unlocked, and
 * `module.kinetic-mk2` is the rail-breaker.
 */
const MODULES: ModuleConfig[] = [
  weapon("module.kinetic-mk1", "Autocannon Mk I", "kinetic", 1, 120, 3),
  // The rail-breaker: fitting it alongside anything at all outruns a 12-point
  // hull, which is what the power pips' overflow state is for.
  weapon("module.kinetic-mk2", "Autocannon Mk II", "kinetic", 2, 400, 14),
  weapon("module.laser-mk1", "Pulse Laser Mk I", "laser", 1, 0, 2),
  weapon("module.laser-mk2", "Pulse Laser Mk II", "laser", 2, 250, 4),
  weapon("module.laser-burst", "Burst Emitter", "laser", 1, 300, 3),
  internalModule("module.reactor-mk1", "Reactor Mk I", "generator", 1),
];

/**
 * Two hulls with real sockets — `shopContent.ts`'s ships deliberately carry
 * none, and the whole tile grid is derived from them. Ship order in the bay is
 * by id, so `ship.brawler` is index 0 and `ship.interceptor` (the starter, and
 * the default main) is index 1.
 */
const SHIPS: ShipConfig[] = [
  ship("ship.interceptor", "Interceptor", "light", [
    socket("hp-nose", "hardpoint", ["laser", "kinetic"]),
    socket("hp-wing", "hardpoint", ["kinetic"]),
    socket("in-core", "internal", ["generator"]),
  ], ["module.laser-mk1", null, null]),
  ship("ship.brawler", "Brawler", "heavy", [
    socket("hp-turret", "hardpoint", ["kinetic"]),
    socket("in-core", "internal", ["generator"]),
  ], [null, null]),
];

const UPGRADES: UpgradeConfig[] = (["hull", "engine", "energy"] as const).map((track) => ({
  id: `upgrade.${track}`,
  type: "upgrade",
  version: 1,
  name: `${track} track`,
  track,
  levels: [{ level: 1, price: 100, mul: { [`${track === "energy" ? "recharge" : track}.multiplier`]: 1.1 } }],
}) as unknown as UpgradeConfig);

function configs(): ConfigService {
  const byType: Record<string, { id: string }[]> = {
    ship: SHIPS,
    module: MODULES,
    upgrade: UPGRADES,
    cosmetic: COSMETICS,
  };
  return {
    get: (type: string, id: string) => byType[type]?.find((entry) => entry.id === id),
    getAll: (type: string) => byType[type] ?? [],
  } as unknown as ConfigService;
}

// --- collaborators ---------------------------------------------------------

let engine: NullEngine;
let scene: Scene;
let assets: AssetRegistry;
const mounted: Hangar[] = [];

/** Anonymous by default: the whole suite runs the offline (no-`/api`) branch. */
function auth(state: AuthState = { status: "anonymous" } as AuthState): AuthService {
  return {
    getState: () => state,
    onChange: () => () => undefined,
    refreshProfile: () => Promise.resolve(),
  } as unknown as AuthService;
}

function stageCamera(): TacticalCamera {
  const camera = new ArcRotateCamera("hangarTest", -Math.PI / 2, 1.15, 9, Vector3.Zero(), scene);
  return {
    camera,
    setHangarMode: vi.fn(),
    resetStageOrbit: vi.fn(),
    setStageViewport: vi.fn(),
    setStageRadiusRange: vi.fn(),
    stageAt: vi.fn(),
  } as unknown as TacticalCamera;
}

/** Nothing to fetch: every hull reports itself already loaded. */
function inertQueue(): ModelLoadQueue {
  return {
    hasLoaded: () => true,
    loadBlocking: () => Promise.resolve(),
    prioritize: () => Promise.resolve(),
    enqueue: () => Promise.resolve(),
    dispose: () => undefined,
  } as unknown as ModelLoadQueue;
}

/** What this pilot owns; everything else in `MODULES` renders "unavailable". */
const OWNED_MODULES = ["module.laser-mk1", "module.kinetic-mk1", "module.kinetic-mk2", "module.reactor-mk1"];

function store(seed: ConstructorParameters<typeof FakeOwnershipStore>[0] = {}): FakeOwnershipStore {
  return new FakeOwnershipStore({ ships: ["ship.interceptor", "ship.brawler"], modules: OWNED_MODULES, ...seed });
}

interface MountOptions {
  ownership?: FakeOwnershipStore;
  /** Where the carousel was left — the hull the stage opens on. */
  browse?: string;
  /** The hull already set as main, if the test needs one other than the default. */
  main?: string;
  onClose?: () => void;
}

async function mount(opts: MountOptions = {}): Promise<Hangar> {
  if (opts.main) localStorage.setItem("hangar.shipId", opts.main);
  if (opts.browse) localStorage.setItem("hangar.browseShipId", opts.browse);
  const hangar = new Hangar(
    document.body,
    scene,
    configs(),
    auth(),
    stageCamera(),
    opts.onClose ?? vi.fn(),
    undefined,
    opts.ownership ?? store(),
    assets,
    inertQueue(),
    () => Promise.resolve(),
  );
  mounted.push(hangar);
  hangar.show();
  // `show()` fires the priority-load reveal without awaiting it; the overlay
  // going away is the screen saying it has finished its first paint.
  await vi.waitFor(() => expect(document.querySelector(".hangar-loading-overlay")).toBeNull());
  return hangar;
}

beforeEach(() => {
  localStorage.clear();
  engine = new NullEngine();
  scene = new Scene(engine);
  assets = new AssetRegistry(scene);
});

afterEach(() => {
  for (const hangar of mounted.splice(0)) hangar.dispose();
  assets.dispose();
  scene.dispose();
  engine.dispose();
  document.body.replaceChildren();
  document.head.replaceChildren();
  localStorage.clear();
});

// --- DOM probes ------------------------------------------------------------

const slots = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".hangar-slot")];
const slot = (socketId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.hangar-slot[data-socket="${socketId}"]`)!;
/** The module name (or `EMPTY`) each tile is showing, in socket order. */
const slotLabels = (): (string | null)[] => slots().map((s) => s.querySelector(".hangar-slot-label")!.textContent);
/** What each tile HOLDS, in socket order — the tiles draw glyphs, not codes. */
const slotModules = (): (string | undefined)[] => slots().map((s) => s.dataset["module"]);
/** `svg` where a tile draws its module's glyph, `+` where the socket is empty. */
const slotGlyphs = (): (string | null)[] =>
  slots().map((s) => {
    const icon = s.querySelector(".hangar-slot-icon")!;
    return icon.querySelector("svg") ? "svg" : icon.textContent;
  });
const socketLabels = (): (string | null)[] => slots().map((s) => s.querySelector(".hangar-slot-socket")!.textContent);

const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(".hangar-sheet");
const sheetTitle = (): string | null | undefined => document.querySelector(".hangar-sheet-title")?.textContent;
const cardRow = (): HTMLElement => document.querySelector<HTMLElement>(".hangar-card-row")!;
const cardIds = (): (string | undefined)[] =>
  [...document.querySelectorAll<HTMLElement>(".hangar-card")].map((n) => n.dataset["module"]);
const card = (moduleId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.hangar-card[data-module="${moduleId}"]`)!;
const clearButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(".hangar-sheet-clear")!;
const doneButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(".hangar-sheet-done")!;
const dim = (): HTMLElement => document.querySelector<HTMLElement>(".hangar-sheet-dim")!;

const compareRow = (label: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>(".hangar-compare-row")].find(
    (r) => r.querySelector(".hangar-compare-label")!.textContent === label,
  )!;
const compareValue = (label: string): string | null =>
  compareRow(label).querySelector(".hangar-compare-value")!.textContent;
const compareDelta = (label: string): HTMLElement | null =>
  compareRow(label).querySelector<HTMLElement>(".hangar-compare-delta");

const pips = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".hangar-powerrow .hangar-pip")].map((p) =>
    p.className.replace("hangar-pip ", ""),
  );
const powerText = (): HTMLElement => document.querySelector<HTMLElement>(".hangar-power-text")!;

const stageAction = (): HTMLElement => document.querySelector<HTMLElement>(".hangar-stage-action")!;
const arrows = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".hangar-stage-arrow")];
const arrow = (which: "prev" | "next"): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.hangar-stage-arrow.${which}`)!;
const shipName = (): string | null | undefined => document.querySelector(".hangar-ship-name")?.textContent;
const shipDots = (): boolean[] =>
  [...document.querySelectorAll<HTMLElement>(".hangar-ship-dot")].map((d) => d.classList.contains("active"));
const skins = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".hangar-skin")];

const workingFit = (): { shipId?: string; moduleIds?: (string | null)[] } | null =>
  JSON.parse(localStorage.getItem("hangar.moduleIds") ?? "null") as { shipId?: string; moduleIds?: (string | null)[] } | null;
/** The per-hull loadout store the offline Hangar writes on every slot edit. */
const loadouts = (): Record<string, Record<string, string>> =>
  JSON.parse(localStorage.getItem("hangar.loadouts") ?? "{}") as Record<string, Record<string, string>>;

/** Raise the "the pilot is considering this" signal a mouse would. */
function hover(node: HTMLElement): void {
  node.dispatchEvent(new Event("pointerenter"));
}
function unhover(node: HTMLElement): void {
  node.dispatchEvent(new Event("pointerleave"));
}

/**
 * Leave and re-enter the SAME screen, optionally parking the carousel on another
 * hull. Mounting a second `Hangar` would leave the first one's markup in the
 * document (hide() only display:none-s it), and every probe here is a global
 * query — so re-entry is the honest way to test "what does it open on".
 */
async function reopen(hangar: Hangar, browse?: string): Promise<void> {
  hangar.hide();
  if (browse) localStorage.setItem("hangar.browseShipId", browse);
  hangar.show();
  await vi.waitFor(() => expect(document.querySelector(".hangar-loading-overlay")).toBeNull());
}

// --- tests -----------------------------------------------------------------

describe("the loadout deck", () => {
  it("lays every socket out as a tile — hardpoints, then core internal", async () => {
    await mount();
    expect(socketLabels()).toEqual(["HP-NOSE", "HP-WING", "CORE"]);
    // Fitted, empty, empty: a filled tile draws the module's GLYPH beside its
    // name — never a letter acronym (spec) — and an empty one shows `+`.
    expect(slotGlyphs()).toEqual(["svg", "+", "+"]);
    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "EMPTY", "EMPTY"]);
    expect(slotModules()).toEqual(["module.laser-mk1", "", ""]);
    expect(slot("hp-nose").classList.contains("filled")).toBe(true);
    expect(slot("hp-wing").classList.contains("filled")).toBe(false);
    // Both bays are on screen at once — there is no rail to switch between them.
    expect(document.querySelectorAll(".hangar-slot-grid")).toHaveLength(2);
    expect(document.querySelector(".hangar-rail")).toBeNull();
  });

  it("names the staged hull and marks where the carousel is", async () => {
    await mount({ browse: "ship.interceptor" });
    expect(shipName()).toBe("INTERCEPTOR");
    expect(document.querySelector(".hangar-ship-class")!.textContent).toBe("LIGHT HULL");
    expect(shipDots()).toEqual([false, true]);
  });

  it("offers nothing to fit on a hull you have not bought, until you buy it", async () => {
    const ownership = store({ ships: ["ship.interceptor"] });
    await mount({ ownership, browse: "ship.brawler" });

    expect(stageAction().querySelector(".hangar-badge.locked")).not.toBeNull();
    expect(document.querySelector(".hangar-slot-grid")).toBeNull();

    stageAction().querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.querySelector(".hangar-slot-grid")).not.toBeNull());
    expect(ownership.calls).toEqual(["buyShip:ship.brawler"]);
  });

  it("closes back to the caller from BACK", async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    document.querySelector<HTMLButtonElement>(".hangar-close")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the module sheet", () => {
  it("slides up for the tile pressed, and the same tile closes it", async () => {
    await mount();
    expect(sheet()).toBeNull();

    slot("hp-nose").click();
    expect(sheet()).not.toBeNull();
    expect(sheetTitle()).toBe("FIT — HP-NOSE");
    expect(slot("hp-nose").classList.contains("open")).toBe(true);

    slot("hp-nose").click();
    expect(sheet()).toBeNull();
    expect(slot("hp-nose").classList.contains("open")).toBe(false);

    // …and a different tile MOVES the sheet rather than opening a second one.
    slot("hp-nose").click();
    slot("hp-wing").click();
    expect(document.querySelectorAll(".hangar-sheet")).toHaveLength(1);
    expect(sheetTitle()).toBe("FIT — HP-WING");
    expect(slot("hp-wing").classList.contains("open")).toBe(true);
    expect(slot("hp-nose").classList.contains("open")).toBe(false);
  });

  it("closes on the dim and on DONE, without touching the fit", async () => {
    await mount();
    slot("hp-wing").click();
    dim().click();
    expect(sheet()).toBeNull();
    expect(slotLabels()[1]).toBe("EMPTY");
    expect(loadouts()).toEqual({});

    slot("hp-wing").click();
    doneButton().click();
    expect(sheet()).toBeNull();
    expect(loadouts()).toEqual({});
  });

  it("offers one card per module the socket accepts, lowest tier first", async () => {
    await mount();
    slot("hp-nose").click(); // laser + kinetic
    // FLAT: every mark of every accepted family, not one entry per line.
    expect(cardIds()).toEqual([
      "module.kinetic-mk1",
      "module.laser-burst",
      "module.laser-mk1",
      "module.kinetic-mk2",
      "module.laser-mk2",
    ]);
    expect(card("module.laser-mk1").querySelector(".hangar-card-name")!.textContent).toBe("Pulse Laser Mk I");
    // The card draws a glyph, and quotes what the module buys.
    expect(card("module.laser-mk1").querySelector(".hangar-card-icon svg")).not.toBeNull();
    expect(card("module.laser-mk1").querySelector(".hangar-card-stat")!.textContent).toBe("DPS+5 ⌁2");

    slot("hp-wing").click(); // kinetic only — the lasers are not offered at all
    expect(cardIds()).toEqual(["module.kinetic-mk1", "module.kinetic-mk2"]);

    slot("in-core").click();
    expect(cardIds()).toEqual(["module.reactor-mk1"]);
  });

  it("marks what is fitted, and dims what is not unlocked into inertness", async () => {
    await mount();
    slot("hp-nose").click();

    expect(card("module.laser-mk1").classList.contains("fitted")).toBe(true);
    expect(card("module.kinetic-mk1").classList.contains("fitted")).toBe(false);
    expect(card("module.kinetic-mk1").classList.contains("unavailable")).toBe(false);

    // Not unlocked: shown, dimmed and inert — the Shop is where it is bought.
    // Availability is UNLOCKED-or-not; there are no counts to print.
    const burst = card("module.laser-burst");
    expect(burst.classList.contains("unavailable")).toBe(true);
    expect(burst.disabled).toBe(true);
    expect(burst.dataset["previewModule"]).toBeUndefined();
    burst.click();
    expect(slotLabels()[0]).toBe("Pulse Laser Mk I");
    expect(document.querySelector(".hangar-card-count")).toBeNull();
  });

  it("fits the card picked and KEEPS the sheet open, writing the hull's loadout", async () => {
    const hangar = await mount();
    const onLoadoutChanged = vi.fn();
    hangar.onLoadoutChanged = onLoadoutChanged;

    slot("hp-wing").click();
    card("module.kinetic-mk1").click();

    // The whole point of the sheet: try another one straight after.
    expect(sheet()).not.toBeNull();
    expect(sheetTitle()).toBe("FIT — HP-WING");
    expect(card("module.kinetic-mk1").classList.contains("fitted")).toBe(true);
    expect(slotGlyphs()).toEqual(["svg", "svg", "+"]);
    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "Autocannon Mk I", "EMPTY"]);
    expect(onLoadoutChanged).toHaveBeenCalledTimes(1);
    // Fitting IS saving: there is no step in between, and no DONE to wait for.
    expect(loadouts()).toEqual({
      "ship.interceptor": { "0": "module.laser-mk1", "1": "module.kinetic-mk1" },
    });
    expect(workingFit()).toEqual({
      shipId: "ship.interceptor",
      moduleIds: ["module.laser-mk1", "module.kinetic-mk1", null],
    });

    // Swapping it for another mark, still without leaving the sheet.
    card("module.kinetic-mk2").click();
    expect(sheet()).not.toBeNull();
    expect(slotLabels()[1]).toBe("Autocannon Mk II");
  });

  it("empties the slot from CLEAR SLOT, and stays open to refill it", async () => {
    await mount();
    slot("hp-nose").click();
    clearButton().click();

    // CLEAR unfits; it is not a second way out (spec).
    expect(sheet()).not.toBeNull();
    expect(slotGlyphs()[0]).toBe("+");
    expect(slotLabels()[0]).toBe("EMPTY");
    expect(workingFit()?.moduleIds).toEqual([null, null, null]);
    expect(card("module.laser-mk1").classList.contains("fitted")).toBe(false);

    card("module.laser-mk1").click();
    expect(slotLabels()[0]).toBe("Pulse Laser Mk I");
  });

  it("lets one unlocked module fill two sockets — ownership is binary, not a crate", async () => {
    await mount();
    slot("hp-nose").click();
    card("module.kinetic-mk1").click();

    slot("hp-wing").click();
    // Already fitted at the nose, and still offered here.
    expect(card("module.kinetic-mk1").disabled).toBe(false);
    card("module.kinetic-mk1").click();
    expect(slotModules()).toEqual(["module.kinetic-mk1", "module.kinetic-mk1", ""]);
  });

  it("pans the card row on a mouse drag, and the drag never fits anything", async () => {
    await mount();
    slot("hp-wing").click();
    const row = cardRow();

    row.dispatchEvent(new MouseEvent("mousedown", { clientX: 200, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 140 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 140 }));
    // The click that ends a 60px pan lands on whatever card the pointer stopped
    // over. It must not fit it.
    card("module.kinetic-mk1").click();
    expect(slotLabels()[1]).toBe("EMPTY");

    // The suppression lasts exactly one task: the next tap is a real tap.
    await vi.waitFor(() => {
      card("module.kinetic-mk1").click();
      expect(slotLabels()[1]).toBe("Autocannon Mk I");
    });
  });

  it("scrolls the row horizontally from a vertical wheel", async () => {
    await mount();
    slot("hp-wing").click();
    const row = cardRow();
    row.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, deltaX: 0, bubbles: true, cancelable: true }));
    expect(row.scrollLeft).toBe(120);
  });
});

describe("before / after preview", () => {
  it("ghosts the projected numbers while a card is hovered, and drops them when it is not", async () => {
    await mount();
    const before = compareValue("DPS");
    slot("hp-wing").click();
    // Nothing has changed since the sheet opened, so there is no delta yet.
    expect(compareDelta("DPS")).toBeNull();

    const item = card("module.kinetic-mk1");
    hover(item);
    // A second gun can only add damage, so DPS reads BETTER and the BEFORE
    // column is left exactly where it was — nothing is fitted yet.
    expect(compareValue("DPS")).toBe(before);
    expect(compareDelta("DPS")!.className).toContain("better");
    expect(compareDelta("DPS")!.textContent).toMatch(/^▲ /);
    expect(item.classList.contains("considering")).toBe(true);

    unhover(item);
    expect(compareDelta("DPS")).toBeNull();
    expect(card("module.kinetic-mk1").classList.contains("considering")).toBe(false);
  });

  it("keeps BEFORE at the fit the sheet opened on, then commits it on close", async () => {
    await mount();
    // POWER is what tells the two autocannon marks apart here: they deal the
    // same damage and differ only in what they draw off the rail.
    const openedDps = compareValue("DPS");
    const openedPower = compareValue("POWER");
    expect(openedPower).toBe("2 / 12");

    slot("hp-wing").click();
    card("module.kinetic-mk1").click();
    // Fitted, sheet still up: BEFORE is still the snapshot, AFTER has moved.
    expect(compareValue("DPS")).toBe(openedDps);
    expect(compareDelta("DPS")!.textContent).toMatch(/^▲ /);
    expect(compareValue("POWER")).toBe(openedPower);
    expect(compareDelta("POWER")!.textContent).toContain("5 / 12");

    // A second pick in the same sitting still reads against that same snapshot.
    card("module.kinetic-mk2").click();
    expect(compareValue("POWER")).toBe(openedPower);
    expect(compareDelta("POWER")!.textContent).toContain("16 / 12");

    // Closing COMMITS: the box collapses onto the new numbers as the baseline.
    doneButton().click();
    expect(compareDelta("POWER")).toBeNull();
    expect(compareValue("POWER")).toBe("16 / 12");

    // …and the next sheet starts from there.
    slot("hp-wing").click();
    expect(compareDelta("POWER")).toBeNull();
    expect(compareValue("POWER")).toBe("16 / 12");
  });

  it("shows a swap that COSTS something as worse", async () => {
    await mount();
    slot("hp-nose").click();
    // Emptying the nose gives back the laser it holds: DPS falls.
    hover(clearButton());
    expect(compareDelta("DPS")!.className).toContain("worse");
    expect(compareDelta("DPS")!.textContent).toMatch(/^▼ /);
    expect(compareDelta("INTEGRITY")).toBeNull(); // a laser does not move the hull
  });

  it("warns when the candidate would outrun the power rail", async () => {
    await mount();
    slot("hp-wing").click();

    hover(card("module.kinetic-mk1"));
    // 2 + 3 against a 12-point rail: more draw, but nothing broken.
    expect(compareDelta("POWER")!.className).toContain("none");
    expect(compareDelta("POWER")!.className).not.toContain("warn");

    hover(card("module.kinetic-mk2"));
    // 2 + 14 is past the rail, so the projected reading turns dangerous.
    expect(compareDelta("POWER")!.textContent).toContain("16 / 12");
    expect(compareDelta("POWER")!.className).toContain("warn");
  });

  it("previews on a press-and-hold, and the release that ends it does not fit", async () => {
    await mount();
    slot("hp-wing").click();
    const item = card("module.kinetic-mk1");

    item.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(compareDelta("DPS")).not.toBeNull());
    item.click();

    // The hold asked a question; it was not an answer.
    expect(sheet()).not.toBeNull();
    expect(slotLabels()[1]).toBe("EMPTY");

    // A plain tap, with no hold behind it, still fits.
    card("module.kinetic-mk1").click();
    expect(slotLabels()[1]).toBe("Autocannon Mk I");
  });
});

describe("power pips", () => {
  it("fills one pip per point drawn, against the hull's whole rail", async () => {
    await mount();
    // The stock fit is one 2-point laser on a 12-point rail.
    expect(pips()).toHaveLength(12);
    expect(pips().filter((c) => c === "filled")).toHaveLength(2);
    expect(powerText().textContent).toBe("2 / 12");
    expect(powerText().classList.contains("over")).toBe(false);
  });

  it("turns the whole rail red when the fit outruns it", async () => {
    await mount();
    slot("hp-wing").click();
    card("module.kinetic-mk2").click();

    expect(powerText().textContent).toBe("16 / 12");
    expect(powerText().classList.contains("over")).toBe(true);
    expect(pips().every((c) => c === "over")).toBe(true);
  });
});

describe("skins", () => {
  it("shows this hull's paints with the equipped one ringed, and equips on tap", async () => {
    const ownership = store();
    await mount({ ownership });
    expect(skins().map((s) => s.dataset["cosmetic"])).toEqual([
      "cosmetic.paint-interceptor-crimson",
      "cosmetic.paint-interceptor-lance",
      "cosmetic.paint-interceptor-standard",
    ]);
    expect(skins().filter((s) => s.classList.contains("equipped"))).toHaveLength(1);

    const crimson = skins()[0]!;
    expect(crimson.classList.contains("equipped")).toBe(false);
    crimson.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('.hangar-skin[data-cosmetic="cosmetic.paint-interceptor-crimson"]')!
          .classList.contains("equipped"),
      ).toBe(true),
    );
    expect(ownership.calls).toContain("selectCosmetic:ship.interceptor:cosmetic.paint-interceptor-crimson");
  });
});

/**
 * Owner 2026-08-22: "when a player fits its ship, it becomes the fitting the
 * ship is going to use." So there is nothing to save, name, select or delete —
 * these pin that the slot edit itself is the whole transaction, that it survives
 * leaving and re-entering the screen, and that each hull keeps its OWN.
 */
describe("hangar loadouts (one per hull, implicit)", () => {
  it("re-opens every hull on its own loadout, including one that is not the main", async () => {
    const first = await mount({ main: "ship.interceptor" });
    slot("hp-wing").click();
    card("module.kinetic-mk1").click();

    // Browse to the OTHER hull and fit it too. It is not the main, so this must
    // still be remembered — a loadout belongs to the ship, not to the choice of
    // what to fly.
    await reopen(first, "ship.brawler");
    expect(slotLabels()).toEqual(["EMPTY", "EMPTY"]);
    slot("hp-turret").click();
    card("module.kinetic-mk1").click();
    expect(loadouts()["ship.brawler"]).toEqual({ "0": "module.kinetic-mk1" });

    // Back to the interceptor: its own fit, untouched by the brawler's.
    await reopen(first, "ship.interceptor");
    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "Autocannon Mk I", "EMPTY"]);
  });

  it("opens a hull on its STOCK fit until the pilot touches a slot", async () => {
    const hangar = await mount();
    expect(slotLabels()[0]).toBe("Pulse Laser Mk I");
    // Emptying every slot is a real loadout, not "never fitted": it must come
    // back empty rather than reverting to the stock fit on the next visit.
    slot("hp-nose").click();
    clearButton().click();
    expect(loadouts()["ship.interceptor"]).toEqual({});

    await reopen(hangar);
    expect(slotLabels()).toEqual(["EMPTY", "EMPTY", "EMPTY"]);
  });

  it("folds a pre-2026-08-22 browser's named fittings into one loadout per hull", async () => {
    // What the old save/load submenu left behind, plus the id it had selected.
    localStorage.setItem(
      "hangar.localFittings",
      JSON.stringify([
        { id: "local:old", user_id: "local", ship_id: "ship.interceptor", name: "Strike", hardpointMap: { "1": "module.kinetic-mk1" }, created_at: "" },
        { id: "local:newer", user_id: "local", ship_id: "ship.interceptor", name: "Brawl", hardpointMap: { "0": "module.laser-mk1" }, created_at: "" },
      ]),
    );
    localStorage.setItem("hangar.fittingId", "local:old");

    await mount();

    // The SELECTED one became the hull's loadout, and the old keys are gone.
    expect(slotLabels()).toEqual(["EMPTY", "Autocannon Mk I", "EMPTY"]);
    expect(localStorage.getItem("hangar.localFittings")).toBeNull();
    expect(localStorage.getItem("hangar.fittingId")).toBeNull();
  });
});

describe("hangar main loadout", () => {
  it("leaves what you fly alone while you browse, until Set as main is pressed", async () => {
    await mount({ browse: "ship.brawler", main: "ship.interceptor" });
    const setMain = stageAction().querySelector<HTMLButtonElement>("button")!;
    expect(setMain.textContent).toBe("★ Set as main");

    slot("hp-turret").click();
    card("module.kinetic-mk1").click();
    // Editing a hull you are only LOOKING at must not change what launches.
    expect(localStorage.getItem("hangar.shipId")).toBe("ship.interceptor");
    expect(workingFit()).toBeNull();

    stageAction().querySelector<HTMLButtonElement>("button")!.click();
    expect(localStorage.getItem("hangar.shipId")).toBe("ship.brawler");
    expect(workingFit()).toEqual({ shipId: "ship.brawler", moduleIds: ["module.kinetic-mk1", null] });
    // The decision is spent: the slot now holds the badge, not the button.
    expect(stageAction().querySelector("button")).toBeNull();
    expect(stageAction().querySelector(".hangar-badge.main")!.textContent).toBe("★ MAIN");
  });
});

describe("hangar visit lifecycle", () => {
  it("never stacks a second visit's per-frame observer, and releases it on hide", async () => {
    // Babylon's `Observable.remove` defers the actual splice to a macrotask, so
    // every count below is asserted through `waitFor` rather than inline.
    const observers = (): number => scene.onBeforeRenderObservable.observers.length;
    const baseline = observers();
    const hangar = await mount();
    expect(observers()).toBe(baseline + 1);

    // Re-entry without an intervening hide() (the tutorial does exactly this).
    hangar.show();
    await vi.waitFor(() => expect(document.querySelector(".hangar-loading-overlay")).toBeNull());
    await vi.waitFor(() => expect(observers()).toBe(baseline + 1));
    expect(hangar.isOpen).toBe(true);

    hangar.hide();
    await vi.waitFor(() => expect(observers()).toBe(baseline));
    expect(hangar.isOpen).toBe(false);
  });

  it("commits a hull switch even when not a single render frame lands", async () => {
    // The reported dead switcher (2026-08-22): the arrows disable themselves for
    // the duration of the slide, and the slide used to be advanced by a scene
    // render observer reading `engine.getDeltaTime()`. A screen that is not
    // being rendered — a backgrounded tab, a stalled frame clock — never reached
    // the transition's midpoint, so the hull never changed and BOTH arrows
    // stayed disabled for the rest of the session. Nothing in this test calls
    // `scene.render()`; the switch must land anyway.
    await mount({ browse: "ship.interceptor" });
    expect(shipName()).toBe("INTERCEPTOR");

    arrow("next").click();
    expect(arrows().map((b) => b.disabled)).toEqual([true, true]);

    await vi.waitFor(() => expect(shipName()).toBe("BRAWLER"), { timeout: 3000 });
    // …and it is a real commit, not just a repainted label: the arrows come
    // back, the deck describes the new hull, and the carousel position is
    // written where the next visit (and `loadHangarSelection`) will read it.
    expect(arrows().map((b) => b.disabled)).toEqual([false, false]);
    expect(document.querySelector(".hangar-ship-class")!.textContent).toBe("HEAVY HULL");
    expect(shipDots()).toEqual([true, false]);
    expect(localStorage.getItem("hangar.browseShipId")).toBe("ship.brawler");
    // Every hull opens on ITS OWN fit, so the tiles moved with the ship: the
    // light's two hardpoints are gone, the heavy's single turret is there.
    expect(socketLabels()).toEqual(["HP-TURRET", "CORE"]);
  });

  it("closes an open sheet when the bay is walked, and commits it", async () => {
    await mount({ browse: "ship.interceptor" });
    slot("hp-nose").click();
    card("module.kinetic-mk1").click();
    expect(sheet()).not.toBeNull();
    // Open sheet, fit changed: the box is holding a BEFORE column. (POWER, not
    // DPS — swapping the laser for an autocannon costs a point of rail and
    // leaves the damage exactly where it was.)
    expect(compareDelta("POWER")).not.toBeNull();

    arrow("next").click();
    await vi.waitFor(() => expect(shipName()).toBe("BRAWLER"), { timeout: 3000 });
    // A sheet belongs to a socket on the hull that opened it, and this hull does
    // not even have that socket — so the switch closes it, which commits.
    expect(sheet()).toBeNull();
    expect(document.querySelectorAll(".hangar-slot.open")).toHaveLength(0);
    expect(compareDelta("POWER")).toBeNull();
    // …and the fit it left behind is the interceptor's, saved on the pick.
    expect(loadouts()["ship.interceptor"]).toEqual({ "0": "module.kinetic-mk1" });
  });

  it("never carries a half-finished swap into the next visit", async () => {
    // Pressing an arrow and leaving for the Shop used to strand `swap` set, and
    // nothing on the way back in cleared it: the arrows read as permanently
    // disabled and only a page reload fixed it — which is what "the hangar did
    // not refresh after my purchase" actually was.
    const hangar = await mount({ browse: "ship.interceptor" });
    arrow("next").click();
    expect(arrows().every((b) => b.disabled)).toBe(true);

    await reopen(hangar);
    expect(arrows().some((b) => b.disabled)).toBe(false);
    // Abandoned, not committed: leaving is not a decision about which hull to
    // browse, so the carousel is where the player left it.
    expect(shipName()).toBe("INTERCEPTOR");
  });
});

// --- content builders ------------------------------------------------------

function socket(id: string, kind: "hardpoint" | "internal", accepts: string[]): unknown {
  return { id, kind, accepts, transform: { pos: [0, 0, 1] } };
}

function ship(
  id: string,
  name: string,
  cls: string,
  sockets: unknown[],
  defaultFitting: (string | null)[],
): ShipConfig {
  return {
    id,
    type: "ship",
    version: 3,
    name,
    class: cls,
    core: {
      hull: { base: 120, resists: { kinetic: 0.1, energy: 0.1 } },
      engine: { nominalSpeed: 27, accel: 18, turnRate: 3 },
      power: { capacity: 12 },
      efficiency: { energyDraw: 1 },
      recharge: { multiplier: 1 },
      energyStore: { multiplier: 1 },
      sensors: { lockRange: 100, lockTimeSec: 1, coneDeg: 30 },
    },
    upgradeTracks: { hull: "upgrade.hull", engine: "upgrade.engine", energy: "upgrade.energy" },
    sockets,
    defaultFitting,
    render: { recipe: "procedural.arrowhead" },
    collider: { shape: "circle", radius: 1 },
  } as unknown as ShipConfig;
}

function weapon(id: string, name: string, family: string, level: number, price: number, draw: number): ModuleConfig {
  return {
    id,
    type: "module",
    version: 1,
    name,
    family,
    level,
    price,
    requiresLevel: 1,
    activation: { deployTime: 0, retractTime: 0 },
    power: { draw },
    fire: { mode: "held", range: 80, cycleTime: 1, damage: 5, damageType: "energy" },
    ui: { icon: family, label: name },
  } as unknown as ModuleConfig;
}

function internalModule(id: string, name: string, family: string, level: number): ModuleConfig {
  return {
    id,
    type: "module",
    version: 1,
    name,
    family,
    level,
    price: 0,
    requiresLevel: 1,
    activation: { deployTime: 0, retractTime: 0 },
    power: { draw: 0 },
    recharge: { multiplier: 1.2 },
    ui: { icon: family, label: name },
  } as unknown as ModuleConfig;
}
