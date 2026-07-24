import { Color3, GizmoManager, MeshBuilder, PointerEventTypes, StandardMaterial, TransformNode, Vector3, type AbstractMesh, type Observer, type PointerInfo } from "@babylonjs/core";
import { arenaSchema, type ArenaConfig, type AsteroidConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";

/** Lightweight, editor-owned preview because live asteroids belong to ViewManager. */
export class MapEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly root: TransformNode;
  private readonly gizmos: GizmoManager;
  private observer: Observer<PointerInfo> | null = null;
  private arenaId = "";
  private selected: { kind: "asteroid" | "spawn"; index: number; mesh: AbstractMesh } | null = null;
  private paletteId: string | null = null;
  private snap = true;
  private grid = 1;

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.root = new TransformNode("editorMapPreview", this.host.scene);
    this.gizmos = new GizmoManager(this.host.scene);
    this.gizmos.positionGizmoEnabled = true; this.gizmos.rotationGizmoEnabled = true; this.gizmos.scaleGizmoEnabled = true;
    this.arenaId = host.configService.getAll<ArenaConfig>("arena")[0]?.id ?? "";
    this.renderUi(); this.rebuildPreview();
    this.observer = this.host.scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERPICK || !info.pickInfo?.hit || !info.pickInfo.pickedMesh) return;
      const mesh = info.pickInfo.pickedMesh;
      const tagged = mesh.metadata as { kind?: "asteroid" | "spawn"; index?: number } | null;
      if (tagged?.kind !== undefined && tagged.index !== undefined) { this.select(tagged.kind, tagged.index, mesh); return; }
      if (mesh.name === "groundPlane" && this.paletteId && info.pickInfo.pickedPoint) this.place(info.pickInfo.pickedPoint);
    });
    window.addEventListener("keydown", this.onKey);
  }
  private onKey = (event: KeyboardEvent): void => { if (event.key === "Delete" && this.selected?.kind === "asteroid") this.removeSelected(); };
  private arena(): ArenaConfig | undefined { return this.host.configService.get<ArenaConfig>("arena", this.arenaId); }
  private renderUi(): void {
    this.element.replaceChildren();
    const toolbar = document.createElement("div"); toolbar.className = "ed-toolbar";
    const select = document.createElement("select");
    for (const arena of this.host.configService.getAll<ArenaConfig>("arena")) select.append(new Option(arena.name, arena.id, false, arena.id === this.arenaId));
    select.addEventListener("change", () => { this.arenaId = select.value; this.rebuildPreview(); this.renderUi(); });
    toolbar.append(label("Arena"), select);
    const save = document.createElement("button"); save.className = "ed-btn ed-btn--primary"; save.textContent = "Save to disk"; save.addEventListener("click", () => void this.save()); toolbar.append(save);
    this.element.append(toolbar);

    const palette = document.createElement("div"); palette.className = "ed-row";
    palette.append(label("Asteroid palette"));
    for (const asteroid of this.host.configService.getAll<AsteroidConfig>("asteroid")) { const button = document.createElement("button"); button.className = "ed-btn ed-btn--sm"; button.textContent = asteroid.name ?? asteroid.id ?? "Asteroid"; button.addEventListener("click", () => { this.paletteId = asteroid.id ?? null; }); palette.append(button); }
    this.element.append(palette);

    const snapRow = document.createElement("div"); snapRow.className = "ed-row";
    const snapToggle = document.createElement("span"); snapToggle.className = "ed-toggle";
    const snap = document.createElement("input"); snap.type = "checkbox"; snap.checked = this.snap; snap.addEventListener("change", () => { this.snap = snap.checked; });
    const snapTrack = document.createElement("span"); snapTrack.className = "ed-toggle-track";
    snapToggle.append(snap, snapTrack);
    const grid = document.createElement("input"); grid.type = "number"; grid.className = "ed-input ed-num ed-num--sm"; grid.value = String(this.grid); grid.min = "0.1"; grid.addEventListener("change", () => { this.grid = Math.max(.1, Number(grid.value)); });
    snapRow.append(label("Snap"), snapToggle, label("Grid"), grid);
    this.element.append(snapRow);
    const arena = this.arena(); if (arena) {
      const form = new SchemaFormGen({ schema: arenaSchema, value: arena, configService: this.host.configService, onProblem: (p) => this.report(p ? `${arena.id} ${p.path}: ${p.message}` : null), onSaved: () => { this.host.rebuildArena(); this.rebuildPreview(); } });
      this.element.append(form.element);
    }
  }
  private rebuildPreview(): void {
    for (const mesh of [...this.root.getChildMeshes()]) mesh.dispose();
    const arena = this.arena(); if (!arena) return;
    arena.asteroidPlacements.forEach((placement, index) => {
      const mesh = MeshBuilder.CreateIcoSphere(`editorAsteroid.${index}`, { radius: 2.5 * (placement.scale ?? 1), subdivisions: 2 }, this.host.scene);
      mesh.position.set(placement.position.x, 1.5, placement.position.z); mesh.rotation.y = placement.rotation ?? 0; mesh.parent = this.root; mesh.metadata = { kind: "asteroid", index }; mesh.material = material(this.host, `editorAsteroidMat${index}`, new Color3(.55, .44, .28));
    });
    arena.spawnPoints.forEach((spawn, index) => { const mesh = MeshBuilder.CreateCylinder(`editorSpawn.${index}`, { diameter: 3, height: .3 }, this.host.scene); mesh.position.set(spawn.position.x, .2, spawn.position.z); mesh.parent = this.root; mesh.metadata = { kind: "spawn", index }; mesh.material = material(this.host, `editorSpawnMat${index}`, spawn.team === 0 ? Color3.Blue() : Color3.Red()); });
  }
  private select(kind: "asteroid" | "spawn", index: number, mesh: AbstractMesh): void {
    this.selected = { kind, index, mesh }; this.gizmos.attachToMesh(mesh);
    this.gizmos.gizmos.positionGizmo?.onDragEndObservable.addOnce(() => this.commitTransform());
    this.gizmos.gizmos.rotationGizmo?.onDragEndObservable.addOnce(() => this.commitTransform());
    this.gizmos.gizmos.scaleGizmo?.onDragEndObservable.addOnce(() => this.commitTransform());
  }
  private commitTransform(): void {
    if (!this.selected) return; const arena = structuredClone(this.arena()); if (!arena) return;
    const pos = this.selected.mesh.position; const x = this.snap ? Math.round(pos.x / this.grid) * this.grid : pos.x; const z = this.snap ? Math.round(pos.z / this.grid) * this.grid : pos.z;
    if (this.selected.kind === "asteroid") { const p = arena.asteroidPlacements[this.selected.index]!; p.position = { x, z }; p.rotation = this.selected.mesh.rotation.y; p.scale = this.selected.mesh.scaling.x; }
    else arena.spawnPoints[this.selected.index]!.position = { x, z };
    this.replace(arena);
  }
  private place(point: Vector3): void { const arena = structuredClone(this.arena()); if (!arena || !this.paletteId) return; const x = this.snap ? Math.round(point.x / this.grid) * this.grid : point.x; const z = this.snap ? Math.round(point.z / this.grid) * this.grid : point.z; arena.asteroidPlacements.push({ asteroidId: this.paletteId, position: { x, z } }); this.replace(arena); }
  private removeSelected(): void { const arena = structuredClone(this.arena()); if (!arena || !this.selected) return; arena.asteroidPlacements.splice(this.selected.index, 1); this.selected = null; this.gizmos.attachToMesh(null); this.replace(arena); }
  private replace(arena: ArenaConfig): void { const result = this.host.configService.replace(arena); if (!result.ok) { this.report(result.errors.map((e) => e.message).join("; ")); return; } this.host.rebuildArena(); this.rebuildPreview(); this.renderUi(); }
  private async save(): Promise<void> { const arena = this.arena(); if (!arena) return; const error = await saveConfig(arena); if (error) this.report(error); }
  dispose(): void { this.host.scene.onPointerObservable.remove(this.observer); window.removeEventListener("keydown", this.onKey); this.gizmos.dispose(); this.root.dispose(false, true); }
}
/** Small uppercase caption used by the toolbar rows. */
function label(value: string): HTMLSpanElement { const span = document.createElement("span"); span.className = "ed-label"; span.textContent = value; return span; }
function material(host: EditorHost, name: string, color: Color3): StandardMaterial { const mat = new StandardMaterial(name, host.scene); mat.emissiveColor = color; return mat; }
