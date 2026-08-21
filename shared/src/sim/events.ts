import type { DamageType } from "../schemas/common.js";
import type { EntityId } from "./components.js";
import type { ModuleState } from "./components.js";

/**
 * Sim-produced events drained by the caller each tick. The sim never knows about
 * rendering/audio; it only announces what happened by id so a render/HUD layer
 * (or the netcode) can react. Action-id hooks (`onFire`, `onActivate`, ...) are
 * surfaced here as `actions` arrays — interpretation lives outside the sim.
 */
export type SimEvent =
  /** Auto-targeting picked (or dropped) a lock candidate — `targetId: null` means dropped. */
  | { type: "targetSet"; entityId: EntityId; targetId: EntityId | null }
  /** Lock completed on `targetId` — weapons are now free to fire (FLIGHT.md §2). */
  | { type: "lockAcquired"; entityId: EntityId; targetId: EntityId }
  /** Lock broke (progress drained to 0, or the target died/changed). */
  | { type: "lockLost"; entityId: EntityId }
  | {
      type: "moduleStateChanged";
      entityId: EntityId;
      hardpointIndex: number;
      moduleId: string;
      from: ModuleState;
      to: ModuleState;
      actions?: string[];
    }
  /**
   * A ship blew its countermeasure pod clear (owner 2026-07-31): the decoy is live and
   * `decoyId` is drifting behind it as a lure. Renderers flash the dump, HUDs
   * start the cooldown readout.
   */
  | { type: "countermeasureJettisoned"; entityId: EntityId; decoyId: EntityId; moduleId: string; actions?: string[] }
  | {
      type: "projectileFired";
      ownerId: EntityId;
      moduleId: string;
      kind: "beam" | "kinetic" | "missile";
      projectileId?: EntityId;
      targetId: EntityId | null;
      actions?: string[];
    }
  | {
      type: "damage";
      targetId: EntityId;
      sourceId: EntityId | null;
      amount: number;
      damageType: DamageType;
      isAsteroid: boolean;
    }
  | {
      type: "shieldAbsorb";
      targetId: EntityId;
      sourceId: EntityId | null;
      hardpointIndex: number;
      /** Shield CHARGE spent soaking the hit — the module's own accounting. */
      amount: number;
      /**
       * Hull the soak SAVED: `amount` carried through the hull stage
       * (`× hullMult × (1 - resist)`). Distinct from `amount` — an energy hit
       * soaked for 10 charge only ever threatened 5 hull — and it is this one a
       * HUD floats, because a "damage avoided" number is only readable next to
       * the damage numbers if it is measured the same way.
       */
      hullAvoided: number;
      damageType: DamageType;
    }
  | {
      type: "entityDestroyed";
      entityId: EntityId;
      killerId: EntityId | null;
      isAsteroid: boolean;
      team?: number;
      /** World-space death point captured before cleanup removes the entity. */
      pos?: { x: number; y: number; z: number };
    }
  | { type: "boundaryHit"; entityId: EntityId; rule: "bounce" | "damage" | "damageAndBounce" | "warning" }
  /**
   * Capture-the-flag beats (owner 2026-07-31). `flagTeam` is always the team the
   * flag BELONGS to — the one defending it — so a HUD can phrase every one of
   * these from the viewer's side ("they have your flag" vs "you have theirs")
   * without tracking flag identity itself.
   */
  | { type: "flagTaken"; flagId: EntityId; flagTeam: number; carrierId: EntityId; carrierTeam: number }
  /** A carrier died or left: the flag is loose in space with `returnSec` on its clock. */
  | { type: "flagDropped"; flagId: EntityId; flagTeam: number; carrierId: EntityId | null; returnSec: number }
  /**
   * The flag is back on its stand. `byId` is the defender who touched it home,
   * or null when its drop timer simply ran out.
   */
  | { type: "flagReturned"; flagId: EntityId; flagTeam: number; byId: EntityId | null; timedOut: boolean }
  /** A run scored. `scoringTeam` took `flagTeam`'s flag to its own base. */
  | {
      type: "flagCaptured";
      flagId: EntityId;
      flagTeam: number;
      carrierId: EntityId;
      scoringTeam: number;
      captures: number;
    }
  /**
   * One whole second ticked off the start countdown. `remaining` is the number
   * now on screen (3, then 2, then 1) — the same integer the HUD displays, so
   * the audio cue and the numeral can never disagree. Emitted by the sim, which
   * makes the beat identical for both clients of an online match.
   */
  | { type: "countdownTick"; remaining: number }
  /** The countdown reached zero: the match is live this tick ("GO"). */
  | { type: "matchStarted" }
  | { type: "matchEnded"; winnerTeam: number | null; reason: "winCondition" | "elimination" };

export type SimEventType = SimEvent["type"];
