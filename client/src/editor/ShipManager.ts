import {
  Color3,
  Color4,
  DynamicTexture,
  GizmoManager,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointerEventTypes,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Observer,
  type PointerInfo,
  type Scene,
} from "@babylonjs/core";
import {
  COMBAT_MULT_MAX,
  COMBAT_MULT_MIN,
  DEFAULT_COMBAT_MULT,
  DEFAULT_PURSUIT_ZOOM,
  emittersOf,
  evalCurve,
  hardpointsOf,
  moduleFamily,
  PURSUIT_ZOOM_MAX,
  PURSUIT_ZOOM_MIN,
  shipSchema,
  signalId,
  SKIN_ELEMENT_LABEL,
  SKIN_ELEMENTS,
  wiringFor,
  type EffectConfig,
  type EmitterBinding,
  type ModuleConfig,
  type ModuleFamily,
  type ShipCombat,
  type ShipConfig,
  type SignalId,
  type SkinElement,
  type SocketConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { pinCloneHierarchyLod0 } from "../core/modelLod.js";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { bindGizmoCameraSuspend } from "./EditorStage.js";
import {
  addBinding,
  addSocket,
  clearIncompatibleFitting,
  deleteSocket,
  duplicateSocket,
  hardpointIndexOf,
  incompatibleFittingSlots,
  patchBinding,
  removeBinding,
  reorderHardpoint,
  setBindingCurve,
  setEmitterEffect,
  setHardpointAccepts,
  setSocketId,
  setSocketTransform,
  type CurvePoint,
  type FittingIssue,
  type ModuleRef,
  type SocketKind,
} from "./socketOps.js";
import { StickyWarnings } from "./stickyWarnings.js";
import { applicationNotice } from "./applicationScope.js";
import { ViewportContextPanel, type CtxField, type CtxView } from "./ViewportContextPanel.js";

const ALL_SIGNALS = signalId.options as readonly SignalId[];
const ALL_FAMILIES = moduleFamily.options as readonly ModuleFamily[];
/** Base effect fields a binding param can drive AND we can map onto a Babylon ParticleSystem. */
const MAPPABLE_PARAMS = new Set(["emitRate", "lifeMin", "lifeMax", "sizeMin", "sizeMax", "speedMin", "speedMax"]);

/** Marker colours per socket kind (unknown kinds → magenta so new kinds are visible). */
function markerColor(kind: string): Color3 {
  if (kind === "hardpoint") return new Color3(0.15, 0.85, 1.0); // cyan
  if (kind === "emitter") return new Color3(1.0, 0.55, 0.1); // orange
  return new Color3(1.0, 0.1, 0.85); // magenta
}

/**
 * Ship Manager (4.6 ⭐) — the editor that makes ships fully data-editable: an
 * orbitable 3D preview with gizmo-draggable socket markers, a per-socket form,
 * a live emitter signal simulator, and a default-fitting editor. Everything is
 * editor-owned (no dependency on game rendering); edits flow through
 * `configService.replace` and save via the dev save endpoint.
 */
export class ShipManager implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly scene: Scene;
  private readonly previewRoot: TransformNode;
  private readonly gizmos: GizmoManager;
  private readonly unbindGizmoSuspend: () => void;
  private readonly unbindGizmoCommit: () => void;
  private readonly assets: AssetRegistry;
  private readonly labelLayer: HTMLDivElement;

  private hullMesh: Mesh | null = null;
  private hullIsPlaceholder = false;
  private readonly markers = new Map<number, AbstractMesh>();
  private readonly labels = new Map<number, HTMLDivElement>();
  private pointerObserver: Observer<PointerInfo> | null = null;
  private beforeRenderObserver: Observer<Scene> | null = null;

  private shipId: string;
  private selectedIndex: number | null = null;
  private readonly ctx = new ViewportContextPanel(() => this.deselect());
  /** Inspector "Selected socket" section — the context panel's deep-link target. */
  private selectedSocketBox: HTMLElement | null = null;
  /** Persistent, dismissable warnings (reorder DB-fitting remaps) — survive replace() success. */
  private readonly sticky = new StickyWarnings();
  /**
   * Remembered accordion opens, keyed by section title. renderUi() rebuilds
   * this whole panel on every commit, so without the memory a section would
   * slam shut under the cursor on each edit — and the panel opens folded, so
   * that shut state would be the one it snapped back to.
   */
  private readonly folds = new Map<string, boolean>();
  /** Ship ids whose GLB hull load has been kicked — one background load per ship, no retry loop on failure. */
  private readonly hullLoadKicked = new Set<string>();
  /** A candidate ship replace() rejected for fitting incompatibility, awaiting a one-click fix. */
  private blockedCandidate: ShipConfig | null = null;
  /**
   * The in-flight model Apply, if any. Apply swaps the config only after its
   * GLB loads (async fetch) — Save must await it, or a quick Apply→Save writes
   * the pre-Apply config to disk while the preview shows the new model.
   */
  private pendingModelApply: Promise<void> | null = null;

  // Signal simulator state.
  private simOn = false;
  private readonly simValues = new Map<SignalId, number>(ALL_SIGNALS.map((s) => [s, 0]));
  private particleTexture: DynamicTexture | null = null;
  private readonly particles: { ps: ParticleSystem; socketIndex: number; bindings: EmitterBinding[]; base: EffectConfig["base"] }[] = [];

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.scene = host.scene;
    this.previewRoot = new TransformNode("editorShipPreview", this.scene);
    this.assets = new AssetRegistry(this.scene);
    this.gizmos = new GizmoManager(this.scene);
    this.gizmos.positionGizmoEnabled = true;
    this.gizmos.rotationGizmoEnabled = true;
    this.gizmos.scaleGizmoEnabled = true;
    this.gizmos.usePointerToAttachGizmos = false;
    // A gizmo drag must move the socket marker only — freeze the editor
    // camera's orbit/pan gestures for the duration of the drag.
    this.unbindGizmoSuspend = bindGizmoCameraSuspend(this.gizmos, (on) => host.suspendCameraGestures(on));
    this.unbindGizmoCommit = bindGizmoSocketCommit(this.gizmos, () => {
      if (this.selectedIndex !== null) this.commitFromMarker(this.selectedIndex);
    });

    this.labelLayer = document.createElement("div");
    Object.assign(this.labelLayer.style, { position: "fixed", left: "0", top: "0", pointerEvents: "none", zIndex: "999" });
    document.body.append(this.labelLayer);

    this.shipId = host.configService.getAll<ShipConfig>("ship")[0]?.id ?? "";

    this.pointerObserver = this.scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERPICK || !info.pickInfo?.hit || !info.pickInfo.pickedMesh) return;
      const tagged = info.pickInfo.pickedMesh.metadata as { socketIndex?: number } | null;
      if (tagged?.socketIndex !== undefined) this.select(tagged.socketIndex);
    });
    this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() => this.updateLabels());

    this.rebuildPreview();
    this.focusCamera();
    this.renderUi();
  }

  private ship(): ShipConfig | undefined {
    return this.host.configService.get<ShipConfig>("ship", this.shipId);
  }

  /** Frame the preview: target the origin and pull the orbit in so the ship fills the view. */
  private focusCamera(): void {
    const cam = this.scene.activeCamera as unknown as {
      setTarget?: (v: Vector3) => void;
      radius?: number;
      beta?: number;
    };
    cam?.setTarget?.(Vector3.Zero());
    if (cam && typeof cam.radius === "number") {
      const hullRadius = this.hullMesh?.getBoundingInfo().boundingSphere.radiusWorld ?? 4;
      cam.radius = Math.max(8, hullRadius * 3.5);
      cam.beta = 1.1;
    }
  }

  // ---------------------------------------------------------------- UI ----

  /**
   * One collapsible section, FOLDED on first render. This panel stacks eleven
   * of them (model, emissive, camera, combat, skins, sockets, fitting, core
   * stats…); opening them all made every ship a wall of controls with the one
   * being edited buried somewhere in the middle. {@link folds} keeps whatever
   * the designer opened alive across renderUi()'s full rebuild.
   */
  private section(title: string): HTMLElement {
    const box = document.createElement("details");
    box.open = this.folds.get(title) ?? false;
    box.addEventListener("toggle", () => this.folds.set(title, box.open));
    const summary = document.createElement("summary");
    summary.textContent = title;
    box.append(summary);
    return box;
  }

  private renderUi(): void {
    this.element.replaceChildren();
    const ships = this.host.configService.getAll<ShipConfig>("ship");

    const select = document.createElement("select");
    for (const s of ships) select.append(new Option(s.name ?? s.id, s.id, false, s.id === this.shipId));
    select.addEventListener("change", () => {
      this.shipId = select.value;
      this.selectedIndex = null;
      this.gizmos.attachToMesh(null);
      this.rebuildPreview();
      this.focusCamera();
      this.renderUi();
    });
    const newBtn = button("New ship", () => this.createShip());
    const saveBtn = button("Save to disk", () => void this.save());
    const topRow = row(text("Ship "), select, newBtn, saveBtn);
    this.element.append(topRow, applicationNotice("ship"));

    const ship = this.ship();
    if (!ship) {
      this.element.append(text("No ship configs loaded."));
      return;
    }

    // Relational fitting validation (Finding 6) + sticky warnings (Finding 7) gate Save.
    const issues = incompatibleFittingSlots(this.blockedCandidate ?? ship, this.moduleRefs());
    const saveBlocked = issues.length > 0 || this.blockedCandidate !== null || !this.sticky.saveAllowed;
    saveBtn.disabled = saveBlocked;
    if (saveBlocked) saveBtn.title = "Resolve the incompatible fitting and acknowledge sticky warnings before saving.";
    if (issues.length > 0 || this.blockedCandidate) this.element.append(this.incompatibleBanner(issues));
    if (this.sticky.hasWarnings) this.element.append(this.stickyWarningsSection());

    // Unknown render recipe → placeholder warning (brawler/support use recipes with no builder yet).
    if (this.hullIsPlaceholder) {
      this.element.append(warn(`Render recipe "${ship.render.recipe}" has no procedural builder — showing a placeholder capsule.`));
    }

    this.element.append(this.modelSection(ship));
    this.element.append(this.emissiveSection(ship));
    this.element.append(this.pursuitCameraSection(ship));
    this.element.append(this.combatProfileSection(ship));
    this.element.append(this.skinLogicSection(ship));
    this.element.append(this.socketListSection(ship));
    this.element.append(this.selectedSocketSection(ship));
    this.element.append(this.defaultFittingSection(ship));
    this.element.append(this.signalSimulatorSection(ship));
    this.element.append(this.coreStatsSection(ship));

    if (this.selectedIndex !== null && ship.sockets[this.selectedIndex]) this.ctx.show(this.socketContextView(ship, this.selectedIndex));
    else this.ctx.hide();
  }

  /** Floating in-viewport summary of the selected socket; heavy edits deep-link to the inspector. */
  private socketContextView(ship: ShipConfig, index: number): CtxView {
    const socket = ship.sockets[index]!;
    const transform = (patch: Partial<{ pos: [number, number, number]; rot: [number, number, number]; scale: number }>): void => {
      const current = { pos: [...socket.transform.pos] as [number, number, number], rot: [...(socket.transform.rot ?? [0, 0, 0])] as [number, number, number], scale: socket.transform.scale ?? 1 };
      this.replace(setSocketTransform(ship, index, { ...current, ...patch }));
    };
    const pos = socket.transform.pos;
    const rot = socket.transform.rot ?? [0, 0, 0];
    const axes = ["x", "y", "z"] as const;
    const fields: CtxField[] = [
      { kind: "static", label: "kind", value: socket.kind },
      ...axes.map((axis, i): CtxField => ({ kind: "number", label: `pos ${axis}`, key: `p${axis}`, value: pos[i] ?? 0, onCommit: (value) => { const next = [...pos] as [number, number, number]; next[i] = value; transform({ pos: next }); } })),
      ...axes.map((axis, i): CtxField => ({ kind: "number", label: `rot ${axis} (rad)`, key: `r${axis}`, value: rot[i] ?? 0, onCommit: (value) => { const next = [...rot] as [number, number, number]; next[i] = value; transform({ rot: next }); } })),
      { kind: "number", label: "scale", key: "scale", value: socket.transform.scale ?? 1, min: 0.01, onCommit: (value) => { if (value > 0) transform({ scale: value }); } },
    ];
    if (socket.kind === "hardpoint") {
      fields.push({ kind: "static", label: "accepts", value: socket.accepts.join(", ") });
      fields.push({ kind: "link", label: "Accepts & reorder ▸ inspector", onClick: () => this.revealInspectorSocket() });
    } else if (socket.kind === "emitter") {
      fields.push({ kind: "select", label: "effect", value: socket.effect, options: this.host.configService.getAll<EffectConfig>("effect").map((e) => ({ value: e.id, label: e.name ?? e.id })), onCommit: (id) => this.replace(setEmitterEffect(ship, index, id)) });
      fields.push({ kind: "static", label: "bindings", value: String(socket.bindings.length) });
      fields.push({ kind: "link", label: "Bindings & curves ▸ inspector", onClick: () => this.revealInspectorSocket() });
    }
    return {
      title: socket.kind === "hardpoint" ? `#${hardpointIndexOf(ship, index)} ${socket.id}` : socket.id,
      subtitle: ship.id,
      fields,
      actions: [
        { label: "Duplicate", onClick: () => this.replace(duplicateSocket(ship, index)) },
        { label: "Frame", onClick: () => this.frameSocket(index) },
        { label: "Delete", onClick: () => { this.deselect(); this.replace(deleteSocket(ship, index)); }, danger: true },
      ],
    };
  }

  private revealInspectorSocket(): void {
    this.selectedSocketBox?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  private frameSocket(index: number): void {
    const marker = this.markers.get(index);
    const cam = this.scene.activeCamera as unknown as { setTarget?: (v: Vector3) => void; radius?: number };
    if (!marker || !cam) return;
    cam.setTarget?.(marker.getAbsolutePosition());
    if (typeof cam.radius === "number") cam.radius = Math.max(4, (this.hullMesh?.getBoundingInfo().boundingSphere.radiusWorld ?? 4) * 1.2);
  }

  private deselect(): void {
    this.selectedIndex = null;
    this.gizmos.attachToMesh(null);
    this.renderUi();
  }

  /**
   * GLB hull picker (render.model): content-relative path with a datalist of
   * models discovered by the dev server, plus scale / yaw-correction fields.
   * Empty path reverts to the procedural recipe.
   */
  private modelSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Ship model (GLB)");

    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.placeholder = "procedural recipe (no model)";
    pathInput.value = ship.render.model ?? "";
    pathInput.setAttribute("list", "sa-model-paths");
    let datalist = document.getElementById("sa-model-paths") as HTMLDataListElement | null;
    if (!datalist) {
      datalist = document.createElement("datalist");
      datalist.id = "sa-model-paths";
      document.body.append(datalist);
    }
    void fetch("/__editor/list-models")
      .then((r) => r.json() as Promise<{ models: string[] }>)
      .then(({ models }) => {
        datalist.replaceChildren(...models.map((m) => new Option(m)));
      })
      .catch(() => undefined);

    const scaleInput = document.createElement("input");
    scaleInput.type = "number";
    scaleInput.step = "0.1";
    scaleInput.min = "0.01";
    scaleInput.value = String(ship.render.modelScale ?? 1);
    const yawInput = document.createElement("input");
    yawInput.type = "number";
    yawInput.step = "0.1";
    yawInput.value = String(ship.render.modelRotationY ?? 0);
    // Scale/yaw commit THEMSELVES when a model is already set — "Apply" is only
    // needed to swap the model path. Without this, editing the number and
    // pressing Save wrote the untouched config (the "scale does not work" trap).
    const commitTransform = (): void => {
      const current = this.ship();
      if (!current?.render.model) return;
      const scale = Number(scaleInput.value);
      const yaw = Number(yawInput.value);
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(yaw)) return;
      if (current.render.modelScale === scale && (current.render.modelRotationY ?? 0) === yaw) return;
      const render = { ...current.render, modelScale: scale, modelRotationY: yaw };
      // Load the re-keyed master first so the preview swap is immediate.
      this.pendingModelApply = this.assets.ensureModel(render).then(() => {
        this.replace({ ...current, render });
        this.pendingModelApply = null;
      });
    };
    for (const input of [scaleInput, yawInput]) {
      input.addEventListener("change", commitTransform);
      // Spinner/scroll steps emit `input` with no inputType; commit them live.
      input.addEventListener("input", (ev) => { if (!(ev as InputEvent).inputType) commitTransform(); });
    }

    const apply = button("Apply", () => {
      const path = pathInput.value.trim();
      const scale = Number(scaleInput.value) || 1;
      const yaw = Number(yawInput.value) || 0;
      const render = { ...ship.render };
      if (path) {
        render.model = path;
        render.modelScale = scale;
        render.modelRotationY = yaw;
      } else {
        delete render.model;
        delete render.modelScale;
        delete render.modelRotationY;
      }
      const next = { ...ship, render };
      if (!path) {
        this.replace(next);
        return;
      }
      // Load first so the preview swap is immediate; fall back with a report.
      // Tracked in pendingModelApply so Save can't race past it (see save()).
      const pending = this.assets.ensureModel(render).then((master) => {
        if (!master) {
          this.report(`${ship.id}: model "${path}" failed to load — check the path (content-relative).`);
          return;
        }
        this.replace(next);
      });
      this.pendingModelApply = pending;
      void pending.finally(() => {
        if (this.pendingModelApply === pending) this.pendingModelApply = null;
      });
    });

    box.append(
      row(text("Path "), pathInput, apply),
      row(text("Scale "), scaleInput, text(" Yaw correction (rad) "), yawInput),
      hint("Convention: nose must face +Z. Use yaw correction for models authored facing another axis."),
    );
    return box;
  }

  /**
   * SKINS LOGIC — which of THIS model's materials each skin element covers, and
   * which emitter sockets count as propulsion.
   *
   * This is the half of the skin system that belongs to the hull rather than to
   * the livery. A skin says what "body" looks like; this says what "body" IS on
   * this model. An element wired to nothing is a GATE: a skin can fill its
   * canopy row completely and it will still render nothing here, which is how a
   * designer keeps a paint off the glass, the dark tech recesses or the bloom.
   *
   * The dropdowns list the model's real material slots (and the ship's real
   * emitter sockets), so a name can only be added if it exists — and anything
   * already wired that the model has since lost is shown flagged rather than
   * dropped.
   */
  private skinLogicSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Skins logic");
    const materials = this.assets.materialSlotNames(ship.render);
    const sockets = emittersOf(ship).map((socket) => socket.id);

    for (const element of SKIN_ELEMENTS) {
      const isPropulsion = element === "propulsion";
      const choices = isPropulsion ? sockets : materials;
      const wired = wiringFor(ship.skin, element);

      const select = document.createElement("select");
      const unused = choices.filter((name) => !wired.some((w) => w.toLowerCase() === name.toLowerCase()));
      for (const name of unused) select.append(new Option(name, name));
      select.disabled = unused.length === 0;

      const add = button("Add", () => {
        if (!select.value) return;
        this.setWiring(element, [...wiringFor(this.ship()?.skin, element), select.value]);
      });
      add.disabled = unused.length === 0;

      const head = row(text(`${SKIN_ELEMENT_LABEL[element]} `), select, add);
      head.dataset["skinElement"] = element;
      box.append(head);

      if (wired.length === 0) {
        box.append(hint(`No ${isPropulsion ? "emitters" : "materials"} — skins leave this element alone on this hull.`));
        continue;
      }
      for (const name of wired) {
        const known = choices.some((choice) => choice.toLowerCase() === name.toLowerCase());
        const label = text(known ? name : `${name} (not in this model)`);
        label.className = known ? "ed-mono" : "ed-warn";
        const line = row(
          label,
          button("Remove", () => {
            this.setWiring(element, wiringFor(this.ship()?.skin, element).filter((entry) => entry !== name));
          }),
        );
        line.dataset["wired"] = `${element}:${name}`;
        box.append(line);
      }
    }

    box.append(
      hint("Materials come from the loaded GLB; propulsion takes emitter socket ids instead, because a skin swaps their particle effect rather than their surface."),
    );
    return box;
  }

  /** Commit one element's wiring, dropping the key entirely when it empties. */
  private setWiring(element: SkinElement, names: string[]): void {
    const current = this.ship();
    if (!current) return;
    const skin: Record<string, string[]> = { ...current.skin, [element]: names };
    if (names.length === 0) delete skin[element];
    // An all-empty wiring block is written as ABSENT, not as `{}`: "this hull
    // wires nothing" and "this hull has no skins logic yet" are the same state,
    // and only one of them should reach the content file.
    const next: ShipConfig = Object.keys(skin).length === 0
      ? { ...current, skin: undefined }
      : { ...current, skin };
    this.replace(next);
    this.renderUi();
  }

  /**
   * Emissive light picker (render.emissiveGlow): every material slot of the
   * ship's GLB in a dropdown (plus "None"), and the sim signal that drives the
   * glow — the selected slot emits its own texture as light, 10% at signal 0 up
   * to 100% at signal 1, per ship instance. Commits itself like scale/yaw and
   * re-wires the already-loaded master so the preview updates immediately.
   */
  private emissiveSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Emissive light");

    const materialSelect = document.createElement("select");
    const signalSelect = document.createElement("select");
    for (const id of signalId.options) signalSelect.append(new Option(id, id));
    signalSelect.value = ship.render.emissiveGlow?.source ?? "throttle";

    const populate = (names: string[]): void => {
      const current = this.ship()?.render.emissiveGlow?.material ?? "";
      materialSelect.replaceChildren(new Option("None", ""));
      for (const name of names) materialSelect.append(new Option(name, name));
      if (current && !names.includes(current)) materialSelect.append(new Option(`${current} (not in model)`, current));
      materialSelect.value = current;
      signalSelect.disabled = current === "";
    };
    populate(this.assets.materialSlotNames(ship.render));
    // The master may still be loading when the form renders; refresh the list
    // once it lands (an absent/failed model just leaves "None").
    if (ship.render.model) {
      void this.assets.ensureModel(ship.render).then((master) => {
        const current = this.ship();
        if (master && current) populate(this.assets.materialSlotNames(current.render));
      });
    }

    const commit = (): void => {
      const current = this.ship();
      if (!current) return;
      const material = materialSelect.value;
      const source = signalSelect.value as SignalId;
      signalSelect.disabled = material === "";
      const previous = current.render.emissiveGlow;
      if (material === "" ? previous === undefined : previous?.material === material && (previous.source ?? "throttle") === source) return;
      const render = { ...current.render };
      if (material === "") delete render.emissiveGlow;
      else render.emissiveGlow = { material, source };
      // Re-wire the cached master in place (its cache key ignores the glow
      // block) so the staged preview shows the change immediately.
      this.assets.applyEmissiveGlow(render);
      this.replace({ ...current, render });
    };
    materialSelect.addEventListener("change", commit);
    signalSelect.addEventListener("change", commit);

    box.append(
      row(text("Texture "), materialSelect, text(" Signal "), signalSelect),
      hint('The selected GLB material emits its own texture as light: 10% at signal 0, 100% at signal 1 (e.g. thrust via "throttle"). None = no emissive light.'),
    );
    return box;
  }

  /**
   * Pursuit-camera zoom (render.pursuitZoom): how far back the in-match chase
   * rig sits behind THIS hull, as a multiplier on the camera pack's authored
   * `chase.radius`. One radius cannot frame a 3.6-unit brawler and a 2-unit
   * interceptor alike, and this is the per-hull correction.
   *
   * Commits itself while dragging (like scale/yaw), without re-rendering the
   * inspector — a rebuild mid-drag would take the slider out from under the
   * pointer. `TacticalCamera` re-reads the value off the `config:changed` this
   * emits, so a live match reframes as the slider moves.
   */
  private pursuitCameraSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Pursuit camera");

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(PURSUIT_ZOOM_MIN);
    slider.max = String(PURSUIT_ZOOM_MAX);
    slider.step = "0.05";
    const zoomOf = (ship: ShipConfig): number => ship.render.pursuitZoom ?? DEFAULT_PURSUIT_ZOOM;
    slider.value = String(zoomOf(ship));
    const valSpan = text(`${slider.value}×`);

    const commit = (): void => {
      const current = this.ship();
      if (!current) return;
      const raw = Number(slider.value);
      if (!Number.isFinite(raw)) return;
      // Round before clamping: the slider's own steps are exact, but a value
      // typed into the DOM by a test (or a future numeric twin) is not.
      const zoom = Math.min(PURSUIT_ZOOM_MAX, Math.max(PURSUIT_ZOOM_MIN, Math.round(raw * 100) / 100));
      valSpan.textContent = `${zoom}×`;
      if (zoom === zoomOf(current)) return;
      const render = { ...current.render };
      // The default is written as ABSENT: "this hull wants the pack's distance"
      // and "this hull never authored a zoom" are the same state, and only one
      // of them belongs in the content file.
      if (zoom === DEFAULT_PURSUIT_ZOOM) delete render.pursuitZoom;
      else render.pursuitZoom = zoom;
      this.replace({ ...current, render }, false);
    };
    slider.addEventListener("input", commit);

    box.append(
      field("zoom", row(slider, valSpan, button("Reset", () => {
        slider.value = String(DEFAULT_PURSUIT_ZOOM);
        commit();
      }))),
      hint(`Multiplies the chase camera's follow distance for this hull only (${PURSUIT_ZOOM_MIN}–${PURSUIT_ZOOM_MAX}×). 1× = the camera pack's authored distance; the player's own camera-distance setting still applies on top.`),
    );
    return box;
  }

  /**
   * ROLE PROFILE (`core.combat`) — the hull-level combat multipliers that turn
   * one chassis into a kinetic brawler, an energy sniper or a shield tank
   * (owner request 2026-08-21). The counterpart to the resist matrix in "Core
   * stats": resists say what the hull SURVIVES, these say what it DELIVERS.
   *
   * Every knob is 1 by default and a knob returned to 1 is DELETED from the
   * file — an all-default block is written as absent, the same discipline the
   * skin wiring and the pursuit zoom follow, so a hull that has no opinion
   * carries no JSON.
   *
   * The sim resolves this profile at SPAWN (`resolveShipStats`), so an edit
   * reaches the fitting/DPS previews and the balance workbench immediately over
   * `config:changed`, and reaches a flying ship on its next spawn.
   */
  private combatProfileSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Combat role profile");
    const combat = ship.core.combat;

    const knob = (
      label: string,
      current: number | undefined,
      apply: (next: ShipCombat, value: number | undefined) => void,
    ): HTMLElement => {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(COMBAT_MULT_MIN);
      slider.max = String(COMBAT_MULT_MAX);
      slider.step = "0.05";
      slider.value = String(current ?? DEFAULT_COMBAT_MULT);
      const valSpan = text(`${slider.value}×`);
      const commit = (): void => {
        const raw = Number(slider.value);
        if (!Number.isFinite(raw)) return;
        const value = Math.min(COMBAT_MULT_MAX, Math.max(COMBAT_MULT_MIN, Math.round(raw * 100) / 100));
        valSpan.textContent = `${value}×`;
        // A knob back at 1 is an ABSENT knob, not a stored 1.
        this.setCombat((next) => apply(next, value === DEFAULT_COMBAT_MULT ? undefined : value));
      };
      slider.addEventListener("input", commit);
      const reset = button("Reset", () => {
        slider.value = String(DEFAULT_COMBAT_MULT);
        commit();
      });
      const line = field(label, row(slider, valSpan, reset));
      line.dataset["combatKnob"] = label;
      return line;
    };

    box.append(
      hint("Outgoing damage, per damage type this hull DEALS. A missile is scaled by both — half its warhead is kinetic and half energy."),
      knob("damage · kinetic", combat?.damageOutput?.kinetic, (c, v) => {
        c.damageOutput = { ...c.damageOutput, kinetic: v };
      }),
      knob("damage · energy", combat?.damageOutput?.energy, (c, v) => {
        c.damageOutput = { ...c.damageOutput, energy: v };
      }),
      hint("Rate of fire, by the weapon's authored damage type. Above 1 = faster: the cycle time is divided by it. A continuous beam has no cadence, so the same number scales its damage per second instead."),
      knob("fire rate · kinetic", combat?.rateOfFire?.kinetic, (c, v) => {
        c.rateOfFire = { ...c.rateOfFire, kinetic: v };
      }),
      knob("fire rate · energy", combat?.rateOfFire?.energy, (c, v) => {
        c.rateOfFire = { ...c.rateOfFire, energy: v };
      }),
      knob("fire rate · hybrid (missiles)", combat?.rateOfFire?.hybrid, (c, v) => {
        c.rateOfFire = { ...c.rateOfFire, hybrid: v };
      }),
      hint("Shield efficiency scales every fitted shield's RESERVE — its tank size and the rate it refills — which is the whole of a shield's staying power. It does not change the share a shield takes out of a hit: that belongs to the damage type, not the hull."),
      knob("shield efficiency", combat?.shieldEfficiency, (c, v) => {
        c.shieldEfficiency = v;
      }),
      hint(`All knobs ${COMBAT_MULT_MIN}–${COMBAT_MULT_MAX}×, 1× = the hull as authored. Upgrade tracks and module passives can move them further (targets: core.combat.damageOutput.kinetic, core.combat.rateOfFire.hybrid, …), but the resolved value is held inside this same band.`),
    );
    return box;
  }

  /**
   * Commit one role-profile edit, then PRUNE: a knob at its default, an empty
   * sub-block and an all-default `combat` block are each written as absent, so
   * nudging a slider back to 1 removes the field rather than pinning a 1 in the
   * content file.
   */
  private setCombat(mutate: (draft: ShipCombat) => void): void {
    const current = this.ship();
    if (!current) return;
    const draft: ShipCombat = {
      damageOutput: current.core.combat?.damageOutput ? { ...current.core.combat.damageOutput } : undefined,
      rateOfFire: current.core.combat?.rateOfFire ? { ...current.core.combat.rateOfFire } : undefined,
      shieldEfficiency: current.core.combat?.shieldEfficiency,
    };
    mutate(draft);

    const prune = <T extends object>(group: T | undefined): T | undefined => {
      if (!group) return undefined;
      const kept = Object.fromEntries(Object.entries(group).filter(([, v]) => v !== undefined));
      return Object.keys(kept).length > 0 ? (kept as T) : undefined;
    };
    const combat: ShipCombat = {
      damageOutput: prune(draft.damageOutput),
      rateOfFire: prune(draft.rateOfFire),
      shieldEfficiency: draft.shieldEfficiency,
    };
    const empty = combat.damageOutput === undefined
      && combat.rateOfFire === undefined
      && combat.shieldEfficiency === undefined;
    const core = { ...current.core, combat: empty ? undefined : combat };
    this.replace({ ...current, core }, false);
  }

  /** Socket list with add / per-row select + duplicate/delete. */
  private socketListSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Sockets");
    const effects = this.host.configService.getAll<EffectConfig>("effect");
    const addHp = button("+ Hardpoint", () => this.replace(addSocket(ship, "hardpoint")));
    const addEmit = button("+ Emitter", () => {
      const fx = effects[0]?.id;
      if (!fx) return this.report("Cannot add emitter: no effect configs exist.");
      this.replace(addSocket(ship, "emitter", fx));
    });
    box.append(row(addHp, addEmit));

    ship.sockets.forEach((socket, index) => {
      const hpIndex = hardpointIndexOf(ship, index);
      const label = socket.kind === "hardpoint" ? `#${hpIndex} ${socket.id}` : socket.id;
      const btn = button(`${dot(socket.kind)} ${label} (${socket.kind})`, () => this.select(index));
      btn.classList.add("ed-list-btn");
      btn.classList.toggle("is-selected", index === this.selectedIndex);
      // Viewport pick → inspector list stays in step (happy-dom lacks scrollIntoView).
      if (index === this.selectedIndex) queueMicrotask(() => btn.scrollIntoView?.({ block: "nearest" }));
      const dup = button("Dup", () => this.replace(duplicateSocket(ship, index)));
      const del = button("Del", () => {
        this.selectedIndex = null;
        this.gizmos.attachToMesh(null);
        this.replace(deleteSocket(ship, index));
      });
      box.append(row(btn, dup, del));
    });
    return box;
  }

  /** Editor for the currently selected socket. */
  private selectedSocketSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Selected socket");
    this.selectedSocketBox = box;
    if (this.selectedIndex === null || !ship.sockets[this.selectedIndex]) {
      box.append(text("Click a marker in the 3D view (or a socket above) to select."));
      return box;
    }
    const index = this.selectedIndex;
    const socket = ship.sockets[index]!;

    // id
    const id = document.createElement("input");
    id.type = "text";
    id.value = socket.id;
    id.addEventListener("change", () => this.replace(setSocketId(ship, index, id.value), false));
    box.append(field("id", id));

    // transform (drives the gizmo/marker too)
    box.append(this.transformEditor(ship, index, socket));

    if (socket.kind === "hardpoint") box.append(this.hardpointEditor(ship, index, socket));
    else if (socket.kind === "emitter") box.append(this.emitterEditor(ship, index, socket));
    return box;
  }

  private transformEditor(ship: ShipConfig, index: number, socket: SocketConfig): HTMLElement {
    const wrap = document.createElement("div");
    const pos = socket.transform.pos;
    const rot = socket.transform.rot ?? [0, 0, 0];
    const scale = socket.transform.scale ?? 1;
    const commit = (): void => {
      const next = setSocketTransform(ship, index, {
        pos: readTriple(posInputs),
        rot: readTriple(rotInputs),
        scale: Number(scaleInput.value),
      });
      this.replace(next);
    };
    const posInputs = triple(pos, commit);
    const rotInputs = triple(rot, commit);
    const scaleInput = numberInput(scale, commit);
    wrap.append(field("pos (x,y,z)", row(...posInputs)));
    wrap.append(field("rot (x,y,z rad)", row(...rotInputs)));
    wrap.append(field("scale", scaleInput));
    return wrap;
  }

  private hardpointEditor(ship: ShipConfig, index: number, socket: Extract<SocketConfig, { kind: "hardpoint" }>): HTMLElement {
    const box = document.createElement("div");
    const hpIndex = hardpointIndexOf(ship, index);
    const count = hardpointsOf(ship).length;
    box.append(warn(`Hardpoint index ${hpIndex}. Reordering remaps existing fittings.`));

    // accepts multi-select (checkboxes)
    const acceptsBox = document.createElement("div");
    for (const fam of ALL_FAMILIES) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = socket.accepts.includes(fam);
      cb.addEventListener("change", () => {
        const next = ALL_FAMILIES.filter((f) => (f === fam ? cb.checked : socket.accepts.includes(f)));
        if (next.length === 0) {
          cb.checked = true;
          return this.report("A hardpoint must accept at least one family.");
        }
        this.replace(setHardpointAccepts(ship, index, next));
      });
      const lbl = document.createElement("label");
      lbl.className = "ed-inline-label";
      lbl.append(cb, document.createTextNode(fam));
      acceptsBox.append(lbl);
    }
    box.append(field("accepts", acceptsBox));

    // reorder
    const up = button("◄ move earlier", () => this.doReorder(ship, hpIndex, hpIndex - 1));
    const down = button("move later ►", () => this.doReorder(ship, hpIndex, hpIndex + 1));
    up.disabled = hpIndex <= 0;
    down.disabled = hpIndex >= count - 1;
    box.append(row(up, down));
    return box;
  }

  private doReorder(ship: ShipConfig, fromHp: number, toHp: number): void {
    const { ship: next } = reorderHardpoint(ship, fromHp, toHp);
    this.selectedIndex = null;
    this.gizmos.attachToMesh(null);
    // Persistent (Finding 7): survives the replace() success that clears the transient report.
    this.sticky.add(`Player DB fittings are NOT remapped — hardpoint indices changed (reordered #${fromHp} → #${toHp}). Existing saved fittings may point at the wrong module.`);
    this.replace(next);
  }

  /** Module id+family list for relational fitting validation. */
  private moduleRefs(): ModuleRef[] {
    return this.host.configService.getAll<ModuleConfig>("module").map((m) => ({ id: m.id, family: m.family }));
  }

  /** Blocking banner listing incompatible fitting slots + a one-click fix (Finding 6). */
  private incompatibleBanner(issues: FittingIssue[]): HTMLElement {
    const box = document.createElement("div");
    box.className = "ed-callout ed-callout--danger";
    const title = document.createElement("p");
    title.textContent = "⛔ Incompatible default fitting — Save is blocked.";
    title.className = "ed-callout-title";
    box.append(title);
    for (const issue of issues) {
      const line = document.createElement("p");
      line.className = "ed-callout-line";
      const fam = issue.moduleFamily ? ` [${issue.moduleFamily}]` : "";
      const acc = issue.accepts.length ? issue.accepts.join(", ") : "— (orphaned slot: no hardpoint)";
      line.textContent = `Hardpoint #${issue.hpIndex} (${issue.socketId}): '${issue.moduleId}'${fam} is not accepted (accepts: ${acc}).`;
      box.append(line);
    }
    box.append(button("Clear incompatible slots", () => {
      const target = this.blockedCandidate ?? this.ship();
      if (!target) return;
      const fixed = clearIncompatibleFitting(target, this.moduleRefs());
      this.blockedCandidate = null;
      this.replace(fixed);
    }));
    return box;
  }

  /** Persistent, dismissable warnings + Save-acknowledge checkbox (Finding 7). */
  private stickyWarningsSection(): HTMLElement {
    const box = document.createElement("div");
    box.className = "ed-callout ed-callout--warn";
    const title = document.createElement("p");
    title.textContent = "⚠ Sticky warnings (persist until dismissed):";
    title.className = "ed-callout-title";
    box.append(title);
    this.sticky.list().forEach((message, i) => {
      const line = document.createElement("p");
      line.className = "ed-callout-line";
      line.append(button("×", () => { this.sticky.dismiss(i); this.renderUi(); }), document.createTextNode(` ${message}`));
      box.append(line);
    });
    const ack = document.createElement("input");
    ack.type = "checkbox";
    ack.checked = this.sticky.acknowledged;
    ack.addEventListener("change", () => { this.sticky.setAcknowledged(ack.checked); this.renderUi(); });
    const ackLabel = document.createElement("label");
    ackLabel.append(ack, document.createTextNode(" I understand these are not auto-fixed — allow Save"));
    box.append(ackLabel);
    box.append(button("Dismiss all", () => { this.sticky.dismissAll(); this.renderUi(); }));
    return box;
  }

  private emitterEditor(ship: ShipConfig, index: number, socket: Extract<SocketConfig, { kind: "emitter" }>): HTMLElement {
    const box = document.createElement("div");
    const effects = this.host.configService.getAll<EffectConfig>("effect");
    const effect = effects.find((e) => e.id === socket.effect);

    // effect dropdown
    const fx = document.createElement("select");
    for (const e of effects) fx.append(new Option(e.name ?? e.id, e.id, false, e.id === socket.effect));
    fx.addEventListener("change", () => this.replace(setEmitterEffect(ship, index, fx.value)));
    box.append(field("effect", fx));

    const params = effect?.params ?? [];
    // bindings editor
    const list = this.section("Bindings");
    socket.bindings.forEach((binding, bIndex) => {
      const brow = document.createElement("div");
      brow.className = "ed-row ed-subrow";

      const source = document.createElement("select");
      for (const s of ALL_SIGNALS) source.append(new Option(s, s, false, s === binding.source));
      source.addEventListener("change", () => this.replace(patchBinding(ship, index, bIndex, { source: source.value as SignalId })));

      const param = document.createElement("select");
      const paramOptions = params.length ? params : [binding.param];
      for (const p of paramOptions) param.append(new Option(p, p, false, p === binding.param));
      param.addEventListener("change", () => this.replace(patchBinding(ship, index, bIndex, { param: param.value })));

      const del = button("remove binding", () => this.replace(removeBinding(ship, index, bIndex)));
      brow.append(row(text("signal "), source, text(" param "), param, del));
      brow.append(this.curveEditor(ship, index, bIndex, binding.curve as CurvePoint[]));
      list.append(brow);
    });
    const addBtn = button("+ binding", () => this.replace(addBinding(ship, index, ALL_SIGNALS[0]!, params[0] ?? "emitRate")));
    list.append(addBtn);
    box.append(list);
    return box;
  }

  /** Editable [in,out] point list for one binding curve. */
  private curveEditor(ship: ShipConfig, index: number, bIndex: number, curve: CurvePoint[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.append(text("curve [in → out]:"));
    const commit = (points: CurvePoint[]): void => this.replace(setBindingCurve(ship, index, bIndex, points));
    curve.forEach((point, pIndex) => {
      const inIn = numberInput(point[0], () => {});
      const outIn = numberInput(point[1], () => {});
      const apply = (): void => {
        const next = curve.map((p, i) => (i === pIndex ? ([Number(inIn.value), Number(outIn.value)] as CurvePoint) : p));
        commit(next);
      };
      inIn.addEventListener("change", apply);
      outIn.addEventListener("change", apply);
      const del = button("×", () => {
        if (curve.length <= 1) return this.report("A curve needs at least one point.");
        commit(curve.filter((_, i) => i !== pIndex));
      });
      wrap.append(row(inIn, text(" → "), outIn, del));
    });
    wrap.append(button("+ point", () => commit([...curve, [1, 1]])));
    return wrap;
  }

  /** Default-fitting editor: one module dropdown per hardpoint, filtered by `accepts`. */
  private defaultFittingSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Default fitting");
    box.append(warn("One module per hardpoint (filtered by accepts). '(none)' is honoured only for trailing hardpoints; a gap before a filled slot is filled with the first accepted module."));
    const hardpoints = hardpointsOf(ship);
    const modules = this.host.configService.getAll<ModuleConfig>("module");
    const selects: HTMLSelectElement[] = [];
    hardpoints.forEach((hp, i) => {
      const sel = document.createElement("select");
      sel.append(new Option("(none)", "", false, !ship.defaultFitting[i]));
      for (const m of modules.filter((mod) => hp.accepts.includes(mod.family))) {
        sel.append(new Option(`${m.name ?? m.id} [${m.family}]`, m.id, false, m.id === ship.defaultFitting[i]));
      }
      sel.addEventListener("change", () => this.commitFitting(ship, selects));
      selects.push(sel);
      box.append(field(`#${i} ${hp.id}`, sel));
    });
    return box;
  }

  private commitFitting(ship: ShipConfig, selects: HTMLSelectElement[]): void {
    const hardpoints = hardpointsOf(ship);
    const raw = selects.map((s) => s.value);
    let last = -1;
    raw.forEach((v, i) => { if (v) last = i; });
    const fitting: string[] = [];
    for (let i = 0; i <= last; i++) {
      let v = raw[i]!;
      if (!v) {
        // Gap before a filled slot: substitute the first accepted module to keep the array valid.
        const first = this.host.configService.getAll<ModuleConfig>("module").find((m) => hardpoints[i]!.accepts.includes(m.family));
        v = first?.id ?? "";
      }
      if (v) fitting.push(v);
    }
    const next = structuredClone(ship);
    next.defaultFitting = fitting;
    this.replace(next);
  }

  /** Signal simulator: 0..1 slider per signal + a simulate toggle driving editor-owned particles. */
  private signalSimulatorSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Signal simulator");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = this.simOn;
    toggle.addEventListener("change", () => {
      this.simOn = toggle.checked;
      if (this.simOn) this.startParticles(ship);
      else this.stopParticles();
    });
    box.append(row(toggle, text(" simulate emitters live")));
    for (const sig of ALL_SIGNALS) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.01";
      slider.value = String(this.simValues.get(sig) ?? 0);
      const valSpan = text(slider.value);
      slider.addEventListener("input", () => {
        this.simValues.set(sig, Number(slider.value));
        valSpan.textContent = slider.value;
        this.applySignals();
      });
      box.append(field(sig, row(slider, valSpan)));
    }
    return box;
  }

  /** Core-stats form via SchemaFormGen over the full ship (sockets + fitting hidden — edited above). */
  private coreStatsSection(ship: ShipConfig): HTMLElement {
    const box = this.section("Core stats & metadata");
    const form = new SchemaFormGen({
      schema: shipSchema,
      value: ship,
      configService: this.host.configService,
      onProblem: (p) => this.report(p ? `${ship.id} ${p.path}: ${p.message}` : null),
      onSaved: () => this.rebuildPreview(),
    });
    const hide = (): void => {
      for (const el of form.element.querySelectorAll<HTMLElement>(":scope > label.editor-field")) {
        const label = el.querySelector(":scope > span")?.textContent;
        if (label === "sockets" || label === "defaultFitting") el.style.display = "none";
      }
    };
    const observer = new MutationObserver(hide);
    observer.observe(form.element, { childList: true });
    hide();
    box.append(form.element);
    return box;
  }

  // ---------------------------------------------------------- selection ----

  private select(index: number): void {
    this.selectedIndex = index;
    const marker = this.markers.get(index);
    if (marker) {
      this.gizmos.attachToMesh(marker);
    }
    this.highlightSelection();
    this.renderUi();
  }

  /** Outline the selected marker so the pick reads in the viewport, not just the list. */
  private highlightSelection(): void {
    for (const [index, marker] of this.markers) {
      const mesh = marker as AbstractMesh & { renderOutline?: boolean; outlineColor?: Color3; outlineWidth?: number };
      mesh.renderOutline = index === this.selectedIndex;
      if (index === this.selectedIndex) { mesh.outlineColor = new Color3(0.34, 0.85, 1); mesh.outlineWidth = 0.06; }
    }
  }

  /** Gizmo drag ended: write the marker's transform back into the socket. */
  private commitFromMarker(index: number): void {
    const ship = this.ship();
    const marker = this.markers.get(index);
    if (!ship || !marker) return;
    const next = setSocketTransform(ship, index, {
      pos: [
        roundMarkerValue(marker.position.x),
        roundMarkerValue(marker.position.y),
        roundMarkerValue(marker.position.z),
      ],
      rot: [
        roundMarkerValue(marker.rotation.x),
        roundMarkerValue(marker.rotation.y),
        roundMarkerValue(marker.rotation.z),
      ],
      scale: roundMarkerValue(marker.scaling.x),
    });
    this.replace(next);
  }

  // ------------------------------------------------------------ replace ----

  /** Validate + swap the working copy; on success re-render preview & UI. `rerenderUi` off avoids stealing input focus. */
  private replace(ship: ShipConfig, rerenderUi = true): void {
    const result = this.host.configService.replace(ship);
    if (!result.ok) {
      // Catch fitting/accepts incompatibility first with a targeted message (Finding 6): the
      // registry rejects such candidates once shared-side validation lands, so surface which
      // slot broke and offer a one-click fix rather than a raw schema error.
      const issues = incompatibleFittingSlots(ship, this.moduleRefs());
      if (issues.length > 0) {
        this.blockedCandidate = ship;
        this.report(`${ship.id} incompatible fitting: ${issues.map((i) => `#${i.hpIndex} '${i.moduleId}'${i.moduleFamily ? ` [${i.moduleFamily}]` : ""} vs accepts [${i.accepts.join(", ") || "—"}]`).join("; ")}. Use 'Clear incompatible slots'.`);
        this.renderUi();
        return;
      }
      const msg = result.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
      this.report(`${ship.id} ${msg}`);
      return;
    }
    this.blockedCandidate = null;
    this.report(null);
    this.rebuildPreview();
    if (rerenderUi) this.renderUi();
  }

  async save(): Promise<void> {
    // A model Apply may still be loading its GLB; without this, Save writes
    // the pre-Apply config while the preview already shows the new model.
    if (this.pendingModelApply) await this.pendingModelApply;
    const ship = this.ship();
    if (!ship) return;
    // Belt-and-suspenders: never write an incompatible fit or bypass unacknowledged warnings.
    if (this.blockedCandidate || incompatibleFittingSlots(ship, this.moduleRefs()).length > 0) {
      this.report(`${ship.id}: resolve the incompatible fitting before saving.`);
      return;
    }
    if (!this.sticky.saveAllowed) {
      this.report(`${ship.id}: acknowledge the sticky warnings before saving.`);
      return;
    }
    const error = await saveConfig(ship);
    this.report(error);
  }

  private createShip(): void {
    const ships = this.host.configService.getAll<ShipConfig>("ship");
    const template = this.ship() ?? ships[0];
    if (!template) return;
    let n = 1;
    const existing = new Set(ships.map((s) => s.id));
    while (existing.has(`ship.custom-${n}`)) n++;
    const id = `ship.custom-${n}`;
    const clone: ShipConfig = { ...structuredClone(template), id, name: id };
    const result = this.host.configService.replace(clone);
    if (!result.ok) {
      this.report(result.errors.map((e) => e.message).join("; "));
      return;
    }
    this.shipId = id;
    this.selectedIndex = null;
    this.rebuildPreview();
    this.renderUi();
  }

  // ------------------------------------------------------------ preview ----

  /** Rebuild the hull + socket markers from the current ship config. */
  private rebuildPreview(): void {
    this.stopParticles();
    for (const marker of this.markers.values()) marker.dispose();
    this.markers.clear();
    for (const label of this.labels.values()) label.remove();
    this.labels.clear();
    this.hullMesh?.dispose();
    this.hullMesh = null;

    const ship = this.ship();
    if (!ship) return;

    // `getShipMaster` only returns the GLB when it is ALREADY loaded (a match or
    // the hangar preloads it; a cold editor open has not) — otherwise it falls
    // back to the procedural recipe. Kick the real load and rebuild once, per
    // ship, when it lands; a failed load stays procedural without retry loops.
    //
    // The key must carry scale AND rotation: the registry caches masters under
    // model+scale+rotation (`modelKey`), so editing `modelScale` in the form
    // creates a brand-new cache entry. Keying the kick by path alone meant the
    // first load claimed the path forever and every later scale edit rendered a
    // stale mesh — the "scale number changes but the model doesn't" bug.
    const hullKey = `${ship.id}:${ship.render.model ?? ""}:s${ship.render.modelScale ?? 1}:r${ship.render.modelRotationY ?? 0}`;
    if (ship.render.model && !this.hullLoadKicked.has(hullKey)) {
      this.hullLoadKicked.add(hullKey);
      void this.assets.ensureModel(ship.render).then((master) => {
        if (master && this.ship()?.id === ship.id) { this.rebuildPreview(); this.renderUi(); }
      });
    }
    const master = this.assets.getShipMaster(ship.render);
    this.hullIsPlaceholder = master.name.includes("placeholder");
    const hull = master.clone(`shipPreviewHull.${ship.id}`);
    pinCloneHierarchyLod0(hull);
    hull.setEnabled(true);
    hull.parent = this.previewRoot;
    hull.isPickable = false;
    this.hullMesh = hull;

    ship.sockets.forEach((socket, index) => {
      const marker = MeshBuilder.CreateSphere(`socketMarker.${index}`, { diameter: 0.35, segments: 8 }, this.scene);
      marker.parent = this.previewRoot;
      marker.position.set(socket.transform.pos[0], socket.transform.pos[1], socket.transform.pos[2]);
      const rot = socket.transform.rot ?? [0, 0, 0];
      marker.rotation.set(rot[0], rot[1], rot[2]);
      const s = socket.transform.scale ?? 1;
      marker.scaling.set(s, s, s);
      marker.metadata = { socketIndex: index };
      const mat = new StandardMaterial(`socketMat.${index}`, this.scene);
      mat.emissiveColor = markerColor(socket.kind);
      mat.disableLighting = true;
      marker.material = mat;
      this.markers.set(index, marker);

      const label = document.createElement("div");
      const hpIndex = hardpointIndexOf(ship, index);
      label.textContent = socket.kind === "hardpoint" ? `#${hpIndex} ${socket.id}` : `${socket.id} (${socket.kind})`;
      Object.assign(label.style, { position: "absolute", color: "#dfeeff", background: "#0b1220cc", padding: "1px 4px", borderRadius: "3px", font: "11px system-ui", whiteSpace: "nowrap", transform: "translate(-50%, -160%)" });
      this.labelLayer.append(label);
      this.labels.set(index, label);
    });

    // Re-attach the gizmo to the (rebuilt) selected marker.
    if (this.selectedIndex !== null) {
      const marker = this.markers.get(this.selectedIndex);
      if (marker) this.gizmos.attachToMesh(marker);
    }
    this.highlightSelection();
    if (this.simOn) this.startParticles(ship);
  }

  /** Project 3D marker positions to screen and place HTML labels over the canvas. */
  private updateLabels(): void {
    // Live-sync the context panel's transform fields with the gizmo drag.
    if (this.selectedIndex !== null && this.ctx.visible) {
      const marker = this.markers.get(this.selectedIndex);
      if (marker) {
        this.ctx.setNumber("px", marker.position.x); this.ctx.setNumber("py", marker.position.y); this.ctx.setNumber("pz", marker.position.z);
        this.ctx.setNumber("rx", marker.rotation.x); this.ctx.setNumber("ry", marker.rotation.y); this.ctx.setNumber("rz", marker.rotation.z);
        this.ctx.setNumber("scale", marker.scaling.x);
      }
    }
    const engine = this.scene.getEngine();
    const canvas = engine.getRenderingCanvas();
    const cam = this.scene.activeCamera;
    if (!canvas || !cam) return;
    const rect = canvas.getBoundingClientRect();
    const rw = engine.getRenderWidth();
    const rh = engine.getRenderHeight();
    // Project every visible label first, then de-clutter: with the ship small
    // on screen every socket projects into the same few pixels and the labels
    // pile into an unreadable blob. Stack colliders downward instead, and keep
    // the selected socket's label on top at full strength.
    const placed: { index: number; label: HTMLDivElement; x: number; y: number }[] = [];
    for (const [index, label] of this.labels) {
      const marker = this.markers.get(index);
      if (!marker) continue;
      const p = Vector3.Project(marker.getAbsolutePosition(), Matrix.Identity(), this.scene.getTransformMatrix(), cam.viewport.toGlobal(rw, rh));
      const onScreen = p.z > 0 && p.z < 1 && p.x >= 0 && p.x <= rw && p.y >= 0 && p.y <= rh;
      label.style.display = onScreen ? "block" : "none";
      if (!onScreen) continue;
      placed.push({ index, label, x: rect.left + (p.x / rw) * rect.width, y: rect.top + (p.y / rh) * rect.height });
    }
    placed.sort((a, b) => a.y - b.y || a.x - b.x);
    const ROW = 15;
    for (let i = 0; i < placed.length; i++) {
      const item = placed[i]!;
      for (let j = 0; j < i; j++) {
        const other = placed[j]!;
        if (Math.abs(other.x - item.x) < 110 && Math.abs(other.y - item.y) < ROW) item.y = other.y + ROW;
      }
      const selected = item.index === this.selectedIndex;
      item.label.style.left = `${item.x}px`;
      item.label.style.top = `${item.y}px`;
      item.label.style.opacity = selected ? "1" : "0.62";
      item.label.style.zIndex = selected ? "1000" : "999";
    }
  }

  // ---------------------------------------------------------- particles ----

  private ensureParticleTexture(): DynamicTexture {
    if (this.particleTexture) return this.particleTexture;
    const tex = new DynamicTexture("editorParticleTex", 32, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    tex.hasAlpha = true;
    tex.update();
    this.particleTexture = tex;
    return tex;
  }

  private startParticles(ship: ShipConfig): void {
    this.stopParticles();
    for (const socket of emittersOf(ship)) {
      const index = ship.sockets.indexOf(socket);
      const marker = this.markers.get(index);
      const effect = this.host.configService.get<EffectConfig>("effect", socket.effect);
      if (!marker || !effect) continue;
      const ps = new ParticleSystem(`editorPS.${index}`, effect.base.capacity, this.scene);
      ps.particleTexture = this.ensureParticleTexture();
      ps.emitter = marker as AbstractMesh;
      this.applyEffectBase(ps, effect.base);
      ps.start();
      this.particles.push({ ps, socketIndex: index, bindings: socket.bindings as EmitterBinding[], base: effect.base });
    }
    this.applySignals();
  }

  private stopParticles(): void {
    for (const p of this.particles) {
      p.ps.stop();
      p.ps.dispose();
    }
    this.particles.length = 0;
  }

  private applyEffectBase(ps: ParticleSystem, base: EffectConfig["base"]): void {
    ps.emitRate = base.emitRate;
    ps.minLifeTime = base.lifeMin;
    ps.maxLifeTime = base.lifeMax;
    ps.minSize = base.sizeMin;
    ps.maxSize = base.sizeMax;
    ps.minEmitPower = base.speedMin;
    ps.maxEmitPower = base.speedMax;
    ps.color1 = hexColor4(base.color1);
    ps.color2 = hexColor4(base.color2);
    ps.colorDead = new Color4(0, 0, 0, 0);
    const dir = base.direction ?? [0, 1, 0];
    ps.direction1 = new Vector3(dir[0], dir[1], dir[2]);
    ps.direction2 = new Vector3(dir[0], dir[1], dir[2]);
    ps.gravity = new Vector3(0, base.gravity ?? 0, 0);
  }

  /** Drive bound emitter params from current signal slider values via evalCurve (same math as the game). */
  private applySignals(): void {
    for (const p of this.particles) {
      this.applyEffectBase(p.ps, p.base);
      for (const binding of p.bindings) {
        if (!MAPPABLE_PARAMS.has(binding.param)) continue;
        const value = evalCurve(binding.curve, this.simValues.get(binding.source) ?? 0);
        applyParam(p.ps, binding.param, value);
      }
    }
  }

  dispose(): void {
    this.ctx.dispose();
    this.unbindGizmoCommit();
    this.unbindGizmoSuspend();
    this.stopParticles();
    this.particleTexture?.dispose();
    this.scene.onPointerObservable.remove(this.pointerObserver);
    this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    for (const label of this.labels.values()) label.remove();
    this.labelLayer.remove();
    this.gizmos.dispose();
    this.hullMesh?.dispose();
    for (const marker of this.markers.values()) marker.dispose();
    this.previewRoot.dispose(false, true);
    this.assets.dispose();
  }
}

// ------------------------------------------------------------- helpers ----

/**
 * Keep socket commits wired across marker rebuilds. ShipManager replaces every
 * marker after a successful edit, but the GizmoManager (and its observables)
 * live for the panel's whole lifetime.
 */
export function bindGizmoSocketCommit(gizmos: GizmoManager, commit: () => void): () => void {
  const observables = [
    gizmos.gizmos.positionGizmo?.onDragEndObservable,
    gizmos.gizmos.rotationGizmo?.onDragEndObservable,
    gizmos.gizmos.scaleGizmo?.onDragEndObservable,
  ].filter((observable) => observable !== undefined);
  const observers = observables.map((observable) => ({ observable, observer: observable.add(commit) }));
  return () => {
    for (const { observable, observer } of observers) observable.remove(observer);
  };
}

/** Trim Babylon's float32 marker round-trip noise before it reaches content JSON. */
export function roundMarkerValue(value: number): number {
  return Number(value.toFixed(4));
}

function applyParam(ps: ParticleSystem, param: string, value: number): void {
  switch (param) {
    case "emitRate": ps.emitRate = value; break;
    case "lifeMin": ps.minLifeTime = value; break;
    case "lifeMax": ps.maxLifeTime = value; break;
    case "sizeMin": ps.minSize = value; break;
    case "sizeMax": ps.maxSize = value; break;
    case "speedMin": ps.minEmitPower = value; break;
    case "speedMax": ps.maxEmitPower = value; break;
  }
}

function hexColor4(hex: string): Color4 {
  try {
    return Color3.FromHexString(hex).toColor4(1);
  } catch {
    return new Color4(1, 1, 1, 1);
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
function text(value: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = value;
  return s;
}
function warn(message: string): HTMLElement {
  const el = document.createElement("p");
  el.textContent = `⚠ ${message}`;
  el.className = "ed-warn";
  return el;
}
function hint(message: string): HTMLElement {
  const el = document.createElement("p");
  el.textContent = message;
  el.className = "ed-label";
  return el;
}
function row(...children: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "ed-row";
  div.append(...children);
  return div;
}
function field(label: string, control: Node): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "editor-field";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}
function dot(kind: SocketKind | string): string {
  return kind === "hardpoint" ? "◆" : kind === "emitter" ? "✦" : "◇";
}
function numberInput(value: number, onChange: () => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.className = "ed-input ed-num ed-num--sm";
  input.value = String(value);
  input.addEventListener("change", onChange);
  return input;
}
function triple(values: readonly number[], onChange: () => void): [HTMLInputElement, HTMLInputElement, HTMLInputElement] {
  return [numberInput(values[0] ?? 0, onChange), numberInput(values[1] ?? 0, onChange), numberInput(values[2] ?? 0, onChange)];
}
function readTriple(inputs: HTMLInputElement[]): [number, number, number] {
  return [Number(inputs[0]!.value), Number(inputs[1]!.value), Number(inputs[2]!.value)];
}
