import {
  ArcRotateCamera,
  Matrix,
  PointerEventTypes,
  Vector3,
  Viewport,
  type Observer,
  type PointerInfo,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import {
  createLogger,
  facingVec,
  type CameraConfig,
  type ConfigService,
  type EventBus,
  type ConfigEvents,
  type ArenaBounds,
  type StaticWorld,
} from "@space-arena/shared";
import {
  approachDirection,
  chaseOffsetForFrame,
  chaseSettingsOf,
  DEFAULT_CHASE_SETTINGS,
  type ChaseSettings,
} from "./chaseCamera.js";

const log = createLogger("TacticalCamera");

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

const CAMERA_CONFIG_ID = "camera.default";

const RIGHT_AXIS = new Vector3(1, 0, 0);
const FORWARD_AXIS = new Vector3(0, 0, 1);

/** Radians of orbit per pixel dragged in editor mode. */
const EDITOR_ORBIT_SPEED = 0.008;
/**
 * Pixels a pointer must travel before an editor drag counts as an orbit/pan.
 * Below this a press-release stays a clean tap, so `POINTERPICK` consumers
 * (the Ship Manager's socket markers, the Map editor's asteroids) still work.
 */
const EDITOR_DRAG_SLOP_PX = 4;
/** Sanity bound on how far the editor camera target can be panned (world units). */
const EDITOR_TARGET_LIMIT = 300;
/** Chase collision shell, in world units. */
const CHASE_COLLISION_MARGIN = 0.6;
const CHASE_COLLISION_RADIUS = 0.5;
/** How quickly an unobstructed chase camera regains its authored distance. */
const CHASE_COLLISION_RECOVER_PER_SEC = 6;

/**
 * Establishing-shot FOV, as a multiple of the pursuit rig's. Wide on purpose,
 * and by more than it looks like it needs: a hangar shot sits ~5 units from the
 * ship inside a room ~8 across, and the subject and the bay opening it is
 * leaving through are ~55° apart from there. The combat FOV frames neither.
 *
 * Babylon's default `FOVMODE_VERTICAL_FIXED` makes this the VERTICAL angle, so
 * it is the binding one in portrait — which is the aspect the framing was
 * checked against.
 */
const CINEMATIC_FOV_SCALE = 1.5;
/** Ceiling on that widening — past this the hull skews at the frame edge. */
const CINEMATIC_FOV_MAX = 1.25;
/** Orbit radius band opened up while a fixed shot drives the rig. */
const CINEMATIC_RADIUS_LIMIT = 400;

/**
 * The CANONICAL hangar framing — the orbit a fresh Hangar boot uses, and the
 * one {@link TacticalCamera.resetStageOrbit} snaps back to on every entry.
 * Exported so the Hangar (and its tests) name the same three numbers this rig
 * does rather than repeating literals on both sides.
 */
export const HANGAR_STAGE_ALPHA = -Math.PI / 2;
export const HANGAR_STAGE_BETA = 1.15;
export const HANGAR_STAGE_RADIUS = 9;

/**
 * `ArcRotateCamera` rig with three modes, all fed by `camera.json` and
 * re-applied live on hot-reload:
 *
 *  - **chase** — the in-match view (FLIGHT.md §3): yaw driven by the ship's
 *    heading, beta/radius pinned to the `chase` block, no player look-around.
 *  - **editor** — the dev stage's free orbit/pan (F10).
 *  - **hangar** — a tight free orbit around a staged ship.
 *
 * Outside those it is a plain smoothed follow rig on a target `TransformNode`,
 * which is all the menu/lobby backdrop needs. The in-match free orbit + pan it
 * used to offer retired with move orders (FLIGHT.md §7): the ship owns the view
 * now, so there is no pan offset, no arena-bounds pan clamp and no look-ahead
 * bias left to maintain. `pan.sensitivity` survives because the EDITOR pans.
 */
export class TacticalCamera {
  readonly camera: ArcRotateCamera;
  private followTarget: TransformNode | null = null;
  private followLag = 0.15;
  private unsubscribe: (() => void) | null = null;

  // Scratch vectors reused every update() call — no per-frame allocations.
  private readonly scratchTargetPos = new Vector3();
  /** False until the first update() seeds the smoothed follow point. */
  private seeded = false;
  private editorMode = false;
  private hangarMode = false;
  /** Automatic match-end beauty-shot drift, radians/sec; zero outside MVP. */
  private mvpOrbitRadPerSec = 0;
  /**
   * Chase mode (FLIGHT.md §3) — the in-match rig for the flight model. Its yaw
   * is driven by the ship instead of the player, so every look-around gesture is
   * gated off while it is active (see {@link onPointer}).
   */
  private chaseMode = false;
  /**
   * Fixed establishing shot (hangar launch). Outranks every other mode while
   * set: its whole job is to take the camera off the ship for a few seconds.
   */
  private cinematicActive = false;
  private readonly cinematicEye = new Vector3();
  private readonly cinematicTarget = new Vector3();
  /** A cinematic is level in WORLD space — it is not riding the ship's roll. */
  private readonly cinematicUp = new Vector3(0, 1, 0);
  private chase: ChaseSettings = DEFAULT_CHASE_SETTINGS;
  /** Player-local multiplier over the content-authored chase radius. */
  private chaseDistanceScale = 1;
  /** True while the viewport is landscape — applies `chase.landscapeRadiusScale`. */
  private landscapeOrientation = false;
  /**
   * Latest ship orientation FRAME pushed in by the render loop — the
   * authoritative nose + replicated up, never reconstructed from heading/pitch
   * (flight-frame handoff). Smoothed as directions, not as Euler coordinates.
   */
  private readonly chaseNoseTarget = new Vector3(1, 0, 0);
  private readonly chaseUpTarget = new Vector3(0, 1, 0);
  /** Smoothed frame the rig is posed from; seeded from the targets on the first frame. */
  private readonly chaseSmoothNose = new Vector3(1, 0, 0);
  private readonly chaseSmoothUp = new Vector3(0, 1, 0);
  private chaseSeeded = false;
  /** Scratch rig state — update() stays allocation-free (see {@link applyChasePose}). */
  private readonly chaseUp = new Vector3(0, 1, 0);
  private readonly chaseOffset = new Vector3();
  private readonly chaseLocalOffset = new Vector3();
  private readonly chaseAnchor = new Vector3();
  private readonly chaseDesiredPosition = new Vector3();
  private readonly chaseFinalPosition = new Vector3();
  /** The collision-limited distance; null until the first obstructed pose. */
  private chaseCollisionRadius: number | null = null;
  private staticWorld: StaticWorld | null = null;
  private arenaBounds: ArenaBounds | null = null;
  private readonly yToUp = new Matrix();
  private readonly upToY = new Matrix();
  /** Engine default FOV, captured at construction so leaving chase mode restores it. */
  private readonly defaultFov: number;
  private pointersInput: { buttons: number[] } | undefined;

  private readonly followPoint = new Vector3();
  /** Editor pan speed (`camera.pan.sensitivity`); the in-match pan is retired. */
  private panSensitivity = 1;
  /**
   * Player-level multiplier on the configured pan sensitivity (5.8 settings,
   * `sa.camera.panSens`). The config value stays the baseline — this is a
   * per-player feel adjustment layered on top of it, never a write to content.
   */
  private panSensitivityScale = 1;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  // Editor-mode drag state: `ox/oy` is the press origin (for the tap slop test),
  // `x/y` the last processed position.
  private editorDrag: { id: number; ox: number; oy: number; x: number; y: number; button: number; moved: boolean } | null = null;
  /**
   * Camera micro-shake offset (§10 5.7), written by
   * {@link import("./juice/ScreenShake.js").ScreenShake}. Purely ADDITIVE: it is
   * applied as the last step of {@link update} and never feeds back into the
   * follow point, so a shake can't permanently displace the view.
   */
  private readonly shakeOffset = new Vector3();
  private gesturesSuspended = false;
  private pointerObserver: Observer<PointerInfo> | null = null;
  private readonly onContextMenu = (e: Event): void => e.preventDefault();
  private readonly scratchRight = new Vector3();
  private readonly scratchGroundFwd = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly configService: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
  ) {
    const config = configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID);
    if (!config) {
      log.error(`camera config not found: ${CAMERA_CONFIG_ID}, using hardcoded fallback limits`);
    }

    this.camera = new ArcRotateCamera(
      "tacticalCamera",
      config?.alpha.default ?? -Math.PI / 2,
      config?.beta.default ?? 0.9,
      config?.radius.default ?? 55,
      Vector3.Zero(),
      scene,
    );

    this.defaultFov = this.camera.fov;
    this.chase = chaseSettingsOf(config);
    this.applyLimits(config);

    // Attach control for wheel zoom. The built-in pointers input only serves
    // the editor/hangar orbit modes (buttons set there); the editor's own
    // orbit/pan gestures are handled by this class.
    this.camera.attachControl(canvas, true);
    this.pointersInput = this.camera.inputs.attached.pointers as unknown as
      | { buttons: number[] }
      | undefined;
    if (this.pointersInput) this.pointersInput.buttons = [];

    canvas.style.touchAction = "none";
    canvas.addEventListener("contextmenu", this.onContextMenu);
    this.pointerObserver = scene.onPointerObservable.add((pi) => this.onPointer(pi));

    this.camera.wheelDeltaPercentage = 0.01;
    this.camera.pinchDeltaPercentage = 0.01;
    this.camera.inertia = 0.85;
    this.camera.panningInertia = 0.85;
    this.camera.angularSensibilityX = 800;
    this.camera.angularSensibilityY = 800;

    this.unsubscribe = this.bus.on("config:changed", (evt) => {
      if (evt.id === CAMERA_CONFIG_ID) {
        log.info("camera config hot-reloaded, re-applying limits");
        const fresh = this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID);
        this.chase = chaseSettingsOf(fresh);
        this.applyLimits(fresh);
      }
    });
  }

  private applyLimits(config: CameraConfig | undefined): void {
    // Mode-independent feel knobs land in every mode; the orbit clamps below are
    // the tactical rig's, and the editor/hangar/chase modes each own their own.
    this.followLag = config?.followLag ?? this.followLag;
    this.panSensitivity = config?.pan?.sensitivity ?? this.panSensitivity;
    if (this.editorMode || this.hangarMode) return;
    // Chase mode owns beta/radius outright (they come from the `chase` block),
    // so the orbit limits must not be re-widened underneath it — including on
    // the way out of a mode that widened them (editor) or on hot-reload.
    if (this.chaseMode) {
      this.applyChaseLimits();
      return;
    }
    this.camera.fov = this.defaultFov;
    this.camera.lowerBetaLimit = config?.beta.min ?? 0.6;
    this.camera.upperBetaLimit = config?.beta.max ?? 1.15;
    this.camera.lowerRadiusLimit = config?.radius.min ?? 25;
    this.camera.upperRadiusLimit = config?.radius.max ?? 100;
  }

  /** Player pan-sensitivity multiplier (5.8 settings), used by the editor pan. Clamped to a sane band. */
  setPanSensitivityScale(scale: number): void {
    this.panSensitivityScale = Number.isFinite(scale) ? clamp(scale, 0.1, 5) : 1;
  }

  /** Player-local chase distance multiplier; content remains the baseline. */
  setChaseDistanceScale(scale: number): void {
    this.chaseDistanceScale = Number.isFinite(scale) ? clamp(scale, 0.1, 5) : 1;
    if (this.chaseMode) this.applyChaseLimits();
  }

  /**
   * Viewport orientation, pushed by the render shell on resize/rotate. In
   * landscape the authored `chase.landscapeRadiusScale` scales the DEFAULT
   * chase distance (the shipped pack pulls it in to 70%); the player's local
   * distance setting still multiplies on top of that baseline.
   */
  setLandscapeOrientation(landscape: boolean): void {
    if (this.landscapeOrientation === landscape) return;
    this.landscapeOrientation = landscape;
    if (this.chaseMode) this.applyChaseLimits();
  }

  /**
   * Attach the immutable match collision world. Supplying null returns the rig
   * to its menu/editor behaviour; an empty world is deliberately a no-op.
   */
  setStaticWorld(world: StaticWorld | null, bounds: ArenaBounds | null = null): void {
    this.staticWorld = world;
    this.arenaBounds = bounds;
    this.chaseCollisionRadius = null;
    if (this.chaseMode) this.applyChaseLimits();
  }

  private get effectiveChaseRadius(): number {
    const orientationScale = this.landscapeOrientation ? this.chase.landscapeRadiusScale : 1;
    return this.chase.radius * orientationScale * this.chaseDistanceScale;
  }

  /** Config sensitivity × the player's local multiplier. */
  private get effectivePanSensitivity(): number {
    return this.panSensitivity * this.panSensitivityScale;
  }

  /** Follow a transform node (the player ship) with smoothed lag. */
  follow(target: TransformNode): void {
    this.followTarget = target;
    this.seeded = false;
  }

  /**
   * Set this frame's additive shake offset (world units on the arena plane).
   * Called by the shake consumer each frame; (0, 0) means "no shake".
   */
  setShakeOffset(x: number, z: number): void {
    this.shakeOffset.x = x;
    this.shakeOffset.z = z;
  }

  /** Temporarily turn the tactical rig into an unrestricted editor orbit camera. */
  setEditorMode(enabled: boolean): void {
    this.editorMode = enabled;
    this.editorDrag = null;
    this.activeTouches.clear();
    if (enabled) {
      this.followTarget = null;
      // The editor stage is not a cockpit: drop the chase block's FOV so what a
      // dev frames there matches the tactical rig. Leaving editor mode re-runs
      // applyLimits, which hands the chase FOV back if the match is still live.
      this.camera.fov = this.defaultFov;
      // Editor gestures are fully custom (see onEditorPointer): left-drag
      // orbits, right-drag pans, one finger orbits, two fingers pan + pinch.
      // The built-in pointers input stays off so it can't double-apply them;
      // only its wheel sibling (zoom) remains live.
      if (this.pointersInput) this.pointersInput.buttons = [];
      this.camera.lowerBetaLimit = 0.05;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.02;
      this.camera.lowerRadiusLimit = 5;
      this.camera.upperRadiusLimit = 700;
      return;
    }
    if (this.pointersInput) this.pointersInput.buttons = [];
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /**
   * Hangar preview mode (ROADMAP §9 4.5): a tight free-orbit around a staged
   * ship at the origin, reusing this rig instead of a second scene/camera.
   * Enabling drops any follow target and widens orbit control to left-drag
   * (no tap-to-move to conflict with in the Hangar); disabling restores the
   * normal tactical limits and right-drag-only orbit. Does not itself re-attach
   * a follow target — callers call {@link follow} again when returning to a match.
   */
  setHangarMode(enabled: boolean): void {
    this.hangarMode = enabled;
    if (!enabled) this.mvpOrbitRadPerSec = 0;
    if (enabled) {
      this.followTarget = null;
      // The staged hull is framed with `framingRadius(..., camera.fov, ...)`, so
      // a chase FOV left behind by a match would mis-frame it. Restored here
      // rather than relying on the match teardown having run first.
      this.camera.fov = this.defaultFov;
      this.camera.lowerBetaLimit = 0.25;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.05;
      this.camera.lowerRadiusLimit = 4;
      this.camera.upperRadiusLimit = 24;
      if (this.pointersInput) this.pointersInput.buttons = [0, 2];
      return;
    }
    if (this.pointersInput) this.pointersInput.buttons = [];
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /** Begin a subtle allocation-free orbit around the staged MVP hull. */
  beginMvpOrbit(degreesPerSecond: number): void {
    this.mvpOrbitRadPerSec = Number.isFinite(degreesPerSecond)
      ? degreesPerSecond * Math.PI / 180
      : 0;
  }

  /**
   * Slide the staged subject across the FRAME, in fractions of the viewport
   * (+x right, +y up), so the MVP hull can clear the results panel: it sits at
   * the bottom in portrait and on the right in landscape.
   *
   * `targetScreenOffset` is world units in view space, so the fractions are
   * converted through the visible extent at the orbit radius — that keeps the
   * shift a constant share of the screen at any radius, FOV or aspect. Both
   * axes ride the view matrix, so the orbit does not smear them.
   */
  setStageScreenOffset(fractionX: number, fractionY: number): void {
    const engine = this.camera.getScene().getEngine();
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    // FOVMODE_VERTICAL_FIXED (Babylon's default): fov is the vertical angle.
    const visibleHeight = 2 * this.camera.radius * Math.tan(this.camera.fov / 2);
    this.camera.targetScreenOffset.set(
      fractionX * visibleHeight * aspect,
      fractionY * visibleHeight,
    );
  }

  /** Drop any staged frame offset — matches always frame on the ship itself. */
  clearStageScreenOffset(): void {
    this.camera.targetScreenOffset.set(0, 0);
  }

  /**
   * Chase mode (FLIGHT.md §3) — the in-match rig for the continuous-flight
   * model. It replaces the player's orbit control rather than extending it:
   *
   *  - the whole rig FRAME is derived every frame from the ship's smoothed
   *    heading and pitch — it rolls with the ship so it can follow a loop
   *    (BUBBLE.md §A, {@link applyChasePose}), which is what keeps the horizon
   *    rotating instead of flipping at the pole. `chase.yawLag`/`chase.pitchLag`
   *    smooth the two axes going in; `radius` is pinned to the `chase` block and
   *    the radius limits are collapsed onto it so wheel/pinch zoom cannot fight
   *    it;
   *  - the follow point is lifted by `chase.height` so the rig looks over the
   *    ship's shoulder instead of through it.
   *
   * Menu/editor/hangar modes are untouched.
   */
  setChaseMode(enabled: boolean): void {
    if (this.chaseMode === enabled) return;
    this.chaseMode = enabled;
    this.activeTouches.clear();
    this.chaseSeeded = false;
    this.chaseCollisionRadius = null;
    if (enabled) {
      this.applyChaseLimits();
      return;
    }
    this.camera.fov = this.defaultFov;
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /** True while the in-match chase rig is driving the camera. */
  get isChaseMode(): boolean {
    return this.chaseMode;
  }

  /**
   * Park the rig on a FIXED world-space shot — eye and aim point both supplied
   * per frame by whoever owns the sequence (the hangar launch establishing shot,
   * `LaunchCinematic`). Passing a null eye cuts back to whatever mode was
   * underneath, which in a match is the pursuit rig.
   *
   * The pose is applied verbatim: no follow smoothing, no terrain avoidance and
   * no shake. A shot placed inside a bay by construction has nothing to avoid,
   * and lag on a camera that is not tracking anything only reads as drift.
   *
   * Leaving re-seeds both smoothers so the return to pursuit is a CUT. Letting
   * them lerp would fly the camera across the hangar and out of the bay behind
   * the ship, arriving several seconds after the player got control.
   */
  setCinematicShot(eye: { x: number; y: number; z: number } | null, target?: { x: number; y: number; z: number }): void {
    if (!eye) {
      if (!this.cinematicActive) return;
      this.cinematicActive = false;
      this.seeded = false;
      this.chaseSeeded = false;
      this.chaseCollisionRadius = null;
      if (this.chaseMode) {
        this.applyChaseLimits();
        return;
      }
      this.camera.fov = this.defaultFov;
      this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
      return;
    }
    this.cinematicEye.set(eye.x, eye.y, eye.z);
    if (target) this.cinematicTarget.set(target.x, target.y, target.z);
    if (this.cinematicActive) return;
    this.cinematicActive = true;
    this.activeTouches.clear();
    // Chase mode pins the orbit radius and rolls `upVector` with the ship; a
    // fixed shot needs both undone, because `rebuildAnglesAndRadius` solves for
    // alpha/beta/radius against exactly those and Babylon re-clamps every frame.
    this.camera.upVector = this.cinematicUp;
    this.camera.lowerBetaLimit = 0;
    this.camera.upperBetaLimit = Math.PI;
    this.camera.lowerRadiusLimit = 0.1;
    this.camera.upperRadiusLimit = CINEMATIC_RADIUS_LIMIT;
    this.camera.fov = Math.min(CINEMATIC_FOV_MAX, (this.chase.fov ?? this.defaultFov) * CINEMATIC_FOV_SCALE);
  }

  /** True while a fixed establishing shot is driving the camera. */
  get isCinematic(): boolean {
    return this.cinematicActive;
  }

  /**
   * Push this frame's ship orientation FRAME (sim conventions: heading 0 = +X
   * growing counter-clockwise, pitch positive climbing, `up` the ship's
   * replicated authoritative up axis). Called once per render frame from the
   * interpolated snapshot; the `yawLag`/`pitchLag` smoothing in {@link update}
   * turns it into the rig pose. The raw per-frame values are fine here.
   *
   * The up must be the PERSISTED frame axis — deriving one from heading/pitch
   * is the lossy reconstruction that made the camera barrel-roll at steep
   * pitch (flight-frame handoff).
   */
  setChaseFrame(heading: number, pitch: number, up: { x: number; y: number; z: number }): void {
    facingVec(heading, pitch, this.chaseNoseTarget);
    this.chaseUpTarget.set(up.x, up.y, up.z);
  }

  /**
   * Collapse the orbit clamps for chase mode. Babylon clamps `radius`/`beta`
   * inside its own per-frame `_checkLimits()`, so equal lower/upper limits is
   * what makes wheel zoom and pinch inert without detaching the inputs (the
   * wheel input is shared with the editor/hangar modes).
   *
   * Radius is pinned outright. Beta is NOT: {@link applyChasePose} solves for it
   * against Babylon's own up-vector alignment, so it must be free to take any
   * value that solve produces. The limits therefore open onto the full legal band.
   * Nothing is given back to the player by widening it — chase mode has no beta
   * input at all (`onPointer` returns early, and the wheel only zooms).
   *
   * `chase.fov` is optional and an ABSENT value means "keep the engine default",
   * so a null restores the captured `defaultFov` instead of leaving whatever a
   * previous config set — that is what makes deleting the key on a hot-reload
   * actually take effect.
   */
  private applyChaseLimits(): void {
    // The rolled rig (BUBBLE.md §A) parks the ORBIT tilt at the authored base and
    // rotates the whole frame instead, so beta no longer sweeps with the ship's
    // pitch and needs no pole margin — but Babylon still clamps whatever we set,
    // so the limits are opened to the full legal band rather than a narrow one.
    this.camera.lowerBetaLimit = 0;
    this.camera.upperBetaLimit = Math.PI;
    const radius = this.effectiveChaseRadius;
    // Collision may pull the actual orbit radius inward. Input still cannot
    // win: applyChasePose/avoidance resets it every render frame.
    this.camera.lowerRadiusLimit = this.hasChaseCollision ? 0.1 : radius;
    this.camera.upperRadiusLimit = radius;
    this.camera.radius = radius;
    this.camera.fov = this.chase.fov ?? this.defaultFov;
    if (this.chaseSeeded) {
      this.applyChasePose(this.chaseSmoothNose, this.chaseSmoothUp);
    } else {
      this.applyChasePose(this.chaseNoseTarget, this.chaseUpTarget);
    }
  }

  /**
   * Point the rig at a ship FRAME — the whole of the loop-capable chase camera,
   * and the one place that has to reckon with how `ArcRotateCamera` treats a
   * non-Y `upVector`.
   *
   * The ship's replicated up and {@link chaseOffsetForFrame} give the pose we
   * want in world space. Babylon does not accept a pose: it derives its position
   * from `alpha`/`beta` and then rotates that by `RotationAlign(Y, upVector)`.
   * So we build the SAME alignment it will use, undo it on our desired offset,
   * and read the orbit angles back out of the result. In ordinary flight this
   * resolves to exactly `alpha = h + π`, `beta = chase.beta` — the rig really is
   * "level, in the ship's frame" — but doing it by inversion rather than by
   * assuming that keeps it correct in the one place the assumption fails:
   * Babylon falls back to a fixed alignment axis when the up vector is within
   * ~2.5° of −Y, which a looping ship passes through at the bottom of every
   * revolution.
   */
  private applyChasePose(nose: Vector3, up: Vector3): void {
    const radius = this.effectiveChaseRadius;
    this.chaseUp.copyFrom(up);
    chaseOffsetForFrame(nose, up, this.chase.beta, radius, this.chaseOffset);
    // Assigning normalizes in place and rebuilds Babylon's own alignment matrices.
    this.camera.upVector = this.chaseUp;
    Matrix.RotationAlignToRef(Vector3.UpReadOnly, this.camera.upVector, this.yToUp);
    this.yToUp.transposeToRef(this.upToY);
    Vector3.TransformCoordinatesToRef(this.chaseOffset, this.upToY, this.chaseLocalOffset);
    this.camera.radius = radius;
    this.camera.beta = Math.acos(clamp(this.chaseLocalOffset.y / radius, -1, 1));
    this.camera.alpha = Math.atan2(this.chaseLocalOffset.z, this.chaseLocalOffset.x);
  }

  private get hasChaseCollision(): boolean {
    return !!this.staticWorld && (!this.staticWorld.isEmpty || this.arenaBounds?.shape === "box");
  }

  /**
   * Keep the camera shell outside static terrain. The anchor is the actual
   * chase target (the smoothed ship position lifted by chase.height), so the
   * ray cannot be blocked by the player's own hull and exactly follows the
   * sight line the camera needs to preserve.
   */
  private avoidChaseTerrain(dt: number): void {
    if (!this.hasChaseCollision || !this.staticWorld) return;

    const radius = this.effectiveChaseRadius;
    this.chaseAnchor.copyFrom(this.camera.target);
    this.chaseDesiredPosition.copyFrom(this.chaseAnchor).addInPlace(this.chaseOffset);
    this.chaseFinalPosition.copyFrom(this.chaseDesiredPosition);

    const hit = this.staticWorld.raycast(this.chaseAnchor, this.chaseDesiredPosition);
    if (hit) {
      const allowed = Math.max(0.1, radius * hit.t - CHASE_COLLISION_MARGIN);
      // Entering terrain is immediate. Leaving it is deliberately not.
      this.chaseCollisionRadius = this.chaseCollisionRadius === null
        ? allowed
        : Math.min(this.chaseCollisionRadius, allowed);
    } else if (this.chaseCollisionRadius !== null) {
      this.chaseCollisionRadius += (radius - this.chaseCollisionRadius)
        * Math.min(1, Math.max(0, dt) * CHASE_COLLISION_RECOVER_PER_SEC);
      if (radius - this.chaseCollisionRadius < 1e-4) this.chaseCollisionRadius = null;
    }

    const finalRadius = this.chaseCollisionRadius === null ? radius : this.chaseCollisionRadius;
    this.chaseFinalPosition.copyFrom(this.chaseAnchor).addInPlaceFromFloats(
      this.chaseOffset.x * finalRadius / radius,
      this.chaseOffset.y * finalRadius / radius,
      this.chaseOffset.z * finalRadius / radius,
    );
    if (this.arenaBounds?.shape === "box") {
      this.chaseFinalPosition.y = Math.min(this.chaseFinalPosition.y, this.arenaBounds.ceilingY - 1);
    }

    const contact = this.staticWorld.sphereContact(this.chaseFinalPosition, CHASE_COLLISION_RADIUS);
    if (contact?.depth) {
      this.chaseFinalPosition.x += contact.normal.x * contact.depth;
      this.chaseFinalPosition.y += contact.normal.y * contact.depth;
      this.chaseFinalPosition.z += contact.normal.z * contact.depth;
      if (this.arenaBounds?.shape === "box") {
        this.chaseFinalPosition.y = Math.min(this.chaseFinalPosition.y, this.arenaBounds.ceilingY - 1);
      }
    }
    this.applyChasePosition(this.chaseAnchor, this.chaseFinalPosition);
  }

  /** Solve ArcRotate's aligned orbit parameters for a collision-adjusted pose. */
  private applyChasePosition(anchor: Vector3, position: Vector3): void {
    this.chaseLocalOffset.copyFrom(position).subtractInPlace(anchor);
    const radius = this.chaseLocalOffset.length();
    if (!(radius > 1e-8)) return;
    Vector3.TransformCoordinatesToRef(this.chaseLocalOffset, this.upToY, this.chaseLocalOffset);
    this.camera.radius = radius;
    this.camera.beta = Math.acos(clamp(this.chaseLocalOffset.y / radius, -1, 1));
    this.camera.alpha = Math.atan2(this.chaseLocalOffset.z, this.chaseLocalOffset.x);
  }

  /**
   * Confine rendering to a sub-rectangle of the canvas (normalised, bottom-left
   * origin), or restore the full canvas with `null`. The split Hangar uses this
   * to give the ship its own half of the screen: Babylon derives the projection
   * aspect from the camera's viewport, so the hull frames itself inside that
   * rectangle instead of behind the info panel.
   */
  setStageViewport(rect: { x: number; y: number; width: number; height: number } | null): void {
    const r = rect ?? { x: 0, y: 0, width: 1, height: 1 };
    this.camera.viewport = new Viewport(r.x, r.y, r.width, r.height);
  }

  /**
   * Zoom range for a staged preview, sized to whatever is on the stage. The
   * Hangar derives it from the hull's bounding radius so "fully zoomed out"
   * frames a heavy the same way it frames an interceptor.
   */
  setStageRadiusRange(min: number, max: number): void {
    this.camera.lowerRadiusLimit = Math.max(0.1, min);
    this.camera.upperRadiusLimit = Math.max(this.camera.lowerRadiusLimit + 0.1, max);
  }

  /** Snap the camera to look at `target` at the given radius/beta — used to stage the Hangar preview. */
  stageAt(target: Vector3, radius: number, alpha: number, beta: number): void {
    this.camera.target.copyFrom(target);
    this.camera.radius = radius;
    this.camera.alpha = alpha;
    this.camera.beta = beta;
  }

  /**
   * Put the staged orbit back to its CANONICAL framing — what the Hangar calls
   * on every entry, so returning from a match always opens on the same view of
   * the ship instead of on wherever the last thing to drive the rig left it.
   *
   * Resetting alpha/beta/radius alone is not enough. Chase mode poses the rig by
   * ROLLING it: {@link applyChasePose} writes the ship's own up axis into
   * `camera.upVector`, and Babylon then rotates the whole orbit by
   * `RotationAlign(Y, upVector)` — so the same alpha/beta describe a completely
   * different view until the up is levelled again (a match that ended mid-loop
   * is the extreme case, and the reported "odd angles" one). The inertial
   * offsets go too: a flick left over from the last visit's orbit drag would
   * otherwise keep decaying into the fresh framing.
   */
  resetStageOrbit(target: Vector3): void {
    this.camera.upVector = Vector3.Up();
    this.camera.inertialAlphaOffset = 0;
    this.camera.inertialBetaOffset = 0;
    this.camera.inertialRadiusOffset = 0;
    this.camera.inertialPanningX = 0;
    this.camera.inertialPanningY = 0;
    this.stageAt(target, HANGAR_STAGE_RADIUS, HANGAR_STAGE_ALPHA, HANGAR_STAGE_BETA);
  }

  /**
   * Suspend every custom camera gesture. The dev editor turns this on while a
   * transform gizmo is being dragged so the drag moves only the gizmo's mesh
   * and never the camera; any in-flight drag is dropped immediately.
   */
  setGesturesSuspended(suspended: boolean): void {
    this.gesturesSuspended = suspended;
    if (suspended) {
      this.editorDrag = null;
      this.activeTouches.clear();
    }
  }

  private onPointer(pi: PointerInfo): void {
    if (this.gesturesSuspended) return;
    // Hangar mode uses the built-in orbit input instead of these gestures.
    if (this.hangarMode) return;
    // Everything else: no look-around at all. In a match the ship owns the view
    // (chase mode, FLIGHT.md §3) and outside one there is nothing to look at, so
    // the dev editor is the only pointer-driven camera left.
    if (!this.editorMode) return;
    const ev = pi.event as PointerEvent;
    this.onEditorPointer(pi, ev, ev.pointerType === "touch");
  }

  /**
   * Editor-mode gestures. Unlike tactical mode there is no ship to follow, so
   * panning writes straight to `camera.target` rather than to an offset.
   *
   *  - mouse left-drag / one-finger drag → orbit
   *  - mouse right-drag / two-finger drag → pan (two fingers also pinch-zoom)
   *  - wheel zoom is handled by the built-in mouse-wheel input
   */
  private onEditorPointer(pi: PointerInfo, ev: PointerEvent, isTouch: boolean): void {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      if (isTouch) {
        this.activeTouches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        // A second finger turns the gesture into pan+pinch — drop the orbit.
        this.editorDrag =
          this.activeTouches.size === 1
            ? { id: ev.pointerId, ox: ev.clientX, oy: ev.clientY, x: ev.clientX, y: ev.clientY, button: 0, moved: false }
            : null;
        return;
      }
      this.editorDrag = { id: ev.pointerId, ox: ev.clientX, oy: ev.clientY, x: ev.clientX, y: ev.clientY, button: ev.button, moved: false };
      return;
    }

    if (pi.type === PointerEventTypes.POINTERUP) {
      this.activeTouches.delete(ev.pointerId);
      if (this.editorDrag?.id === ev.pointerId) this.editorDrag = null;
      return;
    }

    if (pi.type !== PointerEventTypes.POINTERMOVE) return;

    if (isTouch) {
      const touch = this.activeTouches.get(ev.pointerId);
      if (!touch) return;
      const [a, b] = [...this.activeTouches.values()];
      if (this.activeTouches.size === 2 && a && b) {
        // Two-finger gesture: centroid delta pans, distance ratio pinch-zooms.
        const prevCx = (a.x + b.x) / 2;
        const prevCy = (a.y + b.y) / 2;
        const prevDist = Math.hypot(a.x - b.x, a.y - b.y);
        touch.x = ev.clientX;
        touch.y = ev.clientY;
        this.panTarget((a.x + b.x) / 2 - prevCx, (a.y + b.y) / 2 - prevCy);
        const curDist = Math.hypot(a.x - b.x, a.y - b.y);
        if (prevDist > 1 && curDist > 1) this.zoomBy(prevDist / curDist);
        return;
      }
      touch.x = ev.clientX;
      touch.y = ev.clientY;
    }

    const drag = this.editorDrag;
    if (!drag || drag.id !== ev.pointerId) return;
    if (!drag.moved) {
      // Stay a tap until the pointer has clearly moved, so picking still works.
      if (Math.hypot(ev.clientX - drag.ox, ev.clientY - drag.oy) < EDITOR_DRAG_SLOP_PX) return;
      drag.moved = true;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      return;
    }
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    if (drag.button === 2) this.panTarget(dx, dy);
    else this.orbitBy(dx, dy);
  }

  /** Screen-pixel drag → orbit angles, clamped to the active beta limits. */
  private orbitBy(dx: number, dy: number): void {
    this.camera.alpha -= dx * EDITOR_ORBIT_SPEED;
    this.camera.beta -= dy * EDITOR_ORBIT_SPEED;
    const lo = this.camera.lowerBetaLimit;
    const hi = this.camera.upperBetaLimit;
    if (lo !== null && this.camera.beta < lo) this.camera.beta = lo;
    if (hi !== null && this.camera.beta > hi) this.camera.beta = hi;
  }

  /**
   * Editor pan: the same screen→world mapping as {@link pan}, but applied
   * directly to the orbit target (there is no follow point to offset from) and
   * clamped to a plain sanity box instead of the arena bounds.
   */
  private panTarget(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const viewportH = this.canvas.clientHeight || 1;
    const worldPerPx =
      ((2 * this.camera.radius * Math.tan(this.camera.fov / 2)) / viewportH) * this.effectivePanSensitivity;

    this.camera.getDirectionToRef(RIGHT_AXIS, this.scratchRight);
    this.scratchRight.y = 0;
    this.scratchRight.normalize();
    this.camera.getDirectionToRef(FORWARD_AXIS, this.scratchGroundFwd);
    this.scratchGroundFwd.y = 0;
    this.scratchGroundFwd.normalize();

    // Mutated in place: `setTarget()` would recompute alpha/beta/radius and
    // fight the orbit angles we just set.
    const target = this.camera.target;
    target.x = clamp(target.x + (-this.scratchRight.x * dx + this.scratchGroundFwd.x * dy) * worldPerPx, -EDITOR_TARGET_LIMIT, EDITOR_TARGET_LIMIT);
    target.z = clamp(target.z + (-this.scratchRight.z * dx + this.scratchGroundFwd.z * dy) * worldPerPx, -EDITOR_TARGET_LIMIT, EDITOR_TARGET_LIMIT);
  }

  /** Multiply the orbit radius (pinch), clamped to the configured zoom limits. */
  private zoomBy(factor: number): void {
    const r = this.camera.radius * factor;
    const lo = this.camera.lowerRadiusLimit ?? r;
    const hi = this.camera.upperRadiusLimit ?? r;
    this.camera.radius = Math.min(hi, Math.max(lo, r));
  }

  /** Call once per render frame. `dt` in seconds. No allocations. */
  update(dt: number): void {
    if (this.cinematicActive) {
      // Both halves are re-solved every frame, and BOTH are needed: Babylon
      // rebuilds its position from alpha/beta/radius + target on each view
      // matrix, so writing the target alone would drag the "fixed" eye along
      // with the ship it is watching leave.
      this.camera.target.copyFrom(this.cinematicTarget);
      this.camera.position.copyFrom(this.cinematicEye);
      // Safety net, NOT framing. The shot's offsets are sized to one bay's
      // measured interior; a bay tighter than that would seat the eye inside a
      // wall and render the back of the geometry, which is unrecoverable on the
      // player's side. Push-out only — the chase rig's pull-toward-subject would
      // re-compose a shot whose whole value is that it was composed.
      const contact = this.staticWorld?.sphereContact(this.camera.position, CHASE_COLLISION_RADIUS);
      if (contact?.depth) {
        this.camera.position.x += contact.normal.x * contact.depth;
        this.camera.position.y += contact.normal.y * contact.depth;
        this.camera.position.z += contact.normal.z * contact.depth;
      }
      this.camera.rebuildAnglesAndRadius();
      return;
    }
    if (this.hangarMode && this.mvpOrbitRadPerSec !== 0) {
      this.camera.alpha += this.mvpOrbitRadPerSec * Math.max(0, dt);
    }
    if (!this.followTarget) return;

    this.scratchTargetPos.copyFrom(this.followTarget.position);
    if (!this.seeded) {
      this.seeded = true;
      this.followPoint.copyFrom(this.scratchTargetPos);
    }

    // Exponential smoothing toward the followed ship, frame-rate independent.
    const t = 1 - Math.pow(1 - this.followLag, dt * 60);
    Vector3.LerpToRef(this.followPoint, this.scratchTargetPos, t, this.followPoint);

    if (this.chaseMode) {
      // The rig is posed from the ship's FRAME, smoothed as directions rather
      // than as Euler coordinates (mutated in place; no allocation and no
      // setTarget(), which would recompute alpha/beta/radius from the position
      // and undo exactly what we just set). The nose smooths with `yawLag`, the
      // up with `pitchLag` (the axis pitch/roll motion lands on); the up is
      // then re-squared against the smoothed nose so the pose stays a frame.
      if (!this.chaseSeeded) {
        this.chaseSeeded = true;
        this.chaseSmoothNose.copyFrom(this.chaseNoseTarget);
        this.chaseSmoothUp.copyFrom(this.chaseUpTarget);
      } else {
        approachDirection(this.chaseSmoothNose, this.chaseNoseTarget, this.chase.yawLag, dt);
        approachDirection(this.chaseSmoothUp, this.chaseUpTarget, this.chase.pitchLag, dt);
      }
      // Gram–Schmidt the smoothed up against the smoothed nose: the two
      // smoothers run at their own lags, so orthogonality is re-imposed rather
      // than assumed. Degenerate (up ~ parallel to nose) can only follow a
      // teleport-scale correction; snap to the target up.
      const n = this.chaseSmoothNose;
      const u = this.chaseSmoothUp;
      const dot = u.x * n.x + u.y * n.y + u.z * n.z;
      u.x -= dot * n.x;
      u.y -= dot * n.y;
      u.z -= dot * n.z;
      const lenSq = u.x * u.x + u.y * u.y + u.z * u.z;
      if (lenSq > 1e-12) {
        const inv = 1 / Math.sqrt(lenSq);
        u.x *= inv;
        u.y *= inv;
        u.z *= inv;
      } else {
        u.copyFrom(this.chaseUpTarget);
      }
      // Re-asserted every frame so a hot-reloaded chase block applies live.
      this.applyChasePose(this.chaseSmoothNose, this.chaseSmoothUp);
      this.camera.target.copyFrom(this.followPoint);
      this.camera.target.y += this.chase.height;
      this.avoidChaseTerrain(dt);
      // No arena-bounds clamp: the target IS the ship, so it is inside the
      // bounds by construction.
    } else {
      this.camera.target.copyFrom(this.followPoint);
    }

    // Shake rides LAST and outside the clamp bookkeeping above: it is a
    // per-frame decoration on the final target, never part of the pan state.
    if (this.shakeOffset.x !== 0 || this.shakeOffset.z !== 0) {
      this.camera.target.x += this.shakeOffset.x;
      this.camera.target.z += this.shakeOffset.z;
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pointerObserver) this.scene.onPointerObservable.remove(this.pointerObserver);
    this.pointerObserver = null;
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.camera.dispose();
  }
}
