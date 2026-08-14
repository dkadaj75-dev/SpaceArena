import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";

/**
 * The MISSILE projectile master — a real piece of ordnance rather than the cone
 * that used to stand in for one: a cylindrical body, a tapered nose cone, four
 * cruciform tail fins and a flared exhaust plume at the rear.
 *
 * ## Why it is one mesh with one material
 *
 * `ViewManager` pools projectiles by instancing a master (§10 5.6: every cloned
 * projectile costs draw calls, hardware instances collapse the whole pool into
 * one batch). That only holds while the master is a SINGLE mesh with a SINGLE
 * material, so the four parts are merged (the same
 * {@link Mesh.MergeMeshes} recipe the procedural ship hulls in
 * `core/AssetRegistry` use) and the part-to-part colour difference is carried in
 * **vertex colours** instead of extra materials.
 *
 * That is not a trick for its own sake: `StandardMaterial` multiplies the vertex
 * colour into the diffuse *and* emissive sum, so a dark steel body, a warm
 * warhead nose and a white-hot exhaust all come out of one lit material, one
 * geometry and one draw call for the entire pool — which is what a mobile
 * target can afford for something 64 of can be in the air at once.
 *
 * Budget: ~110 triangles. Tessellation is deliberately low (8 around the body,
 * 6 around the plume); at the scale a missile is ever seen — roughly half a ship
 * length — the facets read as panel lines rather than as a low-poly mistake.
 *
 * ## Orientation contract
 *
 * The nose points **+Z** with the model's up at +Y, exactly like the ship
 * masters and the kinetic projectile box, and every part's transform is baked
 * into its vertices. `ViewManager.syncProjectiles` then aims the pooled node
 * down the projectile's 3D displacement (`yawForDirection` / `pitchForDirection`,
 * BUBBLE.md §C) and the missile flies nose-first with no per-node fix-up.
 *
 * The silhouette is centred on the origin (nose tip at `+MISSILE_HALF_LENGTH`,
 * tail at `-MISSILE_HALF_LENGTH`) because the pooled node is parked at the sim's
 * projectile position, which is the centre of its collider sphere. Only the
 * exhaust plume reaches past the tail — it is meant to trail behind the hull.
 */

/** Nose-tip to tail-plate distance, world units (a ship hull is ~3.2 long). */
export const MISSILE_LENGTH = 1.56;
/** Half of {@link MISSILE_LENGTH}: the mesh is centred on its own origin. */
export const MISSILE_HALF_LENGTH = MISSILE_LENGTH / 2;
/** Body diameter — narrow enough to read as ordnance next to a 1.4-radius hull. */
export const MISSILE_BODY_DIAMETER = 0.24;
/** Cruciform tail: four fins, so the silhouette reads from any roll angle. */
export const MISSILE_FIN_COUNT = 4;

/** Cold steel casing. */
const BODY_TINT = new Color3(0.56, 0.61, 0.7);
/** Warm warhead tip — the one cue that says "this end is pointed at you". */
const NOSE_TINT = new Color3(0.95, 0.44, 0.24);
/** Fins sit darker than the body so the cruciform reads against the casing. */
const FIN_TINT = new Color3(0.3, 0.34, 0.42);
/** Burning exhaust; the brightest thing on the model in any lighting. */
const EXHAUST_TINT = new Color3(1, 0.58, 0.18);

/**
 * Paint one part with a flat vertex colour. Every part is painted, including
 * ones that could inherit white: {@link Mesh.MergeMeshes} only carries a colour
 * buffer through when the parts agree about having one.
 */
