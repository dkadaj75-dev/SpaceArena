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
 * presses: the outfitting rail, the slot grid and the module picker. There is no
 * fitting submenu to drive since 2026-08-22 — fitting a module IS saving it —
 * so the persistence assertions below hang off the slot edits themselves.
 * `hangarLoadout.test.ts` already covers the module-level storage helpers
 * (`loadHangarSelection` and friends), so nothing here re-tests those in
 * isolation — they appear only as the persistence a screen action is expected to
 * leave behind.
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

const MODULES: ModuleConfig[] = [
  weapon("module.kinetic-mk1", "Autocannon Mk I", "kinetic", 1, 120, 3),
  weapon("module.laser-mk1", "Pulse Laser Mk I", "laser", 1, 0, 2),
  weapon("module.laser-mk2", "Pulse Laser Mk II", "laser", 2, 250, 4),
  internalModule("module.reactor-mk1", "Reactor Mk I", "generator", 1),
];

/**
 * Two hulls with real sockets — `shopContent.ts`'s ships deliberately carry
 * none, and the whole slot grid is derived from them. Ship order in the bay is
 * by id, so `ship.brawler` is index 0 and `ship.interceptor` (the starter, and
 * the default main) is index 1.
 */
const SHIPS: ShipConfig[] = [
  ship("ship.interceptor", "Interceptor", "light", [
    socket("hp-nose", "hardpoint", ["laser", "kinetic"]),
    socket("hp-wing", "hardpoint", ["kinetic"]),
    socket("int-core", "internal", ["generator"]),
  ], ["module.laser-mk1", null, null]),
  ship("ship.brawler", "Brawler", "heavy", [
    socket("hp-turret", "hardpoint", ["kinetic"]),
    socket("int-core", "internal", ["generator"]),
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

const OWNED_MODULES = ["module.laser-mk1", "module.kinetic-mk1", "module.reactor-mk1"];

/** Owns both hulls and everything but `module.laser-mk2` (the buy-path module). */
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

const rail = (category: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.hangar-rail-btn[data-category="${category}"]`)!;
const activeRail = (): string | undefined =>
  document.querySelector<HTMLElement>(".hangar-rail-btn.active")?.dataset["category"];
const sectionTitles = (): (string | null)[] =>
  [...document.querySelectorAll(".hangar-content .hangar-section-title")].map((n) => n.textContent);
const slots = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".hangar-slot")];
const slotLabels = (): (string | null)[] =>
  slots().map((s) => s.querySelector(".hangar-slot-label")!.textContent);
const picker = (): HTMLElement | null => document.querySelector<HTMLElement>(".hangar-picker");
const pickerIds = (): (string | undefined)[] =>
  [...document.querySelectorAll<HTMLElement>(".hangar-picker-item")].map((row) => row.dataset["module"]);
const pickerAction = (moduleId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.hangar-picker-item[data-module="${moduleId}"] .hangar-picker-actions button`)!;
const removeButton = (): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>(".hangar-picker button")].find((b) => b.textContent === "Remove module")!;
const stageAction = (): HTMLElement => document.querySelector<HTMLElement>(".hangar-stage-action")!;
const workingFit = (): { shipId?: string; moduleIds?: (string | null)[] } | null =>
  JSON.parse(localStorage.getItem("hangar.moduleIds") ?? "null") as { shipId?: string; moduleIds?: (string | null)[] } | null;
/** The per-hull loadout store the offline Hangar writes on every slot edit. */
const loadouts = (): Record<string, Record<string, string>> =>
  JSON.parse(localStorage.getItem("hangar.loadouts") ?? "{}") as Record<string, Record<string, string>>;

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

/** Open the picker for a slot by its socket label, e.g. "hp-nose". */
function openSlot(socketId: string): void {
  const slot = slots().find((s) => s.querySelector(".hangar-slot-socket")!.textContent!.startsWith(socketId))!;
  slot.click();
}

// --- tests -----------------------------------------------------------------

describe("hangar rail", () => {
  it("opens on Hardpoints and swaps the panel one bay at a time", async () => {
    await mount();
    expect(activeRail()).toBe("hardpoints");
    expect(sectionTitles()).toContain("Hardpoints");

    rail("internals").click();
    expect(activeRail()).toBe("internals");
    expect(sectionTitles()).toContain("Core internal bays");
    // The upgrade tracks ARE the hull's internals, so they ride in this bay.
    expect(document.querySelector(".hangar-upgrades")).not.toBeNull();

    rail("skins").click();
    expect(document.querySelector(".hangar-slot-grid")).toBeNull();
    // Only this hull's paints, id-sorted (`cosmeticsForShip` is pack-order independent).
    expect([...document.querySelectorAll<HTMLElement>(".hangar-skin")].map((r) => r.dataset["cosmetic"])).toEqual([
      "cosmetic.paint-interceptor-crimson",
      "cosmetic.paint-interceptor-lance",
      "cosmetic.paint-interceptor-standard",
    ]);
    // Exactly one bay is ever active — the rail is a radio group, not a stack.
    expect(document.querySelectorAll(".hangar-rail-btn.active")).toHaveLength(1);
    // …and there is no FITTING bay any more (owner 2026-08-22): saving, naming
    // and deleting loadouts were all it did, and fitting a module now IS saving
    // it. The rail is bays and the Back button, nothing else.
    expect([...document.querySelectorAll<HTMLElement>(".hangar-rail-btn[data-category]")].map((b) => b.dataset["category"]))
      .toEqual(["skins", "hardpoints", "internals"]);
    expect(document.body.textContent).not.toContain("Fitting name");
  });

  it("drops an open picker when the bay changes", async () => {
    await mount();
    openSlot("hp-nose");
    expect(picker()).not.toBeNull();

    rail("internals").click();
    // A hardpoint's module list under the internals heading would be a lie.
    expect(picker()).toBeNull();
    expect(document.querySelectorAll(".hangar-slot.open")).toHaveLength(0);
  });

  it("offers no bays at all on a hull you have not bought, until you buy it", async () => {
    const ownership = store({ ships: ["ship.interceptor"] });
    await mount({ ownership, browse: "ship.brawler" });

    expect(stageAction().querySelector(".hangar-badge.locked")).not.toBeNull();
    expect([...document.querySelectorAll<HTMLButtonElement>(".hangar-rail-btn[data-category]")].every((b) => b.disabled)).toBe(true);
    expect(document.querySelector(".hangar-slot-grid")).toBeNull();

    stageAction().querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.querySelector(".hangar-slot-grid")).not.toBeNull());
    expect(ownership.calls).toEqual(["buyShip:ship.brawler"]);
    expect([...document.querySelectorAll<HTMLButtonElement>(".hangar-rail-btn[data-category]")].every((b) => b.disabled)).toBe(false);
  });
});

