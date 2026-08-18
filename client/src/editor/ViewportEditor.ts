import {
  AbstractMesh, Color3, GizmoManager, PointerEventTypes, TransformNode, Vector3,
  type Observer, type PointerInfo, type Scene,
} from "@babylonjs/core";
import type { AnyConfig, ArenaConfig, AsteroidConfig, PropConfig, ShipConfig } from "@space-arena/shared";
import type { DraftPackStore } from "./DraftPackStore.js";
import { AccordionState, accordion } from "./accordion.js";
import { bindGizmoCameraSuspend, bindGizmoDragCommit } from "./EditorStage.js";
import { ViewportContextPanel, type CtxField, type CtxView } from "./ViewportContextPanel.js";
import {
  LAYERS, ROTATE_SNAP, TRANSLATE_SNAP, appendPlacement, defaultLayers, emptyPairs, governingLayer,
  inferPairs, listFor, nextNodeId, nextPlacementId, reindexPairs, removePlacements,
  roundPlacementValue, snapPosition, snapRotation, toggleNavLink, twinOf, uniformScaleOf,
  type EditorPlacement, type LayerState, type PairMap, type PlacementKind,
} from "./arenaEditOps.js";
import {
  canDeleteSocket, deleteSocket, duplicateSocket, fittedSlotIndexOf, roundMarkerValue,
  setSocketTransform, socketLabel,
} from "./socketEditOps.js";
import type { ConstellationHost, ConstellationViewport, EditorMarkerTag, ViewportEditPolicy } from "./ConstellationViewport.js";

/** The two config types this session can edit in the viewport. */
export type EditableType = "arena" | "ship";

interface Subject { type: EditableType; path: string; config: AnyConfig }
interface ArenaSelection { kind: PlacementKind; index: number; node: TransformNode; mesh: AbstractMesh }
interface ShipSelection { index: number; node: TransformNode }
/** What the asset browser will drop on the next ground click. */
type Armed = { kind: "asteroid" | "prop"; id: string } | "nav" | null;

export interface ViewportEditorOptions {
  host: ConstellationHost;
  viewport: ConstellationViewport;
  /**
   * Read as a getter, never captured: importing a pack REPLACES the whole
   * `DraftPackStore`, and a session holding the old one would keep editing a
   * store nothing else is listening to.
   */
  draft: () => DraftPackStore;
  /**
   * The draft changed under the form column — re-render it, but do NOT restage
   * the viewport: this session already owns that half of the cycle and a second
   * restage would tear the handles off mid-edit.
   */
  onDraftEdit: () => void;
  /** Open and scroll the form column to a dotted field path (deep link). */
  onReveal?: (fieldPath: string) => void;
  /** One-line status/problem text for the shell. */
  onReport?: (message: string) => void;
}

/**
 * Unreal-style viewport editing for Constellation.
 *
 * The read-only {@link ConstellationViewport} draws the subject; this session is
 * what makes it an editor — pointer picking, translate/rotate/scale gizmos, the
 * layer set, the floating context panel and the asset-placement arming. It is
 * the direct port of the retired Map tool and Ships tool viewports, rebuilt on
 * Constellation's terms:
 *
 *  - **Every** edit is `DraftPackStore.setFile`. There is no `configService`,
 *    no `replace()` and no save endpoint any more: the draft is the single
 *    source of truth, so the dirty badge and Save just work.
 *  - The context panel and the generated schema form are two views of the same
 *    draft entity. Committing here re-renders the form; committing there
 *    restages this viewport.
 *  - It degrades to nothing at all when Constellation has no scene host —
 *    `GenericConfigPanel` simply never constructs one.
 */
export class ViewportEditor {
  /** The tool rail, re-rendered in place so the form column can hold it. */
  readonly element = document.createElement("div");

  private readonly scene: Scene;
  private readonly gizmos: GizmoManager;
  private readonly unbindGizmoSuspend: () => void;
  private readonly unbindGizmoCommit: () => void;
  private readonly ctx: ViewportContextPanel;
  private readonly accordions = new AccordionState("viewport-tools");
  private pointerObserver: Observer<PointerInfo> | null = null;
  private frameObserver: Observer<Scene> | null = null;

  private subject: Subject | null = null;
  private arenaSelection: ArenaSelection | null = null;
  private shipSelection: ShipSelection | null = null;
  private navSelection: number[] = [];
  private armed: Armed = null;
  private mirror = true;
  private translateSnap = true;
  private rotateSnap = true;
  private gameView = false;
  private layers = defaultLayers();
  private pairs: PairMap = emptyPairs();
  /** The arena last handed to `host.stageArena`, so a restage is only paid when it matters. */
  private stagedArenaSignature: string | null = null;
  /** Cheap change detector for the per-frame prop-visibility sweep. */
  private propSweep = { version: 0, meshes: -1, applied: -1 };

