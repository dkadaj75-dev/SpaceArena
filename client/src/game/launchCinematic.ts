import { facingVec, type ShipSnapshot } from "@space-arena/shared";
import { HANGAR_LAUNCH_SOUNDS } from "../audio/soundIds.js";
import type { TacticalCamera } from "./TacticalCamera.js";

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The hangar launch establishing shot — the camera half of the spawn sequence
 * the sim runs in `ArenaSimulation.tickLaunchSequences`.
 *
 * While the sim owns the ship (`ShipSnapshot.launchLocked`) the pursuit rig has
 * nothing to do: the pilot has no control, and a camera glued behind a hull that
 * is bolted to a pad is a still frame of a wall. This replaces it with a fixed
 * shot in the rear corner of the bay, up near the roof, looking down over the
 * ship and out through the opening it is about to leave through — so the player
 * watches the launch instead of sitting through it. Control returning is the
 * cut back.
 *
 * The bay is a SMALL room: the eye ends up ~5.5 from the ship with the mouth 14
 * further on, so the shot needs a genuinely wide lens to hold both. That is
 * `TacticalCamera`'s cinematic FOV, and it is why the pursuit FOV cannot be
 * reused here.
 *
 * ## Deriving the pose
 *
 * Everything is expressed in the SPAWN PAD's frame, captured on the first frame
 * of the sequence (the ship is on its pad then, by construction — the sim pins
 * it there). Sim conventions apply (`chaseCamera.ts`): the pad heading's forward
 * is `F = (cos h, 0, sin h)`, and the bay opening is along `+F`, so the shot
 * only needs `F`, the world up `Y`, and their cross product
 * `R = Y × F = (sin h, 0, −cos h)`:
 *
 *   eye    = pad − F·back + R·side + Y·up      (rear corner, near the roof)
 *   aim    = ship + F·lookAhead                (the ship, biased toward the mouth)
 *
 * The aim point tracks the ship's INTERPOLATED render position rather than the
 * pad, which is what makes the shot pan to follow the launch and then hold on
 * the opening once the ship is through it.
 */

/**
 * Shot geometry, in world units of the pad frame.
 *
 * These are MEASURED against `prop.ctf-hangar-bay`'s collision mesh, not read
 * off the model's bounding box — the box is much larger than the space a camera
 * can actually sit in, and trusting it is what once put this shot inside the
 * ceiling. Rays cast from a shipped pad give the real interior:
 *
 *   ceiling over the pad   4.07 above the ship (world y 12.07)
 *   deck                   2.75 below          (world y 5.25)
 *   side walls             8.1 either way
 *   rear wall              3.5 behind the pad
 *
 * The offsets below leave ≥1.7 of clearance on every axis at both ends of the
 * push-in, in both bay orientations, and the eye still has line of sight to the
 * ship AND straight out through the mouth. Headroom is the tight one: raising
 * `up` past ~2.5 starts catching roof fixtures, so it buys margin instead of
 * altitude and the downward angle comes from being close rather than high.
 *
 * One bay prop ships today, so these are constants. A second bay with a
 * different interior would have to author them per-arena rather than re-tune
 * these and break the first.
 */
export const LAUNCH_SHOT = {
  /** Toward the rear wall (3.5 away), behind the pad. */
  back: 1.5,
  /** Toward one side wall (8.1 away). Sign picks the corner. */
  side: 5,
  /** Above the ship (4.07 of headroom, and roof fixtures below that). */
  up: 2,
  /** How far past the ship the shot aims, so the opening shares the frame. */
  lookAhead: 3.5,
  /**
   * Fraction of the corner offset the slow push-in closes. Small: from 5.5 out,
   * a big dolly would swing the ship and the mouth apart faster than the frame
   * can hold both.
   */
  pushIn: 0.1,
  /** Seconds the push-in takes. Longer than any hold, so it never visibly lands. */
  pushInSec: 3.4,
} as const;

/** Mutable pose, reused frame to frame so the render loop stays allocation-free. */
export interface LaunchShotPose {
  eye: Vec3;
  target: Vec3;
}

export function newLaunchShotPose(): LaunchShotPose {
  return { eye: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } };
}

