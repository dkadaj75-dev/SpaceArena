import {
  AbstractMesh, Color3, GizmoManager, Mesh, MeshBuilder, PointerEventTypes, StandardMaterial,
  TransformNode, Vector3, type Observer, type PointerInfo, type Scene,
} from "@babylonjs/core";
import { arenaSchema, propSchema, type ArenaConfig, type AsteroidConfig, type GamemodeConfig, type PropConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";
import { bindGizmoCameraSuspend } from "./EditorStage.js";
import { applicationNotice } from "./applicationScope.js";

type Layer = "asteroid" | "prop" | "spawn" | "flag" | "nav" | "bounds";
type Selection = { kind: Exclude<Layer, "bounds">; index: number; mesh: TransformNode };
type AssetChoice = { kind: "asteroid" | "prop"; id: string };
type EditorPlacement = {
  position: { x: number; y?: number; z: number };
  id?: string; team?: number; heading?: number; asteroidId?: string; propId?: string;
  rotation?: number | { y?: number; x?: number; z?: number };
  scale?: number; radius?: number; hub?: boolean; locked?: boolean;
};
type PairMap = Record<Exclude<Layer, "bounds">, Map<number, number>>;
const LAYERS: Array<[Layer, string]> = [["asteroid", "Asteroids"], ["prop", "Props"], ["spawn", "Spawns"], ["flag", "Flag bases"], ["nav", "Nav graph"], ["bounds", "Bounds"]];

/** World-space arena authoring surface. Runtime models remain owned by SceneBuilder. */
export class MapEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private root: TransformNode;
  private readonly gizmos: GizmoManager;
  private readonly unbindGizmoSuspend: () => void;
  private observer: Observer<PointerInfo> | null = null;
  private beforeRenderObserver: Observer<Scene> | null = null;
  private arenaId = "";
  private selected: Selection | null = null;
  private navSelection: number[] = [];
  private armed: AssetChoice | "nav" | null = null;
  private mirror = true;
  private translateSnap = true;
  private rotateSnap = true;
  private ceilingPreview = true;
  private unlockedProps = new Set<number>();
  private layers = new Map<Layer, { visible: boolean; locked: boolean }>(LAYERS.map(([layer]) => [layer, { visible: true, locked: false }]));
  private pairs: PairMap = { asteroid: new Map(), prop: new Map(), spawn: new Map(), flag: new Map(), nav: new Map() };

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.root = new TransformNode("editorMapPreview", host.scene);
    this.gizmos = new GizmoManager(host.scene);
    this.gizmos.usePointerToAttachGizmos = false;
    this.gizmos.positionGizmoEnabled = true;
    this.gizmos.rotationGizmoEnabled = true;
    this.gizmos.scaleGizmoEnabled = true;
    this.unbindGizmoSuspend = bindGizmoCameraSuspend(this.gizmos, (on) => host.suspendCameraGestures(on));
    this.arenaId = host.configService.getAll<ArenaConfig>("arena")[0]?.id ?? "";
    this.inferPairs();
    this.applySnap();
    this.renderUi(); this.rebuildPreview();
    this.observer = host.scene.onPointerObservable.add((info) => this.onPointer(info));
    this.beforeRenderObserver = host.scene.onBeforeRenderObservable.add(() => { if (!this.layers.get("prop")!.visible) this.applyScenePropVisibility(); });
    window.addEventListener("keydown", this.onKey);
  }

  private arena(): ArenaConfig | undefined { return this.host.configService.get<ArenaConfig>("arena", this.arenaId); }
  private onPointer(info: PointerInfo): void {
    if (info.type !== PointerEventTypes.POINTERPICK || !info.pickInfo?.hit || !info.pickInfo.pickedMesh) return;
    const mesh = info.pickInfo.pickedMesh;
    const metadata = mesh.metadata as { editorKind?: Layer; editorIndex?: number } | null;
    if (this.armed) {
      const propPick = metadata?.editorKind === "prop"
        ? info.pickInfo
        : this.host.scene.pick(this.host.scene.pointerX, this.host.scene.pointerY, (candidate) => (candidate.metadata as { editorKind?: string } | null)?.editorKind === "prop");
      const planePick = propPick?.hit
        ? null
        : this.host.scene.pick(this.host.scene.pointerX, this.host.scene.pointerY, (candidate) => candidate.name === "groundPlane");
      const point = propPick?.pickedPoint ?? planePick?.pickedPoint;
      if (point) this.place(point);
      return;
    }
    if (metadata?.editorKind && metadata.editorIndex !== undefined) {
      if (!this.canSelect(metadata.editorKind, metadata.editorIndex)) return;
      this.select(metadata.editorKind as Selection["kind"], metadata.editorIndex, mesh);
      return;
    }
  }

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === "Delete") { event.preventDefault(); this.removeSelected(); }
    else if (event.ctrlKey && event.key.toLowerCase() === "d") { event.preventDefault(); this.duplicateSelected(); }
    else if (event.key.toLowerCase() === "l" && this.navSelection.length === 2) { event.preventDefault(); this.toggleNavLink(); }
    else if (event.key.toLowerCase() === "f") { event.preventDefault(); this.frameSelection(); }
  };

  private renderUi(): void {
    this.element.replaceChildren();
    const toolbar = row("ed-toolbar");
    const select = document.createElement("select");
    for (const arena of this.host.configService.getAll<ArenaConfig>("arena")) select.append(new Option(arena.name, arena.id, false, arena.id === this.arenaId));
    select.addEventListener("change", () => { this.arenaId = select.value; this.resetSession(); });
    toolbar.append(label("Arena"), select, button("Save", () => void this.save(), "ed-btn--primary"));
    const modes = this.host.configService.getAll<GamemodeConfig>("gamemode");
    const modeSelect = document.createElement("select");
    for (const mode of modes) modeSelect.append(new Option(mode.name, mode.id));
    toolbar.append(modeSelect, button("Playtest", () => void this.playtest(modeSelect.value)));
    this.element.append(toolbar, applicationNotice("arena"));

    const layers = section("Layers");
    for (const [key, title] of LAYERS) {
      const state = this.layers.get(key)!;
      const item = row("ed-layer-row");
      item.append(label(title), toggle("Eye", state.visible, (value) => { state.visible = value; this.rebuildPreview(); }), toggle("Lock", state.locked, (value) => { state.locked = value; if (value && this.selected?.kind === key) this.clearSelection(); }));
      if (key === "prop") item.append(button("Unlock terrain", () => { const arena = this.arena(); arena?.propPlacements?.forEach((placement, index) => { const prop = this.host.configService.get<PropConfig>("prop", placement.propId); if (placement.locked || prop?.category === "terrain") this.unlockedProps.add(index); }); this.rebuildPreview(); }));
      layers.append(item);
    }
    this.element.append(layers);

    const assets = section("Asset browser");
    for (const prop of this.host.configService.getAll<PropConfig>("prop")) {
      const tris = prop.collision ? collisionTriangles(prop.collision.indices) : 0;
      assets.append(button(`${prop.name} · ${prop.category}${tris ? ` · ${tris} tris` : ""}`, () => { this.armed = { kind: "prop", id: prop.id }; this.renderUi(); }, armedIs(this.armed, "prop", prop.id) ? "is-active" : ""));
    }
    for (const asteroid of this.host.configService.getAll<AsteroidConfig>("asteroid")) assets.append(button(`${asteroid.name} · asteroid`, () => { this.armed = { kind: "asteroid", id: asteroid.id }; this.renderUi(); }));
    assets.append(button("Place nav node", () => { this.armed = "nav"; this.renderUi(); }), button("Import GLB…", () => void this.importGlb()));
    this.element.append(assets);

    const transforms = section("Transforms");
    transforms.append(toggle("Mirror mode", this.mirror, (value) => { this.mirror = value; }), toggle("Translate snap 1u", this.translateSnap, (value) => { this.translateSnap = value; this.applySnap(); }), toggle("Rotate snap 15°", this.rotateSnap, (value) => { this.rotateSnap = value; this.applySnap(); }));
    if (this.selected?.kind === "flag") {
      const flag = this.arena()?.flagBases?.[this.selected.index];
      if (flag) transforms.append(numberField("Radius", flag.radius, (radius) => this.editFlagRadius(radius)));
    }
    transforms.append(document.createTextNode(" Ctrl+D duplicate · Delete remove · F frame · select 2 nav nodes + L link"));
    this.element.append(transforms);

    const arena = this.arena();
    if (arena?.bounds.shape === "box") this.element.append(toggle("Ceiling preview", this.ceilingPreview, (value) => { this.ceilingPreview = value; this.rebuildPreview(); }));
    if (arena) {
      const form = new SchemaFormGen({ schema: arenaSchema, value: arena, configService: this.host.configService, onProblem: (p) => this.report(p ? `${arena.id} ${p.path}: ${p.message}` : null), onSaved: () => { this.host.rebuildArena(); this.rebuildPreview(); } });
      this.element.append(form.element);
    }
  }

  private rebuildPreview(): void {
    this.root.dispose(false, true);
    this.root = new TransformNode("editorMapPreview", this.host.scene);
    const arena = this.arena(); if (!arena) return;
    this.previewAsteroids(arena); this.previewProps(arena); this.previewSpawns(arena); this.previewFlags(arena); this.previewNav(arena); this.previewBounds(arena);
    this.applyScenePropVisibility();
    this.selected = null; this.gizmos.attachToMesh(null);
  }

  private previewAsteroids(arena: ArenaConfig): void {
    const state = this.layers.get("asteroid")!; if (!state.visible) return;
    arena.asteroidPlacements.forEach((p, index) => this.marker("asteroid", index, new Vector3(p.position.x, p.position.y ?? 0, p.position.z), 2.2 * (p.scale ?? 1), new Color3(.55, .44, .28), p.rotation ?? 0));
  }
  private previewProps(arena: ArenaConfig): void {
    const state = this.layers.get("prop")!; if (!state.visible) return;
    arena.propPlacements?.forEach((p, index) => {
      const prop = this.host.configService.get<PropConfig>("prop", p.propId);
      const mesh = this.marker("prop", index, new Vector3(p.position.x, p.position.y ?? 0, p.position.z), 2.5 * (p.scale ?? 1), prop?.category === "terrain" ? new Color3(.28, .34, .38) : new Color3(.28, .72, .56), p.rotation?.y ?? 0);
      mesh.isVisible = false; // real SceneBuilder prop remains visible and carries matching metadata.
    });
  }
  private previewSpawns(arena: ArenaConfig): void {
    const state = this.layers.get("spawn")!; if (!state.visible) return;
    arena.spawnPoints.forEach((p, index) => this.marker("spawn", index, new Vector3(p.position.x, p.position.y ?? .2, p.position.z), 1.5, p.team === 0 ? Color3.Blue() : Color3.Red(), p.heading));
  }
  private previewFlags(arena: ArenaConfig): void {
    const state = this.layers.get("flag")!; if (!state.visible) return;
    arena.flagBases?.forEach((flag, index) => {
      const center = new Vector3(flag.position.x, flag.position.y ?? .2, flag.position.z);
      this.marker("flag", index, center, 1, flag.team === 0 ? Color3.Blue() : Color3.Red());
      const points = Array.from({ length: 49 }, (_, i) => new Vector3(center.x + Math.cos(i / 48 * Math.PI * 2) * flag.radius, center.y, center.z + Math.sin(i / 48 * Math.PI * 2) * flag.radius));
      const ring = MeshBuilder.CreateLines(`editorFlagRing.${index}`, { points }, this.host.scene); ring.parent = this.root; ring.color = flag.team === 0 ? Color3.Blue() : Color3.Red(); ring.isPickable = false;
    });
  }
  private previewNav(arena: ArenaConfig): void {
    const state = this.layers.get("nav")!; if (!state.visible) return;
    for (const [index, node] of (arena.navGraph?.nodes ?? []).entries()) this.marker("nav", index, Vector3.FromArray([node.position.x, node.position.y ?? 0, node.position.z]), node.hub ? 1.4 : .8, new Color3(.25, .9, 1));
    for (const [a, b] of arena.navGraph?.links ?? []) {
      const na = arena.navGraph!.nodes.find((node) => node.id === a), nb = arena.navGraph!.nodes.find((node) => node.id === b); if (!na || !nb) continue;
      const line = MeshBuilder.CreateLines(`editorNavLink.${a}.${b}`, { points: [new Vector3(na.position.x, na.position.y ?? 0, na.position.z), new Vector3(nb.position.x, nb.position.y ?? 0, nb.position.z)] }, this.host.scene); line.parent = this.root; line.color = new Color3(.2, .7, 1); line.isPickable = false;
    }
  }
  private previewBounds(arena: ArenaConfig): void {
    const state = this.layers.get("bounds")!; if (!state.visible || !this.ceilingPreview || arena.bounds.shape !== "box") return;
    const mesh = MeshBuilder.CreateGround("editorCeilingPreview", { width: arena.bounds.width, height: arena.bounds.height }, this.host.scene); mesh.position.y = arena.bounds.ceilingY; mesh.parent = this.root; mesh.isPickable = false;
    const mat = material(this.host, "editorCeilingPreviewMat", new Color3(.15, .65, 1)); mat.alpha = .12; mat.backFaceCulling = false; mesh.material = mat;
  }

  private marker(kind: Selection["kind"], index: number, position: Vector3, radius: number, color: Color3, rotationY = 0): Mesh {
    const mesh = kind === "spawn" || kind === "flag" ? MeshBuilder.CreateCylinder(`editor.${kind}.${index}`, { diameter: radius * 2, height: kind === "flag" ? 4 : .3 }, this.host.scene) : MeshBuilder.CreateIcoSphere(`editor.${kind}.${index}`, { radius, subdivisions: 1 }, this.host.scene);
    mesh.position.copyFrom(position); mesh.rotation.y = rotationY; mesh.parent = this.root; mesh.metadata = { editorKind: kind, editorIndex: index }; mesh.material = material(this.host, `editorMat.${kind}.${index}`, color); mesh.isPickable = this.canSelect(kind, index); return mesh;
  }

  private canSelect(kind: Layer, index: number): boolean {
    const state = this.layers.get(kind); if (!state?.visible || state.locked) return false;
    if (kind === "prop") { const arena = this.arena(); const p = arena?.propPlacements?.[index]; const prop = p && this.host.configService.get<PropConfig>("prop", p.propId); if ((p?.locked || prop?.category === "terrain") && !this.unlockedProps.has(index)) return false; }
    return true;
  }

  private select(kind: Selection["kind"], index: number, mesh: AbstractMesh): void {
    // SceneBuilder prop meshes may be children; attach to their authored hierarchy root.
    let target: TransformNode = mesh;
    if (kind === "prop") while (target.parent instanceof TransformNode && (target.parent.metadata as { editorIndex?: number } | null)?.editorIndex === index) target = target.parent;
    this.selected = { kind, index, mesh: target };
    if (kind === "nav") { this.navSelection = [...this.navSelection.filter((value) => value !== index), index].slice(-2); }
    this.gizmos.attachToNode(target);
    const allowScale = kind === "asteroid" || kind === "prop";
    if (this.gizmos.gizmos.scaleGizmo) { const scale = this.gizmos.gizmos.scaleGizmo; scale.uniformScaleGizmo.isEnabled = allowScale; scale.xGizmo.isEnabled = false; scale.yGizmo.isEnabled = false; scale.zGizmo.isEnabled = false; }
    this.gizmos.gizmos.positionGizmo?.onDragEndObservable.addOnce(() => this.commitTransform());
    this.gizmos.gizmos.rotationGizmo?.onDragEndObservable.addOnce(() => this.commitTransform());
    this.gizmos.gizmos.scaleGizmo?.onDragEndObservable.addOnce(() => this.commitTransform());
    this.renderUi();
  }

  private commitTransform(): void {
    if (!this.selected) return;
    const arena = structuredClone(this.arena()); if (!arena) return;
    const { kind, index, mesh } = this.selected; const position = snapPosition(mesh.position, this.translateSnap);
    if (kind === "asteroid") { const p = arena.asteroidPlacements[index]!; p.position = position; p.rotation = snapRotation(mesh.rotation.y, this.rotateSnap); p.scale = uniformScale(mesh.scaling); }
    else if (kind === "prop") { const p = arena.propPlacements![index]!; p.position = position; p.rotation = { y: snapRotation(mesh.rotation.y, this.rotateSnap), x: snapRotation(mesh.rotation.x, this.rotateSnap), z: snapRotation(mesh.rotation.z, this.rotateSnap) }; p.scale = uniformScale(mesh.scaling); }
    else if (kind === "spawn") { arena.spawnPoints[index]!.position = position; arena.spawnPoints[index]!.heading = snapRotation(mesh.rotation.y, this.rotateSnap); }
    else if (kind === "flag") arena.flagBases![index]!.position = position;
    else arena.navGraph!.nodes[index]!.position = position;
    this.maintainTwin(arena, kind, index); this.replace(arena);
  }

  private place(point: Vector3): void {
    const arena = structuredClone(this.arena()); if (!arena || !this.armed) return;
    const position = snapPosition(point, this.translateSnap);
    if (this.armed === "nav") { arena.navGraph ??= { nodes: [], links: [] }; const index = arena.navGraph.nodes.push({ id: nextNodeId(arena), position }) - 1; this.createTwin(arena, "nav", index); }
    else if (this.armed.kind === "prop") { arena.propPlacements ??= []; const prop = this.host.configService.get<PropConfig>("prop", this.armed.id); const index = arena.propPlacements.push({ propId: this.armed.id, position, rotation: { y: 0, x: 0, z: 0 }, scale: 1, locked: prop?.category === "terrain" || undefined }) - 1; this.createTwin(arena, "prop", index); }
    else { const index = arena.asteroidPlacements.push({ asteroidId: this.armed.id, position, rotation: 0, scale: 1 }) - 1; this.createTwin(arena, "asteroid", index); }
    this.replace(arena);
  }

  private duplicateSelected(): void {
    const arena = structuredClone(this.arena()); if (!arena || !this.selected) return;
    const kind = this.selected.kind; const source = listFor(arena, kind)?.[this.selected.index]; if (!source) return;
    const copy = structuredClone(source); copy.position.x += 2;
    if (kind === "nav") copy.id = nextNodeId(arena);
    const index = listFor(arena, kind)!.push(copy) - 1; this.createTwin(arena, kind, index); this.replace(arena);
  }

  private removeSelected(): void {
    const arena = structuredClone(this.arena()); if (!arena || !this.selected) return;
    const { kind, index } = this.selected; const list = listFor(arena, kind); if (!list) return;
    const twin = this.mirror ? this.pairs[kind].get(index) : undefined;
    const removedNavIds: string[] = [];
    for (const target of [index, twin].filter((value): value is number => value !== undefined).sort((a, b) => b - a)) { const item = list[target] as { id?: string } | undefined; if (kind === "nav" && item?.id) removedNavIds.push(item.id); list.splice(target, 1); }
    if (kind === "nav" && arena.navGraph) arena.navGraph.links = arena.navGraph.links.filter(([a, b]) => !removedNavIds.includes(a) && !removedNavIds.includes(b));
    this.reindexPairs(kind, [index, ...(twin === undefined ? [] : [twin])]); this.clearSelection(); this.replace(arena);
  }

  private createTwin(arena: ArenaConfig, kind: Selection["kind"], index: number): void {
    if (!this.mirror) return; const list = listFor(arena, kind); const source = list?.[index]; if (!list || !source) return;
    const twin = twinOf(kind, source, arena); const twinIndex = list.push(twin) - 1; this.pairs[kind].set(index, twinIndex); this.pairs[kind].set(twinIndex, index);
  }
  private maintainTwin(arena: ArenaConfig, kind: Selection["kind"], index: number): void {
    if (!this.mirror) return; const twinIndex = this.pairs[kind].get(index); const list = listFor(arena, kind); if (twinIndex === undefined || !list?.[index]) return; list[twinIndex] = twinOf(kind, list[index], arena);
  }
  private reindexPairs(kind: Selection["kind"], removed: number[]): void {
    const old = this.pairs[kind], next = new Map<number, number>(); const sorted = [...removed].sort((a, b) => a - b);
    const shifted = (value: number) => value - sorted.filter((removedIndex) => removedIndex < value).length;
    for (const [a, b] of old) if (!removed.includes(a) && !removed.includes(b)) next.set(shifted(a), shifted(b)); this.pairs[kind] = next;
  }

  private toggleNavLink(): void {
    const arena = structuredClone(this.arena()); if (!arena?.navGraph || this.navSelection.length !== 2) return;
    const [ai, bi] = this.navSelection; const a = arena.navGraph.nodes[ai!]?.id, b = arena.navGraph.nodes[bi!]?.id; if (!a || !b) return;
    const pairs: Array<[string, string]> = [[a, b]];
    if (this.mirror) {
      const at = this.pairs.nav.get(ai!), bt = this.pairs.nav.get(bi!);
      const ta = at === undefined ? undefined : arena.navGraph.nodes[at]?.id, tb = bt === undefined ? undefined : arena.navGraph.nodes[bt]?.id;
      if (ta && tb && ta !== a && tb !== b) pairs.push([ta, tb]);
    }
    const unlink = arena.navGraph.links.some((link) => link.includes(a) && link.includes(b));
    if (unlink) arena.navGraph.links = arena.navGraph.links.filter((link) => !pairs.some(([x, y]) => link.includes(x) && link.includes(y)));
    else for (const pair of pairs) if (!arena.navGraph.links.some((link) => link.includes(pair[0]) && link.includes(pair[1]))) arena.navGraph.links.push(pair);
    this.replace(arena);
  }
  private editFlagRadius(radius: number): void { const arena = structuredClone(this.arena()); if (!arena?.flagBases || !this.selected || radius <= 0) return; arena.flagBases[this.selected.index]!.radius = radius; this.maintainTwin(arena, "flag", this.selected.index); this.replace(arena); }

  private applySnap(): void {
    const position = this.gizmos.gizmos.positionGizmo; if (position) for (const gizmo of [position.xGizmo, position.yGizmo, position.zGizmo]) gizmo.snapDistance = this.translateSnap ? 1 : 0;
    const rotation = this.gizmos.gizmos.rotationGizmo; if (rotation) for (const gizmo of [rotation.xGizmo, rotation.yGizmo, rotation.zGizmo]) gizmo.snapDistance = this.rotateSnap ? Math.PI / 12 : 0;
  }
  private frameSelection(): void { if (!this.selected) return; const camera = this.host.scene.activeCamera as unknown as { setTarget?: (value: Vector3) => void; radius?: number }; camera?.setTarget?.(this.selected.mesh.getAbsolutePosition()); if (camera && typeof camera.radius === "number") { const radius = this.selected.mesh instanceof AbstractMesh ? this.selected.mesh.getBoundingInfo().boundingSphere.radiusWorld : 4; camera.radius = Math.max(12, radius * 5); } }
  private clearSelection(): void { this.selected = null; this.gizmos.attachToMesh(null); }
  private resetSession(): void { this.clearSelection(); this.navSelection = []; this.unlockedProps.clear(); this.pairs = { asteroid: new Map(), prop: new Map(), spawn: new Map(), flag: new Map(), nav: new Map() }; this.inferPairs(); this.rebuildPreview(); this.renderUi(); }
  private inferPairs(): void {
    const arena = this.arena(); if (!arena) return;
    for (const kind of ["asteroid", "prop", "spawn", "flag", "nav"] as const) {
      const list = listFor(arena, kind) ?? []; const paired = this.pairs[kind];
      for (let index = 0; index < list.length; index++) {
        if (paired.has(index)) continue; const source = list[index]!;
        const twin = list.findIndex((candidate, other) => other !== index && !paired.has(other) && isTwinCandidate(kind, source, candidate));
        if (twin >= 0) { paired.set(index, twin); paired.set(twin, index); }
      }
    }
  }
  private applyScenePropVisibility(): void { const visible = this.layers.get("prop")!.visible; for (const mesh of this.host.scene.meshes) if ((mesh.metadata as { editorKind?: string } | null)?.editorKind === "prop" && !mesh.name.startsWith("editor.")) mesh.setEnabled(visible); }
  private replace(arena: ArenaConfig): void { const result = this.host.configService.replace(arena); if (!result.ok) { this.report(result.errors.map((error) => `${error.path}: ${error.message}`).join("; ")); return; } this.host.rebuildArena(); this.rebuildPreview(); this.renderUi(); }
  private async save(): Promise<void> { const arena = this.arena(); if (!arena) return; const parsed = arenaSchema.safeParse(arena); if (!parsed.success) { this.report(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; } const error = await saveConfig(parsed.data); this.report(error); }
  private async playtest(gamemodeId: string): Promise<void> { const arena = this.arena(); if (!arena) return; const problems = playtestArenaProblems(arena); if (problems.length) { this.report(problems.join("; ")); return; } try { await this.host.launchPlaytest(arena.id, gamemodeId); } catch (error) { this.report(error instanceof Error ? error.message : String(error)); } }

  private async importGlb(): Promise<void> {
    const input = document.createElement("input"); input.type = "file"; input.accept = ".glb,model/gltf-binary"; input.click();
    input.addEventListener("change", () => void (async () => {
      const file = input.files?.[0]; if (!file) return; const base = file.name.replace(/\.glb$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const response = await fetch(`/__editor/upload-model?path=${encodeURIComponent(`props/${base}.glb`)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const payload = await response.json() as { reason?: string; draft?: PropConfig };
      if (!payload.draft) { this.report(payload.reason ?? "Import failed"); return; }
      if (!response.ok && !confirm(`${payload.reason}. Import as decor without collision?`)) return;
      const draft = response.ok ? payload.draft : { ...payload.draft, category: "decor" as const, collision: undefined };
      this.openPropDraft(draft);
    })());
  }
  private openPropDraft(draft: PropConfig): void {
    const panel = section("Imported prop draft"); const form = new SchemaFormGen({ schema: propSchema, value: draft, configService: this.host.configService, allowPackInvalid: true, onProblem: (problem) => this.report(problem ? `${problem.path}: ${problem.message}` : null) });
    panel.append(form.element, button("Save imported prop", () => void (async () => { const value = form.getValue(); const error = await saveConfig(value); this.report(error); if (!error) this.renderUi(); })(), "ed-btn--primary")); this.element.prepend(panel);
  }

  dispose(): void { for (const mesh of this.host.scene.meshes) if ((mesh.metadata as { editorKind?: string } | null)?.editorKind === "prop") mesh.setEnabled(true); this.unbindGizmoSuspend(); if (this.observer) this.host.scene.onPointerObservable.remove(this.observer); if (this.beforeRenderObserver) this.host.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver); window.removeEventListener("keydown", this.onKey); this.gizmos.dispose(); this.root.dispose(false, true); }
}

function listFor(arena: ArenaConfig, kind: Selection["kind"]): EditorPlacement[] | undefined { if (kind === "asteroid") return arena.asteroidPlacements as EditorPlacement[]; if (kind === "prop") return arena.propPlacements as EditorPlacement[] | undefined; if (kind === "spawn") return arena.spawnPoints as EditorPlacement[]; if (kind === "flag") return arena.flagBases as EditorPlacement[] | undefined; return arena.navGraph?.nodes as EditorPlacement[] | undefined; }
function twinOf(kind: Selection["kind"], source: EditorPlacement, arena: ArenaConfig): EditorPlacement { const twin = structuredClone(source); twin.position = { ...twin.position, x: -twin.position.x, z: -twin.position.z }; if (kind === "asteroid") twin.rotation = (typeof twin.rotation === "number" ? twin.rotation : 0) + Math.PI; if (kind === "prop") { const rotation = typeof twin.rotation === "object" ? twin.rotation : {}; twin.rotation = { ...rotation, y: (rotation.y ?? 0) + Math.PI }; } if (kind === "spawn") { twin.heading = (twin.heading ?? 0) + Math.PI; twin.team = twin.team === 0 ? 1 : 0; twin.id = uniqueTwinId(arena.spawnPoints, twin.id ?? "spawn"); } if (kind === "flag") { twin.team = twin.team === 0 ? 1 : 0; twin.id = uniqueTwinId(arena.flagBases ?? [], twin.id ?? "flag"); } if (kind === "nav") twin.id = nextNodeId(arena); return twin; }
function uniqueTwinId(items: Array<{ id: string }>, id: string): string { let next = `${id}-mirror`, n = 2; while (items.some((item) => item.id === next)) next = `${id}-mirror-${n++}`; return next; }
function isTwinCandidate(kind: Selection["kind"], source: EditorPlacement, candidate: EditorPlacement): boolean { if (Math.abs(candidate.position.x + source.position.x) > .001 || Math.abs((candidate.position.y ?? 0) - (source.position.y ?? 0)) > .001 || Math.abs(candidate.position.z + source.position.z) > .001) return false; if (kind === "asteroid" && candidate.asteroidId !== source.asteroidId) return false; if (kind === "prop" && candidate.propId !== source.propId) return false; if ((kind === "spawn" || kind === "flag") && candidate.team === source.team) return false; return true; }
function nextNodeId(arena: ArenaConfig): string { const ids = new Set(arena.navGraph?.nodes.map((node) => node.id) ?? []); let n = ids.size + 1; while (ids.has(`node-${n}`)) n++; return `node-${n}`; }
function snapPosition(position: Pick<Vector3, "x" | "y" | "z">, snap: boolean): { x: number; y: number; z: number } { return { x: snap ? Math.round(position.x) : position.x, y: snap ? Math.round(position.y) : position.y, z: snap ? Math.round(position.z) : position.z }; }
function snapRotation(value: number, snap: boolean): number { const step = Math.PI / 12; return snap ? Math.round(value / step) * step : value; }
function uniformScale(scale: Vector3): number { const value = Math.max(.01, (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3); scale.setAll(value); return value; }
function collisionTriangles(base64: string): number { return Math.max(0, base64.length / 16 - (base64.endsWith("==") ? .5 : base64.endsWith("=") ? .25 : 0)); }
function label(value: string): HTMLSpanElement { const span = document.createElement("span"); span.className = "ed-label"; span.textContent = value; return span; }
function row(className = "ed-row"): HTMLDivElement { const element = document.createElement("div"); element.className = className; return element; }
function section(title: string): HTMLDivElement { const element = document.createElement("div"); element.className = "ed-map-section"; const heading = document.createElement("div"); heading.className = "ed-map-section-title"; heading.textContent = title; element.append(heading); return element; }
function button(text: string, click: () => void, extra = ""): HTMLButtonElement { const element = document.createElement("button"); element.type = "button"; element.className = `ed-btn ed-btn--sm ${extra}`; element.textContent = text; element.addEventListener("click", click); return element; }
function toggle(text: string, checked: boolean, change: (checked: boolean) => void): HTMLLabelElement { const element = document.createElement("label"); element.className = "ed-check"; const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked; input.addEventListener("change", () => change(input.checked)); element.append(input, document.createTextNode(text)); return element; }
function numberField(text: string, value: number, change: (value: number) => void): HTMLLabelElement { const element = document.createElement("label"); element.className = "ed-check"; const input = document.createElement("input"); input.type = "number"; input.className = "ed-input ed-num ed-num--sm"; input.value = String(value); input.min = ".01"; input.addEventListener("change", () => change(Number(input.value))); element.append(document.createTextNode(text), input); return element; }
function material(host: EditorHost, name: string, color: Color3): StandardMaterial { const mat = new StandardMaterial(name, host.scene); mat.emissiveColor = color; return mat; }
function armedIs(armed: AssetChoice | "nav" | null, kind: AssetChoice["kind"], id: string): boolean { return armed !== null && armed !== "nav" && armed.kind === kind && armed.id === id; }

/** Kept as a pure regression seam for legacy volumetric placement tests. */
export function authorAsteroidPosition(point: Pick<Vector3, "x" | "z">, y: number, snap: boolean, grid: number): { x: number; y: number; z: number } { return { x: snap ? Math.round(point.x / grid) * grid : point.x, y, z: snap ? Math.round(point.z / grid) * grid : point.z }; }

/** Pure helpers used by MapEditor round-trip/mirror tests. */
export const mapEditorOps = { snapPosition, snapRotation, twinOf };

/** Schema half of the playtest guard; live ConfigService storage guarantees references. */
export function playtestArenaProblems(value: unknown): string[] { const result = arenaSchema.safeParse(value); return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`); }