  constructor(private readonly options: ViewportEditorOptions) {
    this.scene = options.host.scene;
    this.element.className = "ed-vptools";
    this.ctx = new ViewportContextPanel(() => this.clearSelection());

    this.gizmos = new GizmoManager(this.scene);
    this.gizmos.usePointerToAttachGizmos = false;
    this.gizmos.positionGizmoEnabled = true;
    this.gizmos.rotationGizmoEnabled = true;
    this.gizmos.scaleGizmoEnabled = true;
    this.gizmos.attachToMesh(null);
    this.applySnap();
    this.unbindGizmoSuspend = bindGizmoCameraSuspend(this.gizmos, (on) => options.host.suspendCameraGestures(on));
    this.unbindGizmoCommit = bindGizmoDragCommit(this.gizmos, () => this.commitFromGizmo());

    this.pointerObserver = this.scene.onPointerObservable.add((info) => this.onPointer(info));
    this.frameObserver = this.scene.onBeforeRenderObservable.add(() => this.onFrame());
    window.addEventListener("keydown", this.onKey);
  }

  // ------------------------------------------------------------- lifecycle ---

  /**
   * Point the session at the config the catalogue just selected. Called BEFORE
   * the viewport stages it, so the marker policy is already installed when the
   * markers are built.
   */
  setSubject(path: string, config: AnyConfig): void {
    const type = editableTypeOf(config);
    if (!type) { this.detach(); return; }
    const changed = this.subject?.path !== path;
    this.subject = { type, path, config };
    if (changed) {
      this.arenaSelection = null;
      this.shipSelection = null;
      this.navSelection = [];
      this.armed = null;
      this.gizmos.attachToMesh(null);
      this.ctx.hide();
      this.layers = defaultLayers();
      this.pairs = emptyPairs();
      // Game view is an arena preview mode with exactly one way out (the arena
      // rail's own button). Carrying it onto the next subject would strand a
      // ship session with unpickable sockets and no control to restore them.
      if (this.gameView) { this.gameView = false; this.options.viewport.setFurnitureVisible(true); }
      // `stagedArenaSignature` is deliberately NOT cleared here: it records what
      // SceneBuilder is actually showing, and only `stageHostArena` /
      // `releaseHostArena` may retire it. Clearing it made the switch from an
      // arena to a ship a no-op and left the draft arena staged behind the hull.
    }
    if (type === "arena") {
      inferPairs(config as ArenaConfig, this.pairs);
      this.options.host.setSpawnMarkersForced(!this.gameView);
      this.options.host.setPropPickingForced(true);
      this.stageHostArena(config as ArenaConfig);
    } else {
      this.options.host.setSpawnMarkersForced(false);
      this.options.host.setPropPickingForced(false);
      this.releaseHostArena();
    }
    this.options.viewport.setEditPolicy(this.policy());
    this.propSweep.version++;
    this.renderTools();
  }

  /**
   * The viewport finished building markers — re-bind the handles and the
   * context panel to whatever is still selected. Without this every commit
   * (which rebuilds the markers) would silently drop the selection.
   */
  afterStage(): void {
    if (!this.subject) return;
    this.propSweep.version++;
    if (this.gameView) { this.gizmos.attachToMesh(null); this.ctx.hide(); return; }
    if (this.subject.type === "arena" && this.arenaSelection) {
      const mesh = this.options.viewport.markerFor(this.arenaSelection.kind, this.arenaSelection.index);
      if (mesh && this.canSelect(this.arenaSelection.kind, this.arenaSelection.index)) {
        this.attachArena(this.arenaSelection.kind, this.arenaSelection.index, mesh);
        return;
      }
      this.clearSelection();
      return;
    }
    if (this.subject.type === "ship" && this.shipSelection) {
      const marker = this.options.viewport.socketMarkerFor(this.shipSelection.index);
      if (marker) { this.attachSocket(this.shipSelection.index, marker); return; }
      this.clearSelection();
    }
  }

  /** No editable subject: hide every piece of editing chrome. */
  detach(): void {
    this.subject = null;
    this.arenaSelection = null;
    this.shipSelection = null;
    this.armed = null;
    this.gizmos.attachToMesh(null);
    this.ctx.hide();
    this.options.viewport.setEditPolicy(null);
    this.options.host.setSpawnMarkersForced(false);
    this.options.host.setPropPickingForced(false);
    this.releaseHostArena();
    this.element.replaceChildren();
  }

  dispose(): void {
    this.detach();
    this.ctx.dispose();
    this.unbindGizmoCommit();
    this.unbindGizmoSuspend();
    window.removeEventListener("keydown", this.onKey);
    if (this.pointerObserver) this.scene.onPointerObservable.remove(this.pointerObserver);
    if (this.frameObserver) this.scene.onBeforeRenderObservable.remove(this.frameObserver);
    this.gizmos.dispose();
  }

  // ------------------------------------------------------------ host arena ---

  /**
   * SceneBuilder draws the floor, skybox, terrain and prop instances behind the
   * markers, and it reads the LIVE registry — which never sees a draft. So the
   * draft arena is handed to it directly, and only when something it actually
   * renders has moved: a full arena rebuild loads GLBs, and paying that on every
   * asteroid nudge would make the gizmo unusable.
   */
  private stageHostArena(arena: ArenaConfig): void {
    const signature = JSON.stringify({
      id: arena.id, bounds: arena.bounds, props: arena.propPlacements,
      spawns: arena.spawnPoints, render: arena.render, lighting: arena.lighting,
    });
    if (signature === this.stagedArenaSignature) return;
    this.stagedArenaSignature = signature;
    this.options.host.stageArena(arena);
    this.propSweep.version++;
  }

  private releaseHostArena(): void {
    if (this.stagedArenaSignature === null) return;
    this.stagedArenaSignature = null;
    this.options.viewport.releaseSceneProps();
    this.options.host.stageArena(null);
  }