/** Scratch for the pad's forward axis; `launchShotPose` is the only caller. */
const forward = { x: 1, y: 0, z: 0 };

/**
 * Write the shot for a sequence `sec` seconds old into `out`.
 *
 * The push-in scales all three corner offsets together, so it is a straight
 * dolly toward the pad rather than a crane that would swing the horizon. Eased
 * on both ends: a linear creep reads as a camera being dragged.
 */
export function launchShotPose(
  pad: Vec3,
  heading: number,
  ship: Vec3,
  sec: number,
  out: LaunchShotPose,
): LaunchShotPose {
  // Level forward: the bay is a horizontal tube, so a pad authored with pitch
  // must not tilt the shot with it.
  facingVec(heading, 0, forward);
  const rightX = forward.z;
  const rightZ = -forward.x;

  const t = sec <= 0 ? 0 : sec >= LAUNCH_SHOT.pushInSec ? 1 : sec / LAUNCH_SHOT.pushInSec;
  const eased = t * t * (3 - 2 * t);
  const dolly = 1 - LAUNCH_SHOT.pushIn * eased;

  out.eye.x = pad.x - forward.x * LAUNCH_SHOT.back * dolly + rightX * LAUNCH_SHOT.side * dolly;
  out.eye.y = pad.y + LAUNCH_SHOT.up * dolly;
  out.eye.z = pad.z - forward.z * LAUNCH_SHOT.back * dolly + rightZ * LAUNCH_SHOT.side * dolly;

  out.target.x = ship.x + forward.x * LAUNCH_SHOT.lookAhead;
  out.target.y = ship.y;
  out.target.z = ship.z + forward.z * LAUNCH_SHOT.lookAhead;
  return out;
}

/**
 * Drives {@link launchShotPose} into a {@link TacticalCamera} for as long as the
 * local ship is under sim control, and fires the launch cue when the run starts.
 *
 * Snapshot-driven throughout, which is what makes it work identically offline
 * and online and for both the opening wave and every respawn: `launchLocked`
 * says the sim owns the hull, and `throttle` leaving zero says the pinned half
 * of the hold is over and the ship is being flown out. The only local clock is
 * the push-in's, which is decoration.
 */
export class LaunchCinematic {
  /** Captured pad position; null when no sequence is running. */
  private pad: Vec3 | null = null;
  private heading = 0;
  private sec = 0;
  private thrustCued = false;
  private readonly pose = newLaunchShotPose();

  constructor(
    private readonly camera: TacticalCamera,
    private readonly playSound: ((id: string) => void) | null = null,
  ) {}

  /**
   * `ship` is the local pilot's entry in the current snapshot (absent while
   * dead), `shipPos` its interpolated render position, which is what the shot
   * aims at so the pan is as smooth as the hull the player is watching.
   */
  update(ship: ShipSnapshot | null | undefined, shipPos: Vec3, dtMs: number): void {
    if (!ship?.launchLocked) {
      this.stop();
      return;
    }
    if (!this.pad) {
      // Rising edge. The sim has the ship pinned to its pad right now, so this
      // pose IS the pad pose — no separate spawn-point lookup, and it works the
      // same for a client that only ever sees replicated state.
      this.pad = { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z };
      this.heading = ship.heading;
      this.sec = 0;
      this.thrustCued = false;
    }
    this.sec += dtMs / 1000;
    // Throttle is zero for the whole pinned half and full for the run, so its
    // first non-zero frame is exactly the ignition beat.
    if (!this.thrustCued && ship.throttle > 0) {
      this.thrustCued = true;
      this.playSound?.(HANGAR_LAUNCH_SOUNDS.thrust);
    }
    launchShotPose(this.pad, this.heading, shipPos, this.sec, this.pose);
    this.camera.setCinematicShot(this.pose.eye, this.pose.target);
  }

  /** Cut back to the pursuit rig. Idempotent; safe to call on teardown. */
  stop(): void {
    if (!this.pad) return;
    this.pad = null;
    this.camera.setCinematicShot(null);
  }

  /** True while the establishing shot is running (test/debug hook). */
  get active(): boolean {
    return this.pad !== null;
  }
}
