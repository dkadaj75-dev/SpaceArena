import { ArcRotateCamera, Vector3, type Scene, type TransformNode } from "@babylonjs/core";
import { createLogger, type CameraConfig, type ConfigService, type EventBus, type ConfigEvents } from "@space-arena/shared";

const log = createLogger("TacticalCamera");

const CAMERA_CONFIG_ID = "camera.default";

/**
 * `ArcRotateCamera` rig for the 3/4 tactical view (§2.1). Limits/speeds come
 * from `camera.json`; the rig smoothly follows a target `TransformNode`
 * (the player ship) with a look-ahead bias, and re-applies live on hot-reload.
 */
export class TacticalCamera {
  readonly camera: ArcRotateCamera;
  private followTarget: TransformNode | null = null;
  private followLag = 0.15;
  private lookAhead = 6;
  private unsubscribe: (() => void) | null = null;

  // Scratch vectors reused every update() call — no per-frame allocations.
  private readonly scratchTargetPos = new Vector3();
  private readonly scratchForward = new Vector3();
  private previousTargetPos: Vector3 | null = null;
  private editorMode = false;
  private hangarMode = false;
  private pointersInput: { buttons: number[] } | undefined;

  constructor(
    private readonly scene: Scene,
    canvas: HTMLCanvasElement,
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

    this.applyLimits(config);

    // Attach orbit/zoom control, then restrict orbit dragging to the right mouse
    // button only — left click/tap stays 100% free for gameplay (tap-to-move etc).
    this.camera.attachControl(canvas, true);
    this.pointersInput = this.camera.inputs.attached.pointers as unknown as
      | { buttons: number[] }
      | undefined;
    if (this.pointersInput) this.pointersInput.buttons = [2];

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
        this.applyLimits(fresh);
      }
    });
  }

  private applyLimits(config: CameraConfig | undefined): void {
    if (this.editorMode || this.hangarMode) return;
    this.camera.lowerBetaLimit = config?.beta.min ?? 0.6;
    this.camera.upperBetaLimit = config?.beta.max ?? 1.15;
    this.camera.lowerRadiusLimit = config?.radius.min ?? 25;
    this.camera.upperRadiusLimit = config?.radius.max ?? 100;
    this.followLag = config?.followLag ?? this.followLag;
    this.lookAhead = config?.lookAhead ?? this.lookAhead;
  }

  /** Follow a transform node (the player ship) with smoothed lag + look-ahead. */
  follow(target: TransformNode): void {
    this.followTarget = target;
    this.previousTargetPos = null;
  }

  /** Temporarily turn the tactical rig into an unrestricted editor orbit camera. */
  setEditorMode(enabled: boolean): void {
    this.editorMode = enabled;
    if (enabled) {
      this.followTarget = null;
      this.camera.lowerBetaLimit = 0.05;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.02;
      this.camera.lowerRadiusLimit = 5;
      this.camera.upperRadiusLimit = 300;
      return;
    }
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
    if (enabled) {
      this.followTarget = null;
      this.camera.lowerBetaLimit = 0.25;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.05;
      this.camera.lowerRadiusLimit = 4;
      this.camera.upperRadiusLimit = 24;
      if (this.pointersInput) this.pointersInput.buttons = [0, 2];
      return;
    }
    if (this.pointersInput) this.pointersInput.buttons = [2];
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /** Snap the camera to look at `target` at the given radius/beta — used to stage the Hangar preview. */
  stageAt(target: Vector3, radius: number, alpha: number, beta: number): void {
    this.camera.target.copyFrom(target);
    this.camera.radius = radius;
    this.camera.alpha = alpha;
    this.camera.beta = beta;
  }

  /** Call once per render frame. `dt` in seconds. No allocations. */
  update(dt: number): void {
    if (!this.followTarget) return;

    this.scratchTargetPos.copyFrom(this.followTarget.position);

    // Look-ahead: bias the followed point along the ship's recent travel direction.
    if (this.previousTargetPos) {
      this.scratchForward
        .copyFrom(this.scratchTargetPos)
        .subtractInPlace(this.previousTargetPos);
      const speed = this.scratchForward.length();
      if (speed > 1e-4) {
        this.scratchForward.normalize().scaleInPlace(this.lookAhead);
        this.scratchTargetPos.addInPlace(this.scratchForward);
      }
    }

    if (!this.previousTargetPos) {
      this.previousTargetPos = new Vector3();
    }
    this.previousTargetPos.copyFrom(this.followTarget.position);

    // Exponential smoothing toward the look-ahead-biased target, frame-rate independent.
    const t = 1 - Math.pow(1 - this.followLag, dt * 60);
    Vector3.LerpToRef(this.camera.target, this.scratchTargetPos, t, this.camera.target);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.camera.dispose();
  }
}
