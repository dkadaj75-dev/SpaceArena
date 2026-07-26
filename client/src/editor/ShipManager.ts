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
  emittersOf,
  evalCurve,
  hardpointsOf,
  moduleFamily,
  shipSchema,
  signalId,
  type EffectConfig,
  type EmitterBinding,
  type ModuleConfig,
  type ModuleFamily,
  type ShipConfig,
  type SignalId,
  type SocketConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
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
  /** Persistent, dismissable warnings (reorder DB-fitting remaps) — survive replace() success. */
  private readonly sticky = new StickyWarnings();
  /** A candidate ship replace() rejected for fitting incompatibility, awaiting a one-click fix. */
  private blockedCandidate: ShipConfig | null = null;

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
    this.element.append(topRow);

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
    this.element.append(this.socketListSection(ship));
    this.element.append(this.selectedSocketSection(ship));
    this.element.append(this.defaultFittingSection(ship));
    this.element.append(this.signalSimulatorSection(ship));
    this.element.append(this.coreStatsSection(ship));
  }

  /**
   * GLB hull picker (render.model): content-relative path with a datalist of
   * models discovered by the dev server, plus scale / yaw-correction fields.
   * Empty path reverts to the procedural recipe.
   */
  private modelSection(ship: ShipConfig): HTMLElement {
    const box = section("Ship model (GLB)");

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
      void this.assets.ensureModel(render).then((master) => {
        if (!master) {
          this.report(`${ship.id}: model "${path}" failed to load — check the path (content-relative).`);
          return;
        }
        this.replace(next);
      });
    });

    box.append(
      row(text("Path "), pathInput, apply),
      row(text("Scale "), scaleInput, text(" Yaw correction (rad) "), yawInput),
      hint("Convention: nose must face +Z. Use yaw correction for models authored facing another axis."),
    );
    return box;
  }

  /** Socket list with add / per-row select + duplicate/delete. */
  private socketListSection(ship: ShipConfig): HTMLElement {
    const box = section("Sockets");
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
    const box = section("Selected socket");
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
    const list = section("bindings");
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
    const box = section("Default fitting");
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
    const box = section("Signal simulator");
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
    const box = section("Core stats & metadata");
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
    this.renderUi();
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

  private async save(): Promise<void> {
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

    const master = this.assets.getShipMaster(ship.render);
    this.hullIsPlaceholder = master.name.includes("placeholder");
    const hull = master.clone(`shipPreviewHull.${ship.id}`);
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
    if (this.simOn) this.startParticles(ship);
  }

  /** Project 3D marker positions to screen and place HTML labels over the canvas. */
  private updateLabels(): void {
    const engine = this.scene.getEngine();
    const canvas = engine.getRenderingCanvas();
    const cam = this.scene.activeCamera;
    if (!canvas || !cam) return;
    const rect = canvas.getBoundingClientRect();
    const rw = engine.getRenderWidth();
    const rh = engine.getRenderHeight();
    for (const [index, label] of this.labels) {
      const marker = this.markers.get(index);
      if (!marker) continue;
      const p = Vector3.Project(marker.getAbsolutePosition(), Matrix.Identity(), this.scene.getTransformMatrix(), cam.viewport.toGlobal(rw, rh));
      const onScreen = p.z > 0 && p.z < 1 && p.x >= 0 && p.x <= rw && p.y >= 0 && p.y <= rh;
      label.style.display = onScreen ? "block" : "none";
      label.style.left = `${rect.left + (p.x / rw) * rect.width}px`;
      label.style.top = `${rect.top + (p.y / rh) * rect.height}px`;
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
function section(title: string): HTMLElement {
  const box = document.createElement("details");
  box.open = true;
  const summary = document.createElement("summary");
  summary.textContent = title;
  box.append(summary);
  return box;
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
