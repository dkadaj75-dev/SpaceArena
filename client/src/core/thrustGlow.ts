import {
  Color3,
  MaterialPluginBase,
  Mesh,
  MultiMaterial,
  PBRMaterial,
  RegisterClass,
  type AbstractMesh,
  type Material,
  type MaterialDefines,
  type Scene,
} from "@babylonjs/core";
import type { EmissiveGlow } from "@space-arena/shared";

/**
 * Signal-driven emissive light on a GLB hull (F10 ship tool, owner request
 * 2026-08-19): `render.emissiveGlow` names one of the model's material slots;
 * that slot emits its own albedo texture as light, scaled live per SHIP by a
 * sim signal (default `throttle`) — 10% light at signal 0 up to 100% at 1.
 *
 * Ships render as instances of one shared master (contract §5), so the scale
 * cannot live on the material: it is a per-instance float attribute
 * (`thrustGlow`) that a small PBR material plugin multiplies into
 * `finalEmissive`. Meshes that never registered the buffer (or non-instanced
 * draws) render the material's emissive unscaled. Hulls without the config are
 * never touched — GLB-authored static emissive keeps its old look.
 */

export const THRUST_GLOW_ATTRIBUTE = "thrustGlow";
/** Emissive fraction at signal 0. */
export const THRUST_GLOW_IDLE = 0.1;
/**
 * Exhaust-interior texels are typically near-black, so emitting the albedo at
 * strength 1 reads as unlit. This lifts the selected slot into a visible glow;
 * the per-instance attribute then scales the result by the signal.
 */
const THRUST_GLOW_EMISSIVE_INTENSITY = 6;

/** Map a signal value (0..1) to the emissive scale: 0 → 10%, 1 → 100%. */
export function thrustGlowLevel(signal: number | undefined): number {
  const t = Math.min(1, Math.max(0, signal ?? 0));
  return THRUST_GLOW_IDLE + (1 - THRUST_GLOW_IDLE) * t;
}

