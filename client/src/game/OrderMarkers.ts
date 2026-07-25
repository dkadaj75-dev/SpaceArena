import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  VertexBuffer,
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
/** Dashed move-path geometry: fixed segment count so the buffer never resizes. */
const DASH_COUNT = 40;
const DASH_SIZE = 2;
const GAP_SIZE = 1;
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
  private readonly pathLine: LinesMesh;
  private readonly destRing: Mesh;
  private readonly targetRing: Mesh;

  private moveTarget: { x: number; z: number } | null = null;
  private visible = true;
  private boost = false;
  private pulseT = 0;

  // Reused scratch for the 2-point dashed line.
  private readonly linePoints = [new Vector3(), new Vector3()];
  /**
   * Pre-sized position buffer for the dashed path, written in place every
   * frame. `MeshBuilder.CreateDashedLines(..., { instance })` would do the same
   * job but allocates a closure and a `Vector3` per call — this runs on every
   * frame the player has a move order standing.
   */
  private readonly dashPositions: Float32Array;
  private readonly dashCount: number;

  constructor(
    private readonly scene: Scene,
    private readonly playerId: EntityId,
  ) {
    this.linePoints[0]!.set(0, MARKER_Y, 0);
    this.linePoints[1]!.set(0, MARKER_Y, 1);
    this.pathLine = MeshBuilder.CreateDashedLines(
      "orderPath",
      { points: this.linePoints, dashSize: DASH_SIZE, gapSize: GAP_SIZE, dashNb: DASH_COUNT, updatable: true },
      scene,
    );
    const positions = this.pathLine.getVerticesData(VertexBuffer.PositionKind);
    this.dashPositions = new Float32Array(positions ? positions.length : 0);
    this.dashCount = this.dashPositions.length / 6;
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

  /**
   * Show/hide the order markers. `render()` re-enables meshes every frame, so
   * visibility has to be a latched flag it checks rather than a one-shot
   * `setEnabled` — see the dev editor, which hides the live match entirely.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.pathLine.setEnabled(false);
      this.destRing.setEnabled(false);
      this.targetRing.setEnabled(false);
    }
  }

  render(cur: Snapshot, dtMs: number): void {
    if (!this.visible) return;
    this.pulseT += dtMs / 1000;
    const player = findShip(cur, this.playerId);

    // Move path + destination ring.
    if (this.moveTarget && player) {
      this.updateDashedPath(player.pos.x, player.pos.z, this.moveTarget.x, this.moveTarget.z);
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

  /**
   * Rewrite the dashed path's vertex positions in place: `dashCount` segments
   * spread along from→to, each `dashFraction` of the spacing long. Pure number
   * writes into a preallocated buffer — zero allocations per frame.
   */
  private updateDashedPath(fromX: number, fromZ: number, toX: number, toZ: number): void {
    if (this.dashCount === 0) return;
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const length = Math.hypot(dx, dz);
    const step = length > 0 ? length / DASH_COUNT : 0;
    const dash = (DASH_SIZE * step) / (DASH_SIZE + GAP_SIZE);
    const ux = length > 0 ? dx / length : 0;
    const uz = length > 0 ? dz / length : 0;
    const buffer = this.dashPositions;
    for (let i = 0; i < this.dashCount; i++) {
      const start = step * i;
      const end = start + dash;
      const o = i * 6;
      buffer[o] = fromX + ux * start;
      buffer[o + 1] = MARKER_Y;
      buffer[o + 2] = fromZ + uz * start;
      buffer[o + 3] = fromX + ux * end;
      buffer[o + 4] = MARKER_Y;
      buffer[o + 5] = fromZ + uz * end;
    }
    this.pathLine.updateVerticesData(VertexBuffer.PositionKind, buffer, false, false);
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