describe("hangar slot selection", () => {
  it("opens the picker for the slot pressed, and closes it when pressed again", async () => {
    await mount();
    openSlot("hp-nose");
    expect(document.querySelectorAll(".hangar-slot.open")).toHaveLength(1);
    expect(picker()!.querySelector(".hangar-section-title")!.textContent).toContain("hp-nose");

    openSlot("hp-nose");
    expect(picker()).toBeNull();

    // …and a different slot moves the picker rather than opening a second one.
    openSlot("hp-nose");
    openSlot("hp-wing");
    expect(document.querySelectorAll(".hangar-picker")).toHaveLength(1);
    expect(picker()!.querySelector(".hangar-section-title")!.textContent).toContain("hp-wing");
  });

  it("lists only the modules the pressed socket accepts, lowest tier first", async () => {
    await mount();
    // hp-nose takes laser + kinetic; the sort is by level, then by name.
    openSlot("hp-nose");
    expect(pickerIds()).toEqual(["module.kinetic-mk1", "module.laser-mk1", "module.laser-mk2"]);

    // hp-wing is kinetic-only, so the lasers are not offered at all.
    openSlot("hp-wing");
    expect(pickerIds()).toEqual(["module.kinetic-mk1"]);

    rail("internals").click();
    openSlot("int-core");
    expect(pickerIds()).toEqual(["module.reactor-mk1"]);
  });
});

