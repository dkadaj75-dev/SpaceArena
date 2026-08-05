import type { EntityId } from "./components.js";
import type { SimEvent } from "./events.js";

/** Damage older than this cannot earn an assist. Measured in deterministic sim seconds. */
export const ASSIST_WINDOW_SEC = 8;

export interface MatchStatLine {
  entityId: EntityId;
  kills: number;
  deaths: number;
  assists: number;
  flagsTaken: number;
  flagsDropped: number;
  flagsReturned: number;
  flagsCaptured: number;
}

export type MatchStatKey = Exclude<keyof MatchStatLine, "entityId">;
export interface MatchStatDelta { entityId: EntityId; stat: MatchStatKey; value: number }

function fresh(entityId: EntityId): MatchStatLine {
  return { entityId, kills: 0, deaths: 0, assists: 0, flagsTaken: 0, flagsDropped: 0, flagsReturned: 0, flagsCaptured: 0 };
}

/** Deterministic event-fold used by local practice and the authoritative room. */
export class MatchStatsAccumulator {
  private readonly lines = new Map<EntityId, MatchStatLine>();
  private readonly damageByVictim = new Map<EntityId, Map<EntityId, number>>();

  constructor(private readonly teamOf: (id: EntityId) => number | undefined = () => undefined) {}

  line(entityId: EntityId): Readonly<MatchStatLine> {
    let line = this.lines.get(entityId);
    if (!line) { line = fresh(entityId); this.lines.set(entityId, line); }
    return line;
  }

  all(): readonly Readonly<MatchStatLine>[] { return [...this.lines.values()]; }
  forEach(visitor: (line: Readonly<MatchStatLine>) => void): void { this.lines.forEach(visitor); }

  applyDelta(delta: MatchStatDelta): void {
    (this.line(delta.entityId) as MatchStatLine)[delta.stat] = delta.value;
  }

  consume(events: readonly SimEvent[], elapsedSec: number): MatchStatDelta[] {
    const deltas: MatchStatDelta[] = [];
    const bump = (id: EntityId, stat: MatchStatKey): void => {
      const line = this.line(id) as MatchStatLine;
      line[stat]++;
      deltas.push({ entityId: id, stat, value: line[stat] });
    };
    for (const ev of events) {
      if ((ev.type === "damage" || ev.type === "shieldAbsorb") && ev.sourceId !== null && ev.sourceId !== ev.targetId) {
        let attackers = this.damageByVictim.get(ev.targetId);
        if (!attackers) { attackers = new Map(); this.damageByVictim.set(ev.targetId, attackers); }
        attackers.set(ev.sourceId, elapsedSec);
        continue;
      }
      if (ev.type === "entityDestroyed" && !ev.isAsteroid) {
        bump(ev.entityId, "deaths");
        const killer = ev.killerId;
        const victimTeam = ev.team ?? this.teamOf(ev.entityId);
        const creditedKill = killer !== null && killer !== ev.entityId && this.teamOf(killer) !== victimTeam;
        if (creditedKill) bump(killer, "kills");
        const attackers = this.damageByVictim.get(ev.entityId);
        if (creditedKill && attackers) {
          for (const [attacker, lastDamageSec] of attackers) {
            if (attacker !== killer && attacker !== ev.entityId && elapsedSec - lastDamageSec <= ASSIST_WINDOW_SEC && this.teamOf(attacker) !== victimTeam) {
              bump(attacker, "assists");
            }
          }
        }
        this.damageByVictim.delete(ev.entityId);
        continue;
      }
      if (ev.type === "flagTaken") bump(ev.carrierId, "flagsTaken");
      else if (ev.type === "flagDropped" && ev.carrierId !== null) bump(ev.carrierId, "flagsDropped");
      else if (ev.type === "flagReturned" && ev.byId !== null) bump(ev.byId, "flagsReturned");
      else if (ev.type === "flagCaptured") bump(ev.carrierId, "flagsCaptured");
    }
    return deltas;
  }
}
