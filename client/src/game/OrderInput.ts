import { PointerEventTypes, type PointerInfo, type Scene, type Observer } from "@babylonjs/core";
import {
  createLogger,
  type ConfigService,
  type EntityId,
  type TuningConfig,
} from "@space-arena/shared";
import type { GameSession } from "./GameSession.js";

const log = createLogger("OrderInput");

interface ShipMeta {
  entityId: EntityId;
  kind: "ship";
  team: number;
}

function isShipMeta(m: unknown): m is ShipMeta {
  return typeof m === "object" && m !== null && (m as { kind?: string }).kind === "ship";
}

/**
 * Pointer state machine (§2.2) translating one-finger / mouse input into sim
 * orders. Camera orbit stays on the right button / second pointer (owned by
 * TacticalCamera), so single-pointer input is 100% gameplay.
 *
 * Tap disambiguation:
 *  - A gesture is a *tap* only if it started with exactly one pointer, never
 *    became multi-touch (pinch/orbit), and moved < `tapSlopPx` before release.
 *  - Single tap on the ground plane → move {boost:false}, sent IMMEDIATELY so
 *    single-tap response is never delayed waiting on a possible second tap.
 *  - Double tap (second tap within `doubleTapWindowMs` and `tapSlopPx` of the
 *    first) → the same target is RE-SENT as move {boost:true}. The first tap's
 *    move already started the ship; the double-tap just upgrades it to boost.
 *  - Tap on a (non-player) ship view → target order.
 *  - Mouse parity falls out for free: pointer events cover click / double-click.
 */
export class OrderInput {
  private readonly observer: Observer<PointerInfo> | null;

  private readonly doubleTapWindowMs: number;
  private readonly tapSlopPx: number;

  // Active pointer tracking (multi-touch detection).
  private readonly activePointers = new Set<number>();
  private maxPointers = 0;
  private enabled = true;

  // Primary-pointer down state.
  private downId: number | null = null;
  private downX = 0;
  private downY = 0;

  // Double-tap bookkeeping.
  private lastTapMs = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly session: GameSession,
  ) {
    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.doubleTapWindowMs = tuning?.doubleTapWindowMs ?? 250;
    this.tapSlopPx = tuning?.tapSlopPx ?? 12;

    this.observer = scene.onPointerObservable.add((pi) => this.onPointer(pi));
  }

  /**
   * Enable/disable gameplay tap orders. The dev editor turns these off while it
   * is open so clicking in its 3D stage never issues a move/target order to the
   * (hidden) live match.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.activePointers.clear();
      this.maxPointers = 0;
      this.downId = null;
    }
  }

  private onPointer(pi: PointerInfo): void {
    if (!this.enabled) return;
    const ev = pi.event as PointerEvent;
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      this.activePointers.add(ev.pointerId);
      this.maxPointers = Math.max(this.maxPointers, this.activePointers.size);
      if (this.activePointers.size === 1) {
        this.downId = ev.pointerId;
        this.downX = ev.clientX;
        this.downY = ev.clientY;
      }
    } else if (pi.type === PointerEventTypes.POINTERUP) {
      const wasPrimary = ev.pointerId === this.downId;
      const singlePointerGesture = this.maxPointers === 1;
      const movedPx = Math.hypot(ev.clientX - this.downX, ev.clientY - this.downY);
      this.activePointers.delete(ev.pointerId);

      if (wasPrimary && singlePointerGesture && movedPx <= this.tapSlopPx) {
        this.handleTap(ev.clientX, ev.clientY);
      }
      if (this.activePointers.size === 0) {
        this.maxPointers = 0;
        this.downId = null;
      }
    }
  }

  private handleTap(clientX: number, clientY: number): void {
    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => {
      return mesh.name === "groundPlane" || isShipMeta(mesh.metadata);
    });
    if (!pick || !pick.hit || !pick.pickedMesh) return;

    const meta = pick.pickedMesh.metadata;
    if (isShipMeta(meta)) {
      if (meta.entityId !== this.session.playerId) {
        this.session.order({ kind: "target", targetId: meta.entityId });
        log.debug(`target order → ${meta.entityId}`);
      }
      return;
    }

    // Ground plane → move order.
    const point = pick.pickedPoint;
    if (!point) return;
    const target = { x: point.x, z: point.z };

    const now = performance.now();
    const withinWindow = now - this.lastTapMs <= this.doubleTapWindowMs;
    const withinSlop = Math.hypot(clientX - this.lastTapX, clientY - this.lastTapY) <= this.tapSlopPx;
    const isDoubleTap = withinWindow && withinSlop;

    // Send immediately either way; double-tap re-sends the same target with boost.
    this.session.order({ kind: "move", target, boost: isDoubleTap });
    log.debug(`move order → (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) boost=${isDoubleTap}`);

    this.lastTapMs = now;
    this.lastTapX = clientX;
    this.lastTapY = clientY;
  }

  dispose(): void {
    if (this.observer) this.scene.onPointerObservable.remove(this.observer);
  }
}