describe("hangar equip and remove", () => {
  it("equips into the pressed slot, announces the change and persists the working fit", async () => {
    const hangar = await mount();
    const onLoadoutChanged = vi.fn();
    hangar.onLoadoutChanged = onLoadoutChanged;
    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "Empty"]);

    openSlot("hp-wing");
    pickerAction("module.kinetic-mk1").click();

    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "Autocannon Mk I"]);
    // Equipping ends the picker session it came from.
    expect(picker()).toBeNull();
    expect(onLoadoutChanged).toHaveBeenCalledTimes(1);
    // An unsaved edit still flies, so it is written the moment it is made.
    expect(workingFit()).toEqual({
      shipId: "ship.interceptor",
      moduleIds: ["module.laser-mk1", "module.kinetic-mk1", null],
    });
  });

  it("removes a fitted module through the slot's own control", async () => {
    await mount();
    openSlot("hp-nose");
    removeButton().click();

    expect(slotLabels()).toEqual(["Empty", "Empty"]);
    expect(picker()).toBeNull();
    expect(workingFit()?.moduleIds).toEqual([null, null, null]);
  });

  it("offers Buy for an unowned module, and Equip once the ledger says it is bought", async () => {
    const ownership = store();
    await mount({ ownership });
    openSlot("hp-nose");
    // Offline every module is FREE — but it is still bought, so the unlock flow
    // on screen is the shipped one and only the price is provisional.
    expect(pickerAction("module.laser-mk2").textContent).toBe("Buy · FREE");

    pickerAction("module.laser-mk2").click();
    await vi.waitFor(() => expect(pickerAction("module.laser-mk2").textContent).toBe("Equip"));
    expect(ownership.calls).toEqual(["buyModule:module.laser-mk2"]);

    // Buying does not fit it — that is still a separate decision.
    expect(slotLabels()[0]).toBe("Pulse Laser Mk I");
    pickerAction("module.laser-mk2").click();
    expect(slotLabels()[0]).toBe("Pulse Laser Mk II");
  });
});

/**
 * Owner 2026-08-22: "when a player fits its ship, it becomes the fitting the
 * ship is going to use." So there is nothing to save, name, select or delete —
 * these pin that the slot edit itself is the whole transaction, that it survives
 * leaving and re-entering the screen, and that each hull keeps its OWN.
 */
describe("hangar loadouts (one per hull, implicit)", () => {
  it("writes the hull's loadout the moment a slot changes, with no save step", async () => {
    await mount();
    expect(loadouts()).toEqual({});

    openSlot("hp-wing");
    pickerAction("module.kinetic-mk1").click();

    expect(loadouts()).toEqual({
      "ship.interceptor": { "0": "module.laser-mk1", "1": "module.kinetic-mk1" },
    });
    // Nothing was pressed to make that happen, and nothing is offered to undo it.
    expect(document.querySelector(".hangar-fit-controls")).toBeNull();
    expect(document.querySelector(".hangar-btn-danger")).toBeNull();
  });

  it("re-opens every hull on its own loadout, including one that is not the main", async () => {
    const first = await mount({ main: "ship.interceptor" });
    openSlot("hp-wing");
    pickerAction("module.kinetic-mk1").click();

    // Browse to the OTHER hull and fit it too. It is not the main, so this must
    // still be remembered — a loadout belongs to the ship, not to the choice of
    // what to fly.
    await reopen(first, "ship.brawler");
    // The brawler's stock fit — one hardpoint, and the rail shows one bay.
    expect(slotLabels()).toEqual(["Empty"]);
    openSlot("hp-turret");
    pickerAction("module.kinetic-mk1").click();
    expect(loadouts()["ship.brawler"]).toEqual({ "0": "module.kinetic-mk1" });

    // Back to the interceptor: its own fit, untouched by the brawler's.
    await reopen(first, "ship.interceptor");
    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "Autocannon Mk I"]);
  });

  it("opens a hull on its STOCK fit until the pilot touches a slot", async () => {
    const hangar = await mount();
    expect(slotLabels()).toEqual(["Pulse Laser Mk I", "Empty"]);
    // Emptying every slot is a real loadout, not "never fitted": it must come
    // back empty rather than reverting to the stock fit on the next visit.
    openSlot("hp-nose");
    removeButton().click();
    expect(loadouts()["ship.interceptor"]).toEqual({});

    await reopen(hangar);
    expect(slotLabels()).toEqual(["Empty", "Empty"]);
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
    expect(slotLabels()).toEqual(["Empty", "Autocannon Mk I"]);
    expect(localStorage.getItem("hangar.localFittings")).toBeNull();
    expect(localStorage.getItem("hangar.fittingId")).toBeNull();
  });
});

describe("hangar main loadout", () => {
  it("leaves what you fly alone while you browse, until Set as main is pressed", async () => {
    await mount({ browse: "ship.brawler", main: "ship.interceptor" });
    const setMain = stageAction().querySelector<HTMLButtonElement>("button")!;
    expect(setMain.textContent).toBe("★ Set as main");

    openSlot("hp-turret");
    pickerAction("module.kinetic-mk1").click();
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

  it("closes back to the caller from either exit", async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    document.querySelector<HTMLButtonElement>(".hangar-close")!.click();
    document.querySelector<HTMLButtonElement>(".hangar-rail-btn.back")!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
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