class ThrustGlowPlugin extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, "ThrustGlow", 200, { THRUSTGLOW: false });
    this._enable(true);
  }

  override getClassName(): string {
    return "ThrustGlowPlugin";
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    // Only meshes prepared via applyThrustGlowToMesh carry the instanced
    // buffer; anything else keeps the plain PBR emissive path.
    defines["THRUSTGLOW"] = hasThrustGlowBuffer(mesh);
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (hasThrustGlowBuffer(mesh)) attributes.push(THRUST_GLOW_ATTRIBUTE);
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
#ifdef THRUSTGLOW
#ifdef INSTANCES
attribute float ${THRUST_GLOW_ATTRIBUTE};
#endif
varying float vThrustGlow;
#endif
`,
        CUSTOM_VERTEX_MAIN_END: `
#ifdef THRUSTGLOW
#ifdef INSTANCES
vThrustGlow = ${THRUST_GLOW_ATTRIBUTE};
#else
vThrustGlow = 1.0;
#endif
#endif
`,
      };
    }
    if (shaderType === "fragment") {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef THRUSTGLOW
varying float vThrustGlow;
#endif
`,
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef THRUSTGLOW
finalEmissive *= vThrustGlow;
#endif
`,
      };
    }
    return null;
  }
}

// Material.clone re-instantiates attached plugins by their registered class
// name (ship paint clones wired hull materials); an unregistered plugin makes
// that clone throw.
RegisterClass("BABYLON.ThrustGlowPlugin", ThrustGlowPlugin);

function hasThrustGlowBuffer(mesh: AbstractMesh): boolean {
  // Mesh.clone can leave `instancedBuffers` null rather than undefined.
  const buffers = (mesh as Mesh).instancedBuffers as Record<string, unknown> | null | undefined;
  return buffers != null && THRUST_GLOW_ATTRIBUTE in buffers;
}

function hasPlugin(material: PBRMaterial): boolean {
  return !!material.pluginManager?.getPlugin("ThrustGlow");
}

function attachPlugin(material: PBRMaterial): void {
  if (!hasPlugin(material)) new ThrustGlowPlugin(material);
}

/** Material slots of a mesh, MultiMaterial expanded, order preserved. */
function slotsOf(material: Material | null): (Material | null)[] {
  return material instanceof MultiMaterial ? material.subMaterials : [material];
}

/** A paint clone's slot keeps the source name as a prefix (`ENGINE_GLOW.cosmetic…`). */
function slotMatches(slotName: string, configured: string): boolean {
  return slotName === configured || slotName.startsWith(`${configured}.`);
}

function registerBuffer(mesh: Mesh): void {
  if (!hasThrustGlowBuffer(mesh)) mesh.registerInstancedBuffer(THRUST_GLOW_ATTRIBUTE, 1);
  // Full-glow default: new instances copy the master's value at creation, and
  // instances that already existed (editor/hangar previews wired after the
  // fact) start as null, which Babylon renders as 0 — a dead engine.
  mesh.instancedBuffers[THRUST_GLOW_ATTRIBUTE] = 1;
  for (const instance of mesh.instances) {
    const buffers = instance.instancedBuffers as Record<string, unknown>;
    if (buffers[THRUST_GLOW_ATTRIBUTE] == null) buffers[THRUST_GLOW_ATTRIBUTE] = 1;
  }
}

/**
 * Wire (or re-wire) a mesh's configured emissive-light slot. Idempotent, and
 * safe to call again after the F10 tool edits the config: a previously wired
 * slot that no longer matches has its emissive cleared. Must run on every mesh
 * instances render through — the master AND each authored-LOD or paint clone
 * (clones share materials but not instanced-buffer storage).
 */
export function applyThrustGlowToMesh(mesh: Mesh, glow: EmissiveGlow | undefined): void {
  let wired = false;
  for (const slot of slotsOf(mesh.material)) {
    if (!(slot instanceof PBRMaterial)) continue;
    if (glow && slotMatches(slot.name, glow.material)) {
      slot.emissiveTexture = slot.albedoTexture;
      slot.emissiveColor = Color3.White();
      slot.emissiveIntensity = THRUST_GLOW_EMISSIVE_INTENSITY;
      attachPlugin(slot);
      wired = true;
    } else if (hasPlugin(slot)) {
      // Deselected in the editor: back to no emissive light. GLB-authored
      // emissive on never-wired slots is deliberately left alone.
      slot.emissiveTexture = null;
      slot.emissiveColor = Color3.Black();
      slot.emissiveIntensity = 1;
    }
  }
  if (wired) registerBuffer(mesh);
}

/**
 * Carry a source mesh's wiring onto a fresh clone whose materials were cloned
 * separately (ship paint variants): Babylon's material clone copies the
 * emissive values but not the plugin, and mesh clones never copy
 * instanced-buffer storage. Slot order is preserved by the clone, so plugins
 * mirror by index.
 */
export function mirrorThrustGlow(clone: Mesh, source: Mesh): void {
  if (!hasThrustGlowBuffer(source)) return;
  const sourceSlots = slotsOf(source.material);
  const cloneSlots = slotsOf(clone.material);
  for (let i = 0; i < Math.min(sourceSlots.length, cloneSlots.length); i++) {
    const from = sourceSlots[i];
    const to = cloneSlots[i];
    if (from instanceof PBRMaterial && to instanceof PBRMaterial && hasPlugin(from)) attachPlugin(to);
  }
  registerBuffer(clone);
}

/** Per-frame write for a live ship instance; no-op for hulls without a wired slot. */
export function setThrustGlow(instance: AbstractMesh, signal: number | undefined): void {
  if (!hasThrustGlowBuffer(instance)) return;
  ((instance as Mesh).instancedBuffers as Record<string, number>)[THRUST_GLOW_ATTRIBUTE] = thrustGlowLevel(signal);
}
