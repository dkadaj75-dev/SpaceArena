// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLocalFittings,
  deleteLocalFitting,
  isLocalFittingId,
  listLocalFittings,
  saveLocalFitting,
  LOCAL_FITTING_PREFIX,
} from "./offlineFittings.js";

describe("offline fittings (testing affordance, owner 2026-07-31)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty and saves a fitting that reads back", () => {
    expect(listLocalFittings()).toEqual([]);
    const saved = saveLocalFitting({
      shipId: "ship.interceptor",
      name: "Test Fit",
      hardpointMap: { "0": "module.laser-mk1" },
      now: () => 1000,
    });
    expect(saved.id).toBe(`${LOCAL_FITTING_PREFIX}ship.interceptor:1000`);
    expect(listLocalFittings()).toEqual([saved]);
  });

  it("marks its ids so they are never mistaken for server ones", () => {
    const saved = saveLocalFitting({ shipId: "ship.brawler", name: "A", hardpointMap: {} });
    expect(isLocalFittingId(saved.id)).toBe(true);
    expect(isLocalFittingId("fit-abc123")).toBe(false);
    expect(isLocalFittingId(null)).toBe(false);
  });

  it("UPDATES in place when given an existing id, keeping its slot in the list", () => {
    const a = saveLocalFitting({ shipId: "ship.interceptor", name: "A", hardpointMap: {}, now: () => 1 });
    const b = saveLocalFitting({ shipId: "ship.interceptor", name: "B", hardpointMap: {}, now: () => 2 });
    const updated = saveLocalFitting({
      id: a.id,
      shipId: "ship.interceptor",
      name: "A renamed",
      hardpointMap: { "1": "module.missile-mk1" },
      now: () => 3,
    });

    expect(updated.id).toBe(a.id); // same record, not a duplicate
    expect(updated.created_at).toBe(a.created_at);
    const all = listLocalFittings();
    expect(all).toHaveLength(2);
    expect(all[0]!.name).toBe("A renamed");
    expect(all[0]!.hardpointMap).toEqual({ "1": "module.missile-mk1" });
    expect(all[1]!.id).toBe(b.id);
  });

  it("appends rather than updating when the id is a SERVER id", () => {
    saveLocalFitting({ shipId: "ship.interceptor", name: "A", hardpointMap: {}, now: () => 1 });
    saveLocalFitting({ id: "fit-server", shipId: "ship.interceptor", name: "B", hardpointMap: {}, now: () => 2 });
    expect(listLocalFittings()).toHaveLength(2);
  });

  it("deletes by id and ignores an unknown one", () => {
    const a = saveLocalFitting({ shipId: "ship.interceptor", name: "A", hardpointMap: {}, now: () => 1 });
    saveLocalFitting({ shipId: "ship.interceptor", name: "B", hardpointMap: {}, now: () => 2 });
    deleteLocalFitting(a.id);
    expect(listLocalFittings().map((f) => f.name)).toEqual(["B"]);
    deleteLocalFitting("nope");
    expect(listLocalFittings()).toHaveLength(1);
  });

  it("keeps fittings for different hulls side by side (the Hangar filters by ship)", () => {
    saveLocalFitting({ shipId: "ship.interceptor", name: "Light", hardpointMap: {}, now: () => 1 });
    saveLocalFitting({ shipId: "ship.brawler", name: "Heavy", hardpointMap: {}, now: () => 2 });
    expect(listLocalFittings().map((f) => f.ship_id)).toEqual(["ship.interceptor", "ship.brawler"]);
  });

  it("survives corrupt or hand-edited storage rather than breaking the Hangar", () => {
    localStorage.setItem("hangar.localFittings", "{not json");
    expect(listLocalFittings()).toEqual([]);
    localStorage.setItem("hangar.localFittings", JSON.stringify({ not: "an array" }));
    expect(listLocalFittings()).toEqual([]);
    // A well-formed array with junk entries keeps only the valid records.
    localStorage.setItem(
      "hangar.localFittings",
      JSON.stringify([{ id: "local:x", ship_id: "ship.interceptor", name: "ok", hardpointMap: {} }, 7, null]),
    );
    expect(listLocalFittings().map((f) => f.name)).toEqual(["ok"]);
  });

  it("clears the whole store", () => {
    saveLocalFitting({ shipId: "ship.interceptor", name: "A", hardpointMap: {} });
    clearLocalFittings();
    expect(listLocalFittings()).toEqual([]);
  });
});
