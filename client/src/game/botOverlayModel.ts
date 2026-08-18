import {
  hasLineOfSightAmong,
  type BotDecisionSnapshot,
  type EntityId,
  type LosCircle,
  type ModuleDecision,
  type ShipSnapshot,
  type Snapshot,
  type StaticLosWorld,
} from "@space-arena/shared";

/** localStorage key holding the live bot overlay's on/off state. */
export const BOT_OVERLAY_STORAGE_KEY = "sa.botOverlay";
/** Window event fired whenever the flag changes, whoever wrote it. */
export const BOT_OVERLAY_EVENT = "sa:bot-overlay";
/** Key that toggles the overlay (F9 is the net telemetry overlay). */
export const BOT_OVERLAY_KEY = "F8";

/** Read the persisted overlay flag (defaults to off; private mode safe). */
export function botOverlayEnabled(): boolean {
  try {
    return localStorage.getItem(BOT_OVERLAY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the overlay flag and notify any live overlay in this document. */
export function setBotOverlayEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(BOT_OVERLAY_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode — the event still drives the running overlay */
  }
  window.dispatchEvent(new CustomEvent(BOT_OVERLAY_EVENT, { detail: enabled }));
}

/** One behaviour's utility score, plus its share of the frame's best score. */
export interface BotScoreBar {
  key: string;
  score: number;
  /** `score / max(scores)`, in 0..1 — the bar length. */
  fraction: number;
  /** True for the behaviour that actually won this decision. */
  chosen: boolean;
}

/**
 * View model for one bot card + its in-scene lines. Pooled and mutated in place:
 * the overlay runs every render frame, so nothing here may allocate per frame.
 * Positions refresh every frame; the text/score fields only when
 * {@link BotOverlayRow.decision} changes identity (once per bot decision tick).
 */
export interface BotOverlayRow {
  entityId: EntityId;
  profileId: string;
  profileName: string;
  /** Decision the text/score fields were derived from (identity = change flag). */
  decision: BotDecisionSnapshot | null;
  behavior: string;
  engaged: boolean;
  scores: BotScoreBar[];
  /** Live prefix length of {@link scores} (the array itself is a pool). */
  scoreCount: number;
  modules: readonly ModuleDecision[];
  /** Ship still present in the snapshot (dead bots keep a card until removed). */
  alive: boolean;
  posX: number;
  posZ: number;
  hasMove: boolean;
  moveX: number;
  moveZ: number;
  hasTarget: boolean;
  targetX: number;
  targetZ: number;
  /** Line of sight from the bot to its target is unobstructed. */
  losClear: boolean;
}

/** The slice of a `BotDriver` the overlay reads (keeps this module Babylon-free and testable). */
export interface BotOverlaySource {
  entityId: EntityId;
  profile: { id: string; name?: string };
  lastDecision: BotDecisionSnapshot | null;
}

function emptyRow(): BotOverlayRow {
  return {
    entityId: 0 as EntityId,
    profileId: "",
    profileName: "",
    decision: null,
    behavior: "—",
    engaged: false,
    scores: [],
    scoreCount: 0,
    modules: [],
    alive: false,
    posX: 0,
    posZ: 0,
    hasMove: false,
    moveX: 0,
    moveZ: 0,
    hasTarget: false,
    targetX: 0,
    targetZ: 0,
    losClear: true,
  };
}

/**
 * Refresh `blockers` (asteroid LoS spheres) from a snapshot in place. Entry
 * objects are reused; only a *growing* asteroid count allocates, which cannot
 * happen mid-match.
 */
export function collectBlockers(snapshot: Snapshot, blockers: LosCircle[]): void {
  let n = 0;
  for (let i = 0; i < snapshot.asteroids.length; i++) {
    const a = snapshot.asteroids[i]!;
    if (a.state === "destroyed") continue;
    const slot = blockers[n] as { pos: { x: number; z: number }; radius: number } | undefined;
    if (slot) {
      slot.pos = a.pos;
      slot.radius = a.radius;
    } else {
      blockers.push({ pos: a.pos, radius: a.radius });
    }
    n++;
  }
  blockers.length = n;
}

function findShip(snapshot: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snapshot.ships.length; i++) if (snapshot.ships[i]!.id === id) return snapshot.ships[i];
  return undefined;
}

/**
 * Map the live bot drivers onto pooled overlay rows. Returns how many leading
 * entries of `rows` are in use; `rows` grows to the bot count and is never
 * shrunk, so steady-state updates allocate nothing.
 */
export function updateBotOverlayRows(
  rows: BotOverlayRow[],
  bots: Iterable<BotOverlaySource>,
  snapshot: Snapshot,
  blockers: readonly LosCircle[],
  staticWorld?: StaticLosWorld,
): number {
  let n = 0;
  for (const bot of bots) {
    let row = rows[n];
    if (!row) {
      row = emptyRow();
      rows.push(row);
    }
    row.entityId = bot.entityId;
    row.profileId = bot.profile.id;
    row.profileName = bot.profile.name ?? bot.profile.id;

    const decision = bot.lastDecision;
    if (decision !== row.decision) {
      row.decision = decision;
      row.behavior = decision?.behavior ?? "—";
      row.engaged = decision?.engaged ?? false;
      row.modules = decision?.moduleDecisions ?? [];
      row.scoreCount = writeScores(row.scores, decision);
    }

    const self = findShip(snapshot, bot.entityId);
    row.alive = self !== undefined;
    if (self) {
      row.posX = self.pos.x;
      row.posZ = self.pos.z;
    }

    // `plannedMove` is where the winning behaviour wants the bot to be, even on
    // decisions that re-issued no order; fall back to the last ordered point.
    const move = decision?.plannedMove ?? decision?.movePoint ?? null;
    if (move) {
      row.hasMove = true;
      row.moveX = move.x;
      row.moveZ = move.z;
    } else if (!decision) {
      row.hasMove = false;
    }

    const targetId = decision?.targetId ?? null;
    const target = targetId !== null ? findShip(snapshot, targetId) : undefined;
    if (target && self) {
      row.hasTarget = true;
      row.targetX = target.pos.x;
      row.targetZ = target.pos.z;
      row.losClear = hasLineOfSightAmong(self.pos, target.pos, blockers, staticWorld);
    } else {
      row.hasTarget = false;
    }
    n++;
  }
  return n;
}

/** Fill the pooled score bars from a decision; returns the live count. */
function writeScores(pool: BotScoreBar[], decision: BotDecisionSnapshot | null): number {
  if (!decision) return 0;
  let max = 0;
  for (const key in decision.scores) {
    const score = decision.scores[key]!;
    if (score > max) max = score;
  }
  let n = 0;
  for (const key in decision.scores) {
    const score = decision.scores[key]!;
    const bar = pool[n];
    const fraction = max > 0 ? score / max : 0;
    const chosen = key === decision.behavior;
    if (bar) {
      bar.key = key;
      bar.score = score;
      bar.fraction = fraction;
      bar.chosen = chosen;
    } else {
      pool.push({ key, score, fraction, chosen });
    }
    n++;
  }
  return n;
}
