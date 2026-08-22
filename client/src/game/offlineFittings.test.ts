// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clearLocalLoadouts, loadLocalLoadout, saveLocalLoadout } from "./offlineFittings.js";

const STORE_KEY = "hangar.loadouts";
const LEGACY_KEY = "hangar.localFittings";
const LEGACY_SELECTED_KEY = "hangar.fittingId";

describe("offline loadouts (testing affordance, owner 2026-07-31)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty, and a hull that was never fitted reads back as null", () => {
    // Null is not the same answer as an empty map: the Hangar opens a hull it
    // has never seen on the STOCK fit, not on a bare hull nobody chose.
    expect(loadLocalLoadout("ship.interceptor")).toBeNull();
  });

  it("saves one loadout per hull, keyed by ship, and overwrites in place", () => {
    saveLocalLoadout("ship.interceptor", { "0": "module.laser-mk1" });
    saveLocalLoadout("ship.brawler", { "0": "module.kinetic-mk1" });
    expect(loadLocalLoadout("ship.interceptor")).toEqual({ "0": "module.laser-mk1" });
    expect(loadLocalLoadout("ship.brawler")).toEqual({ "0": "module.kinetic-mk1" });

    // A second fit of the same hull REPLACES the first — there is no list to
    // grow, because a hull has exactly one loadout (owner 2026-08-22).
    saveLocalLoadout("ship.interceptor", { "1": "module.shield-mk1" });
    expect(loadLocalLoadout("ship.interceptor")).toEqual({ "1": "module.shield-mk1" });
    expect(Object.keys(JSON.parse(localStorage.getItem(STORE_KEY)!) as object)).toHaveLength(2);
  });

  it("stores an EMPTY loadout as a real answer, distinct from never-fitted", () => {
    saveLocalLoadout("ship.interceptor", {});
    expect(loadLocalLoadout("ship.interceptor")).toEqual({});
    expect(loadLocalLoadout("ship.brawler")).toBeNull();
  });

  it("survives corrupt or hand-edited storage rather than breaking the Hangar", () => {
    localStorage.setItem(STORE_KEY, "{not json");
    expect(loadLocalLoadout("ship.interceptor")).toBeNull();
    localStorage.setItem(STORE_KEY, JSON.stringify(["not", "an object"]));
    expect(loadLocalLoadout("ship.interceptor")).toBeNull();
    // A well-formed object with junk entries keeps only the valid maps.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ "ship.interceptor": { "0": "module.laser-mk1" }, "ship.brawler": 7 }),
    );
    expect(loadLocalLoadout("ship.interceptor")).toEqual({ "0": "module.laser-mk1" });
    expect(loadLocalLoadout("ship.brawler")).toBeNull();
  });

  it("clears the whole store", () => {
    saveLocalLoadout("ship.interceptor", { "0": "module.laser-mk1" });
    clearLocalLoadouts();
    expect(loadLocalLoadout("ship.interceptor")).toBeNull();
  });
});

/**
 * A browser that used the old named-fitting UI still has its array in
 * `localStorage`. Owner 2026-08-22: those must not wedge anything — "the
 * previously-selected (or most recent) fitting for each ship becomes that
 * ship's implicit loadout; the rest are ignored".
 */
describe("migrating a pre-2026-08-22 browser's named fittings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** Write the legacy store in the shape the old `saveLocalFitting` produced. */
  function legacy(entries: { id: string; ship: string; map: Record<string, string> }[], selectedId?: string): void {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify(entries.map((e) => ({ id: e.id, user_id: "local", ship_id: e.ship, name: e.id, hardpointMap: e.map, created_at: "" }))),
    );
    if (selectedId) localStorage.setItem(LEGACY_SELECTED_KEY, selectedId);
  }

  it("keeps the SELECTED fitting for its hull, and the newest for every other", () => {
    legacy(
      [
        { id: "local:a", ship: "ship.interceptor", map: { "0": "module.laser-mk1" } },
        { id: "local:b", ship: "ship.interceptor", map: { "0": "module.kinetic-mk1" } },
        { id: "local:c", ship: "ship.brawler", map: { "0": "module.shield-mk1" } },
        { id: "local:d", ship: "ship.brawler", map: { "1": "module.reactor-mk1" } },
      ],
      "local:a", // the interceptor fit the player actually had selected
    );

    // Selected beats newest where the player told us which one they flew…
    expect(loadLocalLoadout("ship.interceptor")).toEqual({ "0": "module.laser-mk1" });
    // …and where they did not, the last one saved is the closest honest guess.
    expect(loadLocalLoadout("ship.brawler")).toEqual({ "1": "module.reactor-mk1" });
  });

  it("consumes the legacy keys, so it can never run twice over live edits", () => {
    legacy([{ id: "local:a", ship: "ship.interceptor", map: { "0": "module.laser-mk1" } }]);
    loadLocalLoadout("ship.interceptor");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_SELECTED_KEY)).toBeNull();

    // A later edit is not re-overwritten by a second read.
    saveLocalLoadout("ship.interceptor", { "1": "module.kinetic-mk1" });
    expect(loadLocalLoadout("ship.interceptor")).toEqual({ "1": "module.kinetic-mk1" });
  });

  it("never overwrites a store that already exists", () => {
    saveLocalLoadout("ship.interceptor", { "0": "module.kinetic-mk1" });
    legacy([{ id: "local:a", ship: "ship.interceptor", map: { "0": "module.laser-mk1" } }]);
    expect(loadLocalLoadout("ship.interceptor")).toEqual({ "0": "module.kinetic-mk1" });
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("drops a corrupt legacy store instead of wedging the Hangar on it", () => {
    localStorage.setItem(LEGACY_KEY, "{not json");
    localStorage.setItem(LEGACY_SELECTED_KEY, "local:a");
    expect(loadLocalLoadout("ship.interceptor")).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_SELECTED_KEY)).toBeNull();
  });
});
