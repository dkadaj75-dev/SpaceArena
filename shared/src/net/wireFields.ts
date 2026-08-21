/**
 * The field-name contract for the replicated arena state.
 *
 * ## Why this file exists
 *
 * `server/src/rooms/state/ArenaState.ts` DECLARES the wire format and
 * `shared/src/net/decodeState.ts` READS it — through `any`, because a Colyseus
 * state instance is rebuilt on the client from a runtime reflection payload and
 * there is no generated type to bind the two halves together. There is also no
 * import path between them, and there cannot be a direct one: the schema needs
 * `experimentalDecorators` + `useDefineForClassFields:false`, which the client
 * project deliberately does not enable. `npm run typecheck` therefore cannot
 * see the coupling at all.
 *
 * The consequence, before this file existed: renaming `FlagState.dropRemaining`
 * — the declaration plus its single writer in `ArenaRoom`, which is a
 * consistent, type-checking, lint-clean edit — left the decoder reading
 * `f.dropRemaining ?? 0` forever. Every dropped flag would silently show a
 * 0-second return timer in production with nothing anywhere going red.
 *
 * So the names are written down ONCE, here in `shared` (the only package both
 * sides import), and both sides are checked against this list:
 *
 *  - The **server** asserts `Object.keys(new Cls())` equals the list, in
 *    `server/src/rooms/state/ArenaState.test.ts`. That is the CI gate: a rename
 *    fails the build unless the renamer also edits this file — at which point
 *    the decoders are one grep away and in the same diff.
 *  - The **client** calls {@link checkWireState} once, on the first
 *    authoritative state (`NetGameSession.receiveState`). That is the runtime
 *    backstop for the case CI structurally cannot see: a deployed server whose
 *    schema no longer matches the bundle a browser is running.
 *
 * ## What this does NOT catch
 *
 * Renames, not absences. The decoders are full of `?? 0` / `?? "Pilot"`
 * fallbacks, so a field whose *writer* is deleted server-side keeps its
 * declaration, passes every check here, and still decodes to the fallback. That
 * class of drift is caught by the value round-trip in
 * `server/src/rooms/state/replicate.test.ts` instead. The two mechanisms are
 * complementary and neither replaces the other — do not read a green contract
 * check as "the field still works".
 */

/**
 * Declared field names per schema class, in DECLARATION ORDER.
 *
 * The order is load-bearing, not cosmetic: `@colyseus/schema` encodes fields by
 * their declaration index, so swapping two fields of the same primitive type is
 * a silent protocol break in exactly the way a rename is. Pinning the order
 * makes that fail the server assertion too.
 *
 * 72 fields across 8 classes. Keep the per-class comment counts up to date —
 * they are the cheapest possible review signal that a field was added or lost.
 */
export const WIRE_FIELDS = {
  /** 12 */
  ModuleState: Object.freeze([
    "moduleId",
    "hardpointIndex",
    "state",
    "stateTimer",
    "rounds",
    "energy",
    "energyCapacity",
    "cycleTimer",
    "channeling",
    "shieldPool",
  ]),
  /** 27 */
  PlayerState: Object.freeze([
    "entityId",
    "team",
    "shipId",
    "displayName",
    "isBot",
    "alive",
    "cosmeticId",
    "x",
    "y",
    "z",
    "heading",
    "pitch",
    "upX",
    "upY",
    "upZ",
    "vx",
    "vy",
    "vz",
    "hull",
    "hullMax",
    "shieldPool",
    "throttle",
    "launchHold",
    "launchLocked",
    "lockProgress",
    "locked",
    "targetId",
    "modules",
  ]),
  /** 5 */
  ProjectileState: Object.freeze(["entityId", "x", "y", "z", "heading"]),
  /** 1 */
  AsteroidState: Object.freeze(["destroyed"]),
  /** 7 */
  DecoyState: Object.freeze(["entityId", "team", "x", "y", "z", "radius", "lifeFraction"]),
  /** 8 */
  FlagState: Object.freeze([
    "entityId",
    "team",
    "state",
    "x",
    "y",
    "z",
    "carrierEntityId",
    "dropRemaining",
  ]),
  /** 2 */
  TeamScoreState: Object.freeze(["kills", "captures"]),
  /** 11 */
  ArenaState: Object.freeze([
    "matchPhase",
    "matchTimer",
    "countdownRemaining",
    "lobbyRemainingSec",
    "winnerTeam",
    "teamScores",
    "players",
    "projectiles",
    "asteroids",
    "decoys",
    "flags",
  ]),
} as const;

Object.freeze(WIRE_FIELDS);

