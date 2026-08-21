import { describe, expect, it } from "vitest";
import { WIRE_FIELDS, wireFieldMismatch, type WireClassName } from "@space-arena/shared";
import {
  ArenaState,
  AsteroidState,
  DecoyState,
  FlagState,
  ModuleState,
  PlayerState,
  ProjectileState,
  TeamScoreState,
} from "./ArenaState.js";

describe("ArenaState online objectives", () => {
  it("stores flags, countermeasure decoys, and capture scores as schema entities", () => {
    const state = new ArenaState();
    const decoy = new DecoyState();
    decoy.entityId = 9;
    state.decoys.set("9", decoy);
    const flag = new FlagState();
    flag.entityId = 17;
    flag.carrierEntityId = 42;
    state.flags.set("17", flag);
    const score = new TeamScoreState();
    score.captures = 2;
    state.teamScores.set("0", score);

    expect(state.decoys.get("9")?.entityId).toBe(9);
    expect(state.flags.get("17")?.carrierEntityId).toBe(42);
    expect(state.teamScores.get("0")?.captures).toBe(2);
    expect(new PlayerState().isBot).toBe(false);
  });
});

/**
 * Every schema class, paired with its contract entry. Declared here rather than
 * derived from `WIRE_FIELDS` so that ADDING a class to the contract without
 * adding it to this table (or the reverse) is itself a failure — the exhaustive
 * check below is only worth anything if it is actually exhaustive.
 */
const WIRE_CLASSES: ReadonlyArray<readonly [WireClassName, new () => object]> = [
  ["ModuleState", ModuleState],
  ["PlayerState", PlayerState],
  ["ProjectileState", ProjectileState],
  ["AsteroidState", AsteroidState],
  ["DecoyState", DecoyState],
  ["FlagState", FlagState],
  ["TeamScoreState", TeamScoreState],
  ["ArenaState", ArenaState],
];

/**
 * The server half of the wire field-name contract (see
 * `shared/src/net/wireFields.ts` for why it exists).
 *
 * This is the CI gate. The client decodes the replicated state through `any`
 * and there is no import path from the client back to this file, so nothing
 * else in the repo notices when a field here is renamed or reordered — the
 * decoder just falls through to its `?? 0` and the feature dies silently in
 * production. Renaming a field now fails HERE until the frozen list in `shared`
 * is updated too, which puts the decoders in the same diff as the rename.
 *
 * `Object.keys` on a constructed instance is the probe because schema 3.x's
 * legacy decorators define the declared names as enumerable own properties on
 * the instance (the `_field` backing stores are non-enumerable), so a fresh
 * instance enumerates exactly its declared fields in declaration order — which
 * is also the order colyseus encodes them in.
 *
 * NOTE what this does not do: it pins NAMES, not writers. A field whose server
 * writer is deleted still has its declaration and still passes here. The value
 * round-trip in `replicate.test.ts` is what covers that.
 */
describe("wire field-name contract", () => {
  it("covers exactly the classes the contract declares", () => {
    expect(WIRE_CLASSES.map(([name]) => name).sort()).toEqual(Object.keys(WIRE_FIELDS).sort());
  });

  it.each(WIRE_CLASSES)("%s declares exactly the contracted fields, in order", (name, Cls) => {
    expect(Object.keys(new Cls())).toEqual([...WIRE_FIELDS[name]]);
    expect(wireFieldMismatch(name, Object.keys(new Cls()))).toBeNull();
  });

  it("reports a rename as one missing plus one unexpected name", () => {
    const renamed = [...WIRE_FIELDS.FlagState].map((f) => (f === "dropRemaining" ? "dropSec" : f));
    expect(wireFieldMismatch("FlagState", renamed)).toBe(
      "FlagState: missing [dropRemaining], unexpected [dropSec]",
    );
  });
});
