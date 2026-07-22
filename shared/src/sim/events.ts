import type { DamageType } from "../schemas/common.js";
import type { EntityId } from "./components.js";
import type { ModuleState } from "./components.js";

/**
 * Sim-produced events drained by the caller each tick. The sim never knows about
 * rendering/audio; it only announces what happened by id so a render/HUD layer
 * (or the netcode) can react. Action-id hooks (`onFire`, `onOverheat`, ...) are
 * surfaced here as `actions` arrays — interpretation lives outside the sim.
 */
export type SimEvent =
  | { type: "moveOrderSet"; entityId: EntityId; target: { x: number; z: number }; boost: boolean }
  | { type: "moveOrderCleared"; entityId: EntityId }
  | { type: "targetSet"; entityId: EntityId; targetId: EntityId | null }
  | {
      type: "moduleStateChanged";
      entityId: EntityId;
      hardpointIndex: number;
      moduleId: string;
      from: ModuleState;
      to: ModuleState;
      actions?: string[];
    }
  | { type: "overheated"; entityId: EntityId; hardpointIndex: number; moduleId: string; actions?: string[] }
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
  | { type: "shieldAbsorb"; targetId: EntityId; hardpointIndex: number; amount: number }
  | { type: "entityDestroyed"; entityId: EntityId; killerId: EntityId | null; isAsteroid: boolean; team?: number }
  | { type: "boundaryHit"; entityId: EntityId; rule: "bounce" | "damage" | "warning" }
  | { type: "matchEnded"; winnerTeam: number | null; reason: "winCondition" | "elimination" };

export type SimEventType = SimEvent["type"];