export type WireClassName = keyof typeof WIRE_FIELDS;

/** Every class in the contract, for suites that want to iterate all of them. */
export const WIRE_CLASS_NAMES = Object.keys(WIRE_FIELDS) as WireClassName[];

/**
 * Which class each `ArenaState` collection holds. Written out rather than
 * inferred because the map's VALUE type is the part {@link checkWireState} has
 * to know to look one level down — the schema itself does not expose it in a
 * form a plain `any` walk can read.
 */
const ARENA_COLLECTIONS: Readonly<Record<string, WireClassName>> = Object.freeze({
  teamScores: "TeamScoreState",
  players: "PlayerState",
  projectiles: "ProjectileState",
  asteroids: "AsteroidState",
  decoys: "DecoyState",
  flags: "FlagState",
});

/** The one nested collection: `PlayerState.modules` is an ArraySchema of these. */
const PLAYER_COLLECTIONS: Readonly<Record<string, WireClassName>> = Object.freeze({
  modules: "ModuleState",
});

/**
 * Compare one object's own enumerable keys against the contract for `cls`.
 *
 * Returns `null` when they match exactly (names AND order), or a human-readable
 * one-line description of the difference. A rename shows up as one missing and
 * one unexpected name, which is precisely the message a reader needs.
 *
 * `Object.keys` is the right probe here: schema 3.x's legacy decorators define
 * the declared names as enumerable own properties ON THE INSTANCE (the backing
 * `_field` stores are non-enumerable), so a freshly constructed instance
 * enumerates exactly its declared fields, in declaration order.
 */
export function wireFieldMismatch(cls: WireClassName, actual: readonly string[]): string | null {
  const expected = WIRE_FIELDS[cls] as readonly string[];
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length === 0 && unexpected.length === 0) {
    const reordered = expected.some((name, i) => actual[i] !== name);
    return reordered
      ? `${cls}: wire field ORDER changed (colyseus encodes by declaration index) — ` +
          `expected [${expected.join(", ")}], got [${actual.join(", ")}]`
      : null;
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing [${missing.join(", ")}]`);
  if (unexpected.length > 0) parts.push(`unexpected [${unexpected.join(", ")}]`);
  return `${cls}: ${parts.join(", ")}`;
}

/** First entry of a MapSchema / ArraySchema / plain object, or undefined. */
function firstEntry(value: unknown): object | undefined {
  if (!value || typeof value !== "object") return undefined;
  const iterable = value as { values?: () => Iterable<unknown> };
  if (typeof iterable.values === "function") {
    for (const entry of iterable.values()) {
      if (entry && typeof entry === "object") return entry as object;
    }
    return undefined;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object") return entry as object;
  }
  return undefined;
}

/**
 * Runtime check of a live replicated state against the contract, used by the
 * client. Returns the problems found; an empty array means "nothing detectably
 * wrong".
 *
 * Only the classes the state actually carries an instance of can be checked —
 * an empty `decoys` map proves nothing about `DecoyState`. That is fine: this
 * is a backstop for a version-skewed deployment, and the exhaustive per-class
 * assertion already runs server-side in CI where every class can be constructed.
 *
 * A state with NO enumerable keys at all reports nothing rather than reporting
 * everything: some Colyseus builds hand the callback a proxy whose fields are
 * not own-enumerable, and "the whole schema is missing" is far more likely to
 * be that than a real 11-field rename. Crying wolf on the netcode's first
 * patch is worse than staying quiet.
 */
export function checkWireState(state: unknown): string[] {
  if (!state || typeof state !== "object") return [];
  const rootKeys = Object.keys(state);
  if (rootKeys.length === 0) return [];

  const problems: string[] = [];
  const root = wireFieldMismatch("ArenaState", rootKeys);
  if (root) problems.push(root);

  const asRecord = state as Record<string, unknown>;
  for (const [field, cls] of Object.entries(ARENA_COLLECTIONS)) {
    const sample = firstEntry(asRecord[field]);
    if (!sample) continue;
    const mismatch = wireFieldMismatch(cls, Object.keys(sample));
    if (mismatch) problems.push(mismatch);
    if (cls !== "PlayerState") continue;
    for (const [nested, nestedCls] of Object.entries(PLAYER_COLLECTIONS)) {
      const nestedSample = firstEntry((sample as Record<string, unknown>)[nested]);
      if (!nestedSample) continue;
      const nestedMismatch = wireFieldMismatch(nestedCls, Object.keys(nestedSample));
      if (nestedMismatch) problems.push(nestedMismatch);
    }
  }
  return problems;
}