function tint(mesh: Mesh, color: Color3): Mesh {
  const vertices = mesh.getTotalVertices();
  const colors = new Float32Array(vertices * 4);
  for (let i = 0; i < vertices; i++) {
    colors[i * 4] = color.r;
    colors[i * 4 + 1] = color.g;
    colors[i * 4 + 2] = color.b;
    // Opaque: `StandardMaterial` multiplies the vertex alpha into the fragment
    // alpha, so anything below 1 would quietly make the pool transparent.
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

/**
 * Build the pooled missile master. Disabled and unpickable on return, like every
 * other master in the view layer; the caller owns its lifetime and disposes both
 * the mesh and its material.
 */
export function buildMissileMaster(scene: Scene): Mesh {
  const parts: Mesh[] = [];

  // Casing: a plain tube. Its rear plate sits at the tail, its shoulder at the
  // point the nose cone takes over.
  const body = MeshBuilder.CreateCylinder(
    "missile.body",
    { diameter: MISSILE_BODY_DIAMETER, height: 1.12, tessellation: 8 },
    scene,
  );
  body.rotation.x = Math.PI / 2; // +Y (cylinder axis) → +Z (nose)
  body.position.z = -0.22;
  body.bakeCurrentTransformIntoVertices();
  parts.push(tint(body, BODY_TINT));

  // Warhead: a cone closing the casing off at the front.
  const nose = MeshBuilder.CreateCylinder(
    "missile.nose",
    { diameterTop: 0, diameterBottom: MISSILE_BODY_DIAMETER, height: 0.44, tessellation: 8 },
    scene,
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.56; // tip lands on +MISSILE_HALF_LENGTH
  nose.bakeCurrentTransformIntoVertices();
  parts.push(tint(nose, NOSE_TINT));

  // Tail fins, spun around the body axis. Each fin is rotated about +Z FIRST and
  // then pushed out along that same rotated direction, so the four of them orbit
  // the casing instead of all leaning off one side of it.
  for (let i = 0; i < MISSILE_FIN_COUNT; i++) {
    const angle = (i * 2 * Math.PI) / MISSILE_FIN_COUNT;
    const fin = MeshBuilder.CreateBox(
      `missile.fin${i}`,
      { width: 0.26, height: 0.05, depth: 0.34 },
      scene,
    );
    fin.rotation.z = angle;
    fin.position.set(Math.cos(angle) * 0.22, Math.sin(angle) * 0.22, -0.6);
    fin.bakeCurrentTransformIntoVertices();
    parts.push(tint(fin, FIN_TINT));
  }

  // Thrust: a cone flaring out of the tail plate and tapering to a point behind
  // the missile. Cheap and static — the motion read comes from the missile's own
  // speed, which is what makes a particle trail per projectile unaffordable here.
  const exhaust = MeshBuilder.CreateCylinder(
    "missile.exhaust",
    { diameterTop: 0, diameterBottom: 0.19, height: 0.34, tessellation: 6 },
    scene,
  );
  exhaust.rotation.x = -Math.PI / 2; // +Y → −Z, so the cone's point trails aft
  exhaust.position.z = -0.95; // mouth flush with the tail plate
  exhaust.bakeCurrentTransformIntoVertices();
  parts.push(tint(exhaust, EXHAUST_TINT));

  // ONE submesh, deliberately: `multiMultiMaterial` (which the procedural ship
  // hulls pass) would keep a submesh per part, and a submesh is a draw call even
  // when every one of them shares a material. A pool of 64 instances is only
  // cheap while the master draws in a single batch.
  const merged = Mesh.MergeMeshes(parts, true, true)!;
  merged.name = "master.proj.missile";
  // Vertex colours are opaque by construction; say so explicitly rather than
  // letting the mesh drift into the transparent render pass.
  merged.hasVertexAlpha = false;

  const material = new StandardMaterial("mat.proj.missile", scene);
  // White diffuse: the per-part tint above is the paint job, and leaving this
  // white is what lets one material serve casing, warhead and flame at once.
  material.diffuseColor = Color3.White();
  material.specularColor = new Color3(0.32, 0.35, 0.42);
  material.specularPower = 64;
  // A low emissive floor keeps the casing legible against a black skybox and
  // gives the arena GlowLayer a modest halo — deliberately far below the beam
  // and kinetic tracers, which are pure emissive and are meant to blow out.
  material.emissiveColor = new Color3(0.16, 0.16, 0.18);
  merged.material = material;

  merged.isPickable = false;
  merged.setEnabled(false);
  return merged;
}
