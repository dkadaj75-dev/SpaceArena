import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type LinesMesh,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  type EntityId,
  type ShipSnapshot,
  type SimEvent,
  type Snapshot,
} from "@space-arena/shared";

const log = createLogger("OrderMarkers");

const MARKER_Y = 0.15;
const MOVE_COLOR = new Color3(0.35, 0.85, 1.0);
const BOOST_COLOR = new Color3(1.0, 0.7, 0.25);
const TEAM_COLORS = [new Color3(0.2, 0.55, 1.0), new Color3(1.0, 0.35, 0.25)];

/**
 * In-world order feedback for the local player (§2.2 reference art): a dashed
 * path line from the ship to its move target, a pulsing destination ring
 * (tinted for boost), and a team-colored ring under the focused target.
 *
 * Fed by drained sim events (`moveOrderSet` / `moveOrderCleared` set/clear the
 * move target; arrival is surfaced by the sim as `moveOrderCleared`) plus the
 * per-frame snapshot for live ship/target positions. All meshes are created once
 * and reused — updates mutate existing geometry/transforms, no per-frame alloc.
 */
export class OrderMarkers {
  private pathLine: LinesMesh;
  private readonly destRing: Mesh;
  private readonly targetRing: Mesh;

  private moveTarget: { x: number; z: number } | null = null;
  private boost = false;
  private pulseT = 0;

  // Reused scratch for the 2-point dashed line.
  private readonly linePoints = [new Vector3(), new Vector3()];

  constructor(
    private readonly scene: Scene,
    private readonly playerId: EntityId,
  ) {
    this.pathLine = MeshBuilder.CreateDashedLines(
      "orderPath",
      { points: this.linePoints, dashSize: 2, gapSize: 1, dashNb: 40, updatable: true },
      scene,
    );
    this.pathLine.color = MOVE_COLOR;
    this.pathLine.isPickable = false;
    this.pathLine.setEnabled(false);

    const destMat = new StandardMaterial("mat.destRing", scene);
    destMat.emissiveColor = MOVE_COLOR;
    destMat.diffuseColor = Color3.Black();
    destMat.specularColor = Color3.Black();
    this.destRing = MeshBuilder.CreateTorus("destRing", { diameter: 4, thickness: 0.35, tessellation: 32 }, scene);
    this.destRing.material = destMat;
    this.destRing.isPickable = false;
    this.destRing.setEnabled(false);

    const targetMat = new StandardMaterial("mat.targetRing", scene);
    targetMat.emissiveColor = TEAM_COLORS[1]!;
    targetMat.diffuseColor = Color3.Black();
    targetMat.specularColor = Color3.Black();
    this.targetRing = MeshBuilder.CreateTorus("targetRing", { diameter: 5, thickness: 0.3, tessellation: 32 }, scene);
    this.targetRing.material = targetMat;
    this.targetRing.isPickable = false;
    this.targetRing.setEnabled(false);
  }

  consumeEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === "moveOrderSet" && ev.entityId === this.playerId) {
        this.moveTarget = ev.target;
        this.boost = ev.boost;
        const color = ev.boost ? BOOST_COLOR : MOVE_COLOR;
        this.pathLine.color = color;
        (this.destRing.material as StandardMaterial).emissiveColor = color;
      } else if (ev.type === "moveOrderCleared" && ev.entityId === this.playerId) {
        this.moveTarget = null; // arrival or cancel
      }
    }
  }

  render(cur: Snapshot, dtMs: number): void {
    this.pulseT += dtMs / 1000;
    const player = findShip(cur, this.playerId);

    // Move path + destination ring.
    if (this.moveTarget && player) {
      this.linePoints[0]!.set(player.pos.x, MARKER_Y, player.pos.z);
      this.linePoints[1]!.set(this.moveTarget.x, MARKER_Y, this.moveTarget.z);
      this.pathLine = MeshBuilder.CreateDashedLines("orderPath", {
        points: this.linePoints,
        instance: this.pathLine,
      });
      this.pathLine.setEnabled(true);

      this.destRing.position.set(this.moveTarget.x, MARKER_Y, this.moveTarget.z);
      const pulse = 1 + Math.sin(this.pulseT * 5) * 0.12;
      this.destRing.scaling.set(pulse, pulse, pulse);
      this.destRing.setEnabled(true);
    } else {
      this.pathLine.setEnabled(false);
      this.destRing.setEnabled(false);
    }

    // Focused-target ring.
    const targetId = player?.targetId ?? null;
    const target = targetId !== null ? findShip(cur, targetId) : undefined;
    if (target) {
      this.targetRing.position.set(target.pos.x, MARKER_Y, target.pos.z);
      (this.targetRing.material as StandardMaterial).emissiveColor =
        TEAM_COLORS[target.team % TEAM_COLORS.length]!;
      this.targetRing.setEnabled(true);
    } else {
      this.targetRing.setEnabled(false);
    }
  }

  dispose(): void {
    this.pathLine.dispose();
    this.destRing.material?.dispose();
    this.destRing.dispose();
    this.targetRing.material?.dispose();
    this.targetRing.dispose();
    log.debug("disposed");
  }
}

function findShip(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}