  // -------------------------------------------------------------- policy ----

  private policy(): ViewportEditPolicy {
    return {
      showsPlacement: (kind, index) => this.layerState(kind, index).visible,
      showsLayer: (layer) => this.layers.get(layer)?.visible ?? true,
      selectsPlacement: (kind, index) => this.canSelect(kind, index),
      selectsSockets: () => this.subject?.type === "ship" && !this.gameView,
    };
  }

  private arena(): ArenaConfig | null {
    return this.subject?.type === "arena" ? this.subject.config as ArenaConfig : null;
  }

  private ship(): ShipConfig | null {
    return this.subject?.type === "ship" ? this.subject.config as ShipConfig : null;
  }

  /** Does this prop id name ground? Resolved out of the draft pack, not the registry. */
  private isTerrainProp = (propId: string): boolean => {
    return (this.lookup("prop", propId) as PropConfig | undefined)?.category === "terrain";
  };

  private lookup(type: "prop" | "asteroid", id: string): AnyConfig | undefined {
    const bundle = this.options.draft().snapshot();
    return Object.values(bundle.files).find((file): file is AnyConfig => {
      const value = file as { type?: unknown; id?: unknown };
      return value?.type === type && value.id === id;
    });
  }

  private all<T extends AnyConfig>(type: "prop" | "asteroid"): T[] {
    const bundle = this.options.draft().snapshot();
    return Object.values(bundle.files).filter((file): file is T => (file as { type?: unknown })?.type === type)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private layerState(kind: PlacementKind, index: number): LayerState {
    const arena = this.arena();
    const layer = arena ? governingLayer(arena, kind, index, this.isTerrainProp) : kind;
    return this.layers.get(layer) ?? { visible: true, locked: false };
  }

  private canSelect(kind: PlacementKind, index: number): boolean {
    if (this.gameView) return false;
    const state = this.layerState(kind, index);
    return state.visible && !state.locked;
  }

  // --------------------------------------------------------------- input ----

  private onPointer(info: PointerInfo): void {
    if (!this.subject || this.gameView) return;
    if (info.type !== PointerEventTypes.POINTERPICK || !info.pickInfo?.hit || !info.pickInfo.pickedMesh) return;
    const mesh = info.pickInfo.pickedMesh;
    const tag = mesh.metadata as EditorMarkerTag | null;

    if (this.subject.type === "ship") {
      if (tag?.socketIndex !== undefined) this.selectSocket(tag.socketIndex, mesh);
      return;
    }

    if (this.armed) {
      // An armed asset drops where the pointer really landed: on an existing
      // prop's surface when there is one, else on the arena's invisible ground
      // plane. Both picks pass an explicit predicate, which is what lets an
      // invisible pick plane answer at all.
      const propPick = tag?.editorKind === "prop"
        ? info.pickInfo
        : this.scene.pick(this.scene.pointerX, this.scene.pointerY, (candidate) => (candidate.metadata as EditorMarkerTag | null)?.editorKind === "prop");
      const planePick = propPick?.hit
        ? null
        : this.scene.pick(this.scene.pointerX, this.scene.pointerY, (candidate) => candidate.name === "groundPlane");
      const point = propPick?.pickedPoint ?? planePick?.pickedPoint;
      if (point) this.place(point);
      return;
    }

    if (tag?.editorKind && tag.editorIndex !== undefined) {
      if (!this.canSelect(tag.editorKind, tag.editorIndex)) return;
      this.selectPlacement(tag.editorKind, tag.editorIndex, mesh);
    }
  }

  /**
   * Viewport shortcuts, deliberately inert while a form field has focus — the
   * form column is the rest of this editor, and "D" must type a D.
   */
  private onKey = (event: KeyboardEvent): void => {
    if (!this.subject) return;
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (target?.isContentEditable) return;
    if (event.key === "Delete") { event.preventDefault(); this.deleteSelection(); }
    else if (event.ctrlKey && event.key.toLowerCase() === "d") { event.preventDefault(); this.duplicateSelection(); }
    else if (event.key.toLowerCase() === "l" && this.navSelection.length === 2) { event.preventDefault(); this.commitNavLink(); }
    else if (event.key.toLowerCase() === "f") { event.preventDefault(); this.frameSelection(); }
    else if (event.key.toLowerCase() === "g" && this.subject.type === "arena") { event.preventDefault(); this.toggleGameView(); }
  };

  /**
   * Per-frame work, all of it cheap: stream the live gizmo pose into the context
   * panel's number fields, and re-apply prop layer visibility when something
   * changed (SceneBuilder instantiates props asynchronously, so the meshes a
   * layer toggle has to reach may not exist yet when it is flipped).
   */
  private onFrame(): void {
    const node = this.arenaSelection?.node ?? this.shipSelection?.node ?? null;
    if (node && this.ctx.visible) {
      this.ctx.setNumber("px", node.position.x); this.ctx.setNumber("py", node.position.y); this.ctx.setNumber("pz", node.position.z);
      this.ctx.setNumber("rx", node.rotation.x); this.ctx.setNumber("ry", node.rotation.y); this.ctx.setNumber("rz", node.rotation.z);
      this.ctx.setNumber("scale", node.scaling.x);
    }
    if (this.subject?.type !== "arena") return;
    const meshes = this.scene.meshes.length;
    if (this.propSweep.applied === this.propSweep.version && this.propSweep.meshes === meshes) return;
    this.propSweep.applied = this.propSweep.version;
    this.propSweep.meshes = meshes;
    this.options.viewport.applyScenePropVisibility();
  }

  // ----------------------------------------------------------- selection ----

  private selectPlacement(kind: PlacementKind, index: number, mesh: AbstractMesh): void {
    if (kind === "nav") this.navSelection = [...this.navSelection.filter((value) => value !== index), index].slice(-2);
    this.attachArena(kind, index, mesh);
    this.renderTools();
    this.options.onReveal?.(`${arrayFieldOf(kind)}.${index}`);
  }

  /** Attach handles + context panel without re-rendering the tool rail. */
  private attachArena(kind: PlacementKind, index: number, mesh: AbstractMesh): void {
    // A SceneBuilder prop mesh may be deep in an instantiated hierarchy; grab
    // the authored root so the gizmo moves the whole prop, not one primitive.
    let node: TransformNode = mesh;
    while (node.parent instanceof TransformNode && (node.parent.metadata as EditorMarkerTag | null)?.editorIndex === index) node = node.parent;
    this.arenaSelection = { kind, index, node, mesh };
    this.shipSelection = null;
    this.gizmos.attachToNode(node);
    this.setScaleGizmoEnabled(kind === "asteroid" || kind === "prop");
    this.outline(mesh);
    this.ctx.show(this.arenaContextView(kind, index));
  }

  private selectSocket(index: number, mesh: AbstractMesh): void {
    this.attachSocket(index, mesh);
    this.renderTools();
    this.options.onReveal?.(`sockets.${index}`);
  }

  private attachSocket(index: number, mesh: AbstractMesh): void {
    this.shipSelection = { index, node: mesh };
    this.arenaSelection = null;
    this.gizmos.attachToNode(mesh);
    this.setScaleGizmoEnabled(true);
    this.outline(mesh);
    const ship = this.ship();
    if (ship) this.ctx.show(this.socketContextView(ship, index));
  }

  /** Uniform scale only: both placements and sockets store ONE scale number. */
  private setScaleGizmoEnabled(enabled: boolean): void {
    const scale = this.gizmos.gizmos.scaleGizmo;
    if (!scale) return;
    scale.uniformScaleGizmo.isEnabled = enabled;
    scale.xGizmo.isEnabled = false;
    scale.yGizmo.isEnabled = false;
    scale.zGizmo.isEnabled = false;
  }

  /** Outline the picked marker so the selection reads in the 3D view, not just the panel. */
  private outline(selected: AbstractMesh): void {
    for (const mesh of this.scene.meshes) {
      const tag = mesh.metadata as EditorMarkerTag | null;
      if (!tag || (tag.editorKind === undefined && tag.socketIndex === undefined)) continue;
      const outlined = mesh as AbstractMesh & { renderOutline?: boolean; outlineColor?: Color3; outlineWidth?: number };
      outlined.renderOutline = mesh === selected;
      if (mesh === selected) { outlined.outlineColor = new Color3(0.34, 0.85, 1); outlined.outlineWidth = 0.06; }
    }
  }

  private clearSelection(): void {
    this.arenaSelection = null;
    this.shipSelection = null;
    this.gizmos.attachToMesh(null);
    for (const mesh of this.scene.meshes) {
      const outlined = mesh as AbstractMesh & { renderOutline?: boolean };
      if (outlined.renderOutline) outlined.renderOutline = false;
    }
    this.ctx.hide();
    this.renderTools();
  }

  private frameSelection(): void {
    const node = this.arenaSelection?.node ?? this.shipSelection?.node;
    if (!node) return;
    const camera = this.scene.activeCamera as unknown as { setTarget?: (value: Vector3) => void; radius?: number } | null;
    camera?.setTarget?.(node.getAbsolutePosition());
    if (camera && typeof camera.radius === "number") {
      const radius = node instanceof AbstractMesh ? node.getBoundingInfo().boundingSphere.radiusWorld : 4;
      camera.radius = Math.max(this.subject?.type === "ship" ? 4 : 12, radius * 5);
    }
  }

  // ------------------------------------------------------------- commits ----

  /** Clone → mutate → `DraftPackStore.setFile`. The one write path in this file. */
  private commit(mutate: (config: AnyConfig) => void): void {
    const subject = this.subject;
    if (!subject) return;
    const next = structuredClone(subject.config);
    mutate(next);
    this.applyDraft(next);
  }

  private applyDraft(next: AnyConfig): void {
    const subject = this.subject;
    if (!subject) return;
    this.options.draft().setFile(subject.path, next);
    this.subject = { ...subject, config: next };
    if (subject.type === "arena") this.stageHostArena(next as ArenaConfig);
    this.propSweep.version++;
    // The form column is a second view of the same draft entity: refresh it,
    // then rebuild the markers and re-bind the handles.
    this.options.onDraftEdit();
    void this.options.viewport.restage(next).then(() => this.afterStage());
  }

  /** A gizmo drag ended: write the node's pose back into the draft. */
  private commitFromGizmo(): void {
    if (this.subject?.type === "ship") { this.commitSocketFromGizmo(); return; }
    this.commitPlacementFromGizmo();
  }

  private commitPlacementFromGizmo(): void {
    const selection = this.arenaSelection;
    const arena = this.arena();
    if (!selection || !arena) return;
    const { kind, index, node } = selection;
    const position = snapPosition(node.position, this.translateSnap);
    const scale = uniformScaleOf(node.scaling.x, node.scaling.y, node.scaling.z);
    node.scaling.setAll(scale);
    this.commitArena((draft) => {
      const list = listFor(draft, kind);
      const placement = list?.[index];
      if (!placement) return;
      placement.position = round3(position);
      if (kind === "asteroid") {
        placement.rotation = roundPlacementValue(snapRotation(node.rotation.y, this.rotateSnap));
        placement.scale = roundPlacementValue(scale);
      } else if (kind === "prop") {
        placement.rotation = {
          x: roundPlacementValue(snapRotation(node.rotation.x, this.rotateSnap)),
          y: roundPlacementValue(snapRotation(node.rotation.y, this.rotateSnap)),
          z: roundPlacementValue(snapRotation(node.rotation.z, this.rotateSnap)),
        };
        placement.scale = roundPlacementValue(scale);
      } else if (kind === "spawn") {
        placement.heading = roundPlacementValue(snapRotation(node.rotation.y, this.rotateSnap));
      }
    });
  }

  private commitSocketFromGizmo(): void {
    const selection = this.shipSelection;
    const ship = this.ship();
    if (!selection || !ship) return;
    const { node, index } = selection;
    const scale = roundMarkerValue(node.scaling.x);
    node.scaling.setAll(scale);
    this.applyDraft(setSocketTransform(ship, index, {
      pos: [roundMarkerValue(node.position.x), roundMarkerValue(node.position.y), roundMarkerValue(node.position.z)],
      rot: [roundMarkerValue(node.rotation.x), roundMarkerValue(node.rotation.y), roundMarkerValue(node.rotation.z)],
      scale,
    }));
  }

  /** Arena commit with mirror maintenance — the twin follows every edit. */
  private commitArena(mutate: (arena: ArenaConfig) => void): void {
    const selection = this.arenaSelection;
    this.commit((config) => {
      const arena = config as ArenaConfig;
      mutate(arena);
      if (this.mirror && selection) this.maintainTwin(arena, selection.kind, selection.index);
    });
  }

  private maintainTwin(arena: ArenaConfig, kind: PlacementKind, index: number): void {
    const twinIndex = this.pairs[kind].get(index);
    const list = listFor(arena, kind);
    if (twinIndex === undefined || !list?.[index]) return;
    list[twinIndex] = twinOf(kind, list[index], arena);
  }

  // ------------------------------------------------------------- placing ----

  private place(point: Vector3): void {
    const arena = this.arena();
    if (!arena || !this.armed) return;
    const armed = this.armed;
    const position = round3(snapPosition(point, this.translateSnap));
    this.commit((config) => {
      const draft = config as ArenaConfig;
      let kind: PlacementKind;
      let index: number;
      if (armed === "nav") {
        kind = "nav";
        index = appendPlacement(draft, "nav", { id: nextNodeId(draft), position });
      } else if (armed.kind === "prop") {
        kind = "prop";
        const terrain = this.isTerrainProp(armed.id);
        index = appendPlacement(draft, "prop", { propId: armed.id, position, rotation: { x: 0, y: 0, z: 0 }, scale: 1, ...(terrain ? { locked: true } : {}) });
      } else {
        kind = "asteroid";
        index = appendPlacement(draft, "asteroid", { asteroidId: armed.id, position, rotation: 0, scale: 1 });
      }
      if (index >= 0) this.createTwin(draft, kind, index);
    });
  }

  private createTwin(arena: ArenaConfig, kind: PlacementKind, index: number): void {
    if (!this.mirror) return;
    const list = listFor(arena, kind);
    const source = list?.[index];
    if (!list || !source) return;
    const twinIndex = list.push(twinOf(kind, source, arena)) - 1;
    this.pairs[kind].set(index, twinIndex);
    this.pairs[kind].set(twinIndex, index);
  }

  private duplicateSelection(): void {
    if (this.subject?.type === "ship") {
      const ship = this.ship();
      if (!ship || !this.shipSelection) return;
      this.applyDraft(duplicateSocket(ship, this.shipSelection.index));
      return;
    }
    const selection = this.arenaSelection;
    const arena = this.arena();
    if (!selection || !arena) return;
    const { kind, index } = selection;
    this.commit((config) => {
      const draft = config as ArenaConfig;
      const source = listFor(draft, kind)?.[index];
      if (!source) return;
      const copy = structuredClone(source);
      copy.position = { ...copy.position, x: copy.position.x + 2 };
      if (kind === "nav") copy.id = nextNodeId(draft);
      if (kind === "spawn") copy.id = nextPlacementId(draft.spawnPoints, "spawn");
      if (kind === "flag") copy.id = nextPlacementId(draft.flagBases ?? [], "flag");
      const next = appendPlacement(draft, kind, copy);
      if (next >= 0) this.createTwin(draft, kind, next);
    });
  }

  private deleteSelection(): void {
    if (this.subject?.type === "ship") {
      const ship = this.ship();
      if (!ship || !this.shipSelection) return;
      const index = this.shipSelection.index;
      if (!canDeleteSocket(ship, index)) {
        this.options.onReport?.("A ship needs at least one hardpoint — this socket cannot be deleted.");
        return;
      }
      this.clearSelection();
      this.applyDraft(deleteSocket(ship, index));
      return;
    }
    const selection = this.arenaSelection;
    const arena = this.arena();
    if (!selection || !arena) return;
    const { kind, index } = selection;
    const twin = this.mirror ? this.pairs[kind].get(index) : undefined;
    const removed = [index, ...(twin === undefined ? [] : [twin])];
    // Spawns are the one list the schema requires to stay non-empty.
    if (kind === "spawn" && arena.spawnPoints.length - removed.length < 1) {
      this.options.onReport?.("An arena needs at least one spawn point.");
      return;
    }
    this.pairs[kind] = reindexPairs(this.pairs[kind], removed);
    this.navSelection = [];
    this.clearSelection();
    this.commit((config) => removePlacements(config as ArenaConfig, kind, removed));
  }

  private commitNavLink(): void {
    const selection = [...this.navSelection];
    this.commit((config) => toggleNavLink(config as ArenaConfig, selection, this.pairs.nav, this.mirror));
  }

  // ----------------------------------------------------------- game view ----

  /**
   * "Game view": every piece of authoring furniture off — markers, rings, nav
   * lines, gizmos, forced spawn markers — while the free editor camera stays.
   * Toggling back restores the furniture AND the selection.
   */
  private toggleGameView(): void {
    this.gameView = !this.gameView;
    this.options.viewport.setFurnitureVisible(!this.gameView);
    this.options.host.setSpawnMarkersForced(!this.gameView);
    this.propSweep.version++;
    if (this.gameView) { this.gizmos.attachToMesh(null); this.ctx.hide(); }
    else if (this.arenaSelection) this.attachArena(this.arenaSelection.kind, this.arenaSelection.index, this.arenaSelection.mesh);
    this.renderTools();
  }

  private applySnap(): void {
    const position = this.gizmos.gizmos.positionGizmo;
    if (position) for (const gizmo of [position.xGizmo, position.yGizmo, position.zGizmo]) gizmo.snapDistance = this.translateSnap ? TRANSLATE_SNAP : 0;
    const rotation = this.gizmos.gizmos.rotationGizmo;
    if (rotation) for (const gizmo of [rotation.xGizmo, rotation.yGizmo, rotation.zGizmo]) gizmo.snapDistance = this.rotateSnap ? ROTATE_SNAP : 0;
  }

  // -------------------------------------------------------- context views ---

  /** Everything about one arena placement, as the shared card describes it. */
  private arenaContextView(kind: PlacementKind, index: number): CtxView {
    const arena = this.arena();
    const placement = arena ? listFor(arena, kind)?.[index] : undefined;
    const title = `${kind[0]!.toUpperCase()}${kind.slice(1)} #${index}`;
    if (!arena || !placement) return { title, fields: [], actions: [] };
    const fields: CtxField[] = [];

    if (kind === "asteroid") {
      fields.push({
        kind: "select", label: "asteroid", value: placement.asteroidId ?? "",
        options: this.all<AsteroidConfig>("asteroid").map((config) => ({ value: config.id, label: config.name ?? config.id })),
        onCommit: (id) => this.commitArena((draft) => { draft.asteroidPlacements[index]!.asteroidId = id; }),
      });
    } else if (kind === "prop") {
      fields.push({
        kind: "select", label: "prop", value: placement.propId ?? "",
        options: this.all<PropConfig>("prop").map((config) => ({ value: config.id, label: `${config.name ?? config.id} · ${config.category}` })),
        onCommit: (id) => this.commitArena((draft) => { draft.propPlacements![index]!.propId = id; }),
      });
      fields.push({
        kind: "toggle", label: "locked (terrain layer)", value: placement.locked ?? false,
        onCommit: (locked) => this.commitArena((draft) => { draft.propPlacements![index]!.locked = locked || undefined; }),
      });
    }

    this.pushTransformFields(fields, kind, index, placement);

    if (kind === "spawn") {
      fields.push({ kind: "number", label: "team", value: placement.team ?? 0, step: 1, min: 0, onCommit: (team) => this.commitArena((draft) => { draft.spawnPoints[index]!.team = Math.max(0, Math.round(team)); }) });
      fields.push({ kind: "number", label: "heading (rad)", key: "ry", value: placement.heading ?? 0, onCommit: (heading) => this.commitArena((draft) => { draft.spawnPoints[index]!.heading = heading; }) });
    }
    if (kind === "flag") {
      fields.push({ kind: "number", label: "team", value: placement.team ?? 0, step: 1, min: 0, onCommit: (team) => this.commitArena((draft) => { draft.flagBases![index]!.team = Math.max(0, Math.round(team)); }) });
      fields.push({ kind: "number", label: "radius", value: placement.radius ?? 1, min: 0.01, onCommit: (radius) => { if (radius > 0) this.commitArena((draft) => { draft.flagBases![index]!.radius = radius; }); } });
    }
    if (kind === "nav") {
      fields.push({ kind: "toggle", label: "hub node", value: placement.hub ?? false, onCommit: (hub) => this.commitArena((draft) => { draft.navGraph!.nodes[index]!.hub = hub || undefined; }) });
      if (this.navSelection.length === 2) fields.push({ kind: "link", label: "Link / unlink the two selected nodes (L)", onClick: () => this.commitNavLink() });
    }

    fields.push({ kind: "link", label: `Open ${arrayFieldOf(kind)} ▸ form`, onClick: () => this.options.onReveal?.(`${arrayFieldOf(kind)}.${index}`) });

    return {
      title,
      subtitle: placement.id ?? placement.asteroidId ?? placement.propId ?? "",
      fields,
      actions: [
        { label: "Duplicate", onClick: () => this.duplicateSelection() },
        { label: "Frame", onClick: () => this.frameSelection() },
        { label: "Delete", onClick: () => this.deleteSelection(), danger: true },
      ],
    };
  }

  private pushTransformFields(fields: CtxField[], kind: PlacementKind, index: number, placement: EditorPlacement): void {
    const axes = ["x", "y", "z"] as const;
    for (const axis of axes) {
      fields.push({
        kind: "number", label: `pos ${axis}`, key: `p${axis}`, value: placement.position[axis] ?? 0,
        onCommit: (value) => this.commitArena((draft) => {
          const target = listFor(draft, kind)![index]!;
          target.position = { ...target.position, [axis]: value };
        }),
      });
    }
    if (kind === "asteroid") {
      fields.push({
        kind: "number", label: "rot y (rad)", key: "ry", value: typeof placement.rotation === "number" ? placement.rotation : 0,
        onCommit: (value) => this.commitArena((draft) => { draft.asteroidPlacements[index]!.rotation = value; }),
      });
    } else if (kind === "prop") {
      const rotation = typeof placement.rotation === "object" && placement.rotation !== null ? placement.rotation : {};
      for (const axis of axes) {
        fields.push({
          kind: "number", label: `rot ${axis} (rad)`, key: `r${axis}`, value: rotation[axis] ?? 0,
          onCommit: (value) => this.commitArena((draft) => {
            const target = draft.propPlacements![index]!;
            const current = typeof target.rotation === "object" && target.rotation !== null ? target.rotation : {};
            target.rotation = { ...current, [axis]: value };
          }),
        });
      }
    }
    if (kind === "asteroid" || kind === "prop") {
      fields.push({
        kind: "number", label: "scale", key: "scale", value: placement.scale ?? 1, min: 0.01,
        onCommit: (value) => { if (value > 0) this.commitArena((draft) => { listFor(draft, kind)![index]!.scale = value; }); },
      });
    }
  }

  /**
   * One ship socket. The heavy editors (accepts lists, emitter bindings, curves)
   * are generated by the schema form, so the card summarises them and deep-links
   * rather than owning a second hand-written copy.
   */
  private socketContextView(ship: ShipConfig, index: number): CtxView {
    const socket = ship.sockets[index];
    if (!socket) return { title: `Socket #${index}`, fields: [], actions: [] };
    const pos = socket.transform.pos;
    const rot = socket.transform.rot ?? [0, 0, 0];
    const axes = ["x", "y", "z"] as const;
    const patch = (next: Partial<{ pos: [number, number, number]; rot: [number, number, number]; scale: number }>): void => {
      this.applyDraft(setSocketTransform(ship, index, {
        pos: [...pos] as [number, number, number],
        rot: [...rot] as [number, number, number],
        scale: socket.transform.scale ?? 1,
        ...next,
      }));
    };
    const fields: CtxField[] = [
      { kind: "static", label: "kind", value: socket.kind },
      ...axes.map((axis, i): CtxField => ({
        kind: "number", label: `pos ${axis}`, key: `p${axis}`, value: pos[i] ?? 0,
        onCommit: (value) => { const next = [...pos] as [number, number, number]; next[i] = value; patch({ pos: next }); },
      })),
      ...axes.map((axis, i): CtxField => ({
        kind: "number", label: `rot ${axis} (rad)`, key: `r${axis}`, value: rot[i] ?? 0,
        onCommit: (value) => { const next = [...rot] as [number, number, number]; next[i] = value; patch({ rot: next }); },
      })),
      { kind: "number", label: "scale", key: "scale", value: socket.transform.scale ?? 1, min: 0.01, onCommit: (value) => { if (value > 0) patch({ scale: value }); } },
    ];
    if (socket.kind === "hardpoint" || socket.kind === "internal") {
      fields.push({ kind: "static", label: "accepts", value: socket.accepts.join(", ") });
      fields.push({ kind: "static", label: "fitted slot", value: `#${fittedSlotIndexOf(ship, index)}` });
    } else {
      fields.push({ kind: "static", label: "effect", value: socket.effect });
      fields.push({ kind: "static", label: "bindings", value: String(socket.bindings.length) });
    }
    fields.push({ kind: "link", label: "Accepts, bindings & curves ▸ form", onClick: () => this.options.onReveal?.(`sockets.${index}`) });

    return {
      title: socketLabel(ship, index),
      subtitle: ship.id,
      fields,
      actions: [
        { label: "Duplicate", onClick: () => this.duplicateSelection() },
        { label: "Frame", onClick: () => this.frameSelection() },
        { label: "Delete", onClick: () => this.deleteSelection(), danger: true },
      ],
    };
  }

  // ------------------------------------------------------------- tool rail ---

  /**
   * The tool rail lives at the top of the form column rather than floating over
   * the scene: the viewport cell is only a quarter of a phone screen, and the
   * context panel already owns it. Folded by default per Constellation's list
   * conventions — except the arena's Layers group, which is the control a map
   * session reaches for first.
   */
  private renderTools(): void {
    this.element.replaceChildren();
    if (!this.subject) return;
    if (this.subject.type === "ship") {
      this.element.append(this.hint("Click a socket marker in the viewport to select it. Drag the gizmo to move, rotate or scale; the drag commits to the draft when you let go. F frames · Ctrl+D duplicates · Delete removes."));
      return;
    }
    this.element.append(this.layersGroup(), this.placeGroup(), this.transformGroup(), this.viewGroup());
  }

  private layersGroup(): HTMLElement {
    const box = accordion(this.accordions, { key: "layers", title: "Layers", defaultOpen: true, className: "ed-vptools-group" });
    for (const [layer, title] of LAYERS) {
      const state = this.layers.get(layer)!;
      const row = document.createElement("div");
      row.className = "ed-layer-row";
      row.dataset.layer = layer;
      const label = document.createElement("span");
      label.className = "ed-label";
      label.textContent = title;
      row.append(
        label,
        this.check("Eye", state.visible, (value) => {
          state.visible = value;
          this.propSweep.version++;
          if (!value && this.arenaSelection && !this.canSelect(this.arenaSelection.kind, this.arenaSelection.index)) this.clearSelection();
          void this.options.viewport.restage().then(() => this.afterStage());
        }, "visible"),
        this.check("Lock", state.locked, (value) => {
          state.locked = value;
          this.propSweep.version++;
          if (value && this.arenaSelection && !this.canSelect(this.arenaSelection.kind, this.arenaSelection.index)) this.clearSelection();
          void this.options.viewport.restage().then(() => this.afterStage());
        }, "locked"),
      );
      box.append(row);
    }
    return box;
  }

  private placeGroup(): HTMLElement {
    const box = accordion(this.accordions, { key: "place", title: "Place", className: "ed-vptools-group" });
    const arm = (choice: Armed, label: string): HTMLButtonElement => {
      const button = this.button(label, () => { this.armed = sameArmed(this.armed, choice) ? null : choice; this.renderTools(); });
      button.classList.toggle("is-active", sameArmed(this.armed, choice));
      return button;
    };
    for (const prop of this.all<PropConfig>("prop")) box.append(arm({ kind: "prop", id: prop.id }, `${prop.name ?? prop.id} · ${prop.category}`));
    for (const asteroid of this.all<AsteroidConfig>("asteroid")) box.append(arm({ kind: "asteroid", id: asteroid.id }, `${asteroid.name ?? asteroid.id} · asteroid`));
    box.append(arm("nav", "Nav node"));
    box.append(this.hint("Arm an asset, then click the ground (or an existing prop) in the viewport to drop it. Click the armed button again to disarm."));
    return box;
  }

  private transformGroup(): HTMLElement {
    const box = accordion(this.accordions, { key: "transform", title: "Transforms", className: "ed-vptools-group" });
    box.append(
      this.check("Mirror mode", this.mirror, (value) => { this.mirror = value; }, "mirror"),
      this.check("Translate snap 1u", this.translateSnap, (value) => { this.translateSnap = value; this.applySnap(); }, "translate-snap"),
      this.check("Rotate snap 15°", this.rotateSnap, (value) => { this.rotateSnap = value; this.applySnap(); }, "rotate-snap"),
      this.hint("Ctrl+D duplicate · Delete remove · F frame · G game view · select two nav nodes then L to link."),
    );
    return box;
  }

  private viewGroup(): HTMLElement {
    const box = document.createElement("div");
    box.className = "ed-vptools-bar";
    const game = this.button(this.gameView ? "Leave game view (G)" : "Game view (G)", () => this.toggleGameView());
    game.dataset.action = "game-view";
    game.classList.toggle("is-active", this.gameView);
    const deselect = this.button("Deselect", () => this.clearSelection());
    deselect.disabled = !this.arenaSelection && !this.shipSelection;
    box.append(game, deselect);
    return box;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-btn ed-btn--sm";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private check(label: string, checked: boolean, onChange: (value: boolean) => void, name?: string): HTMLLabelElement {
    const wrap = document.createElement("label");
    wrap.className = "ed-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    if (name) input.dataset.check = name;
    input.addEventListener("change", () => onChange(input.checked));
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  private hint(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "ed-vptools-hint";
    p.textContent = text;
    return p;
  }
}

/** Which draft field an arena placement kind lives in — the deep-link target. */
export function arrayFieldOf(kind: PlacementKind): string {
  if (kind === "asteroid") return "asteroidPlacements";
  if (kind === "prop") return "propPlacements";
  if (kind === "spawn") return "spawnPoints";
  if (kind === "flag") return "flagBases";
  return "navGraph.nodes";
}

/** Only arenas and ships have viewport-editable geometry. */
export function editableTypeOf(config: AnyConfig): EditableType | null {
  if (config.type === "arena") return "arena";
  if (config.type === "ship") return "ship";
  return null;
}

function sameArmed(current: Armed, candidate: Armed): boolean {
  if (current === null || candidate === null) return current === candidate;
  if (current === "nav" || candidate === "nav") return current === candidate;
  return current.kind === candidate.kind && current.id === candidate.id;
}

function round3(position: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: roundPlacementValue(position.x), y: roundPlacementValue(position.y), z: roundPlacementValue(position.z) };
}
