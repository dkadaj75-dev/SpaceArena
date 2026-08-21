import {
  Color3,
  Constants,
  Effect,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Vector3,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";

/**
 * THE STAR — one billboard, two homes.
 *
 * This is the main menu's sun (`theme.scene.starfield.star`), lifted out of
 * `MenuDiorama` so an ARENA can hang the same body in its sky
 * (`arena.render.star`, owner request 2026-08-21: Parker Point wants "the sun,
 * the same as in the main menu"). Both callers share one shader, one blend
 * mode and one disc/quad ratio, so the star cannot drift between the screen a
 * player launches from and the arena they launch into.
 *
 * Nothing here knows about menus or arenas — it takes a direction, an apparent
 * size and three colours, and returns the mesh plus the material whose `time`
 * uniform the caller drives.
 */

const STAR_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

/**
 * A granulated photosphere with limb darkening, a chromosphere rim and a corona
 * of filaments. It writes ALPHA so the galaxy shows through its corona rather
 * than being punched out by a black quad, and works in the quad's own UVs so
 * the geometry can be a camera-facing plane.
 *
 * The corona is sampled along a unit DIRECTION vector rather than an angle,
 * because atan() has a branch cut at ±pi and sampling noise across it draws a
 * seam straight through the corona.
 */
const STAR_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform float time;
uniform vec3 coreColor;
uniform vec3 shellColor;
uniform vec3 coronaColor;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  // The quad spans the disc AND its corona, so the disc itself is a fraction
  // of it — see STAR_DISC_FRACTION, which must match this number.
  vec2 d = (vUv - 0.5) * 2.0;
  float dist = max(length(d), 1e-4);
  float r = dist / 0.34;
  vec2 nd = d / dist;
  float cr = max(r - 1.0, 0.0);

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  float core = smoothstep(1.06, 0.92, r);
  if (core > 0.0) {
    vec2 sp = d * 9.0;
    vec2 w = vec2(fbm(sp + time * 0.05), fbm(sp + vec2(3.1, 1.7) - time * 0.04));
    float g = fbm(sp * 2.1 + w * 2.6 + vec2(0.0, time * 0.07));
    float limb = pow(max(1.0 - r * r, 0.0), 0.36);
    // Three stops, and the DEEPEST one has to be genuinely dark: the granulation
    // is only visible as the contrast between the cool lanes and the hot cells.
    // Deriving it as a fraction of the shell colour washed it out to a flat disc.
    vec3 deep = shellColor * vec3(0.62, 0.28, 0.10);
    vec3 surf = mix(deep, shellColor, smoothstep(0.28, 0.60, g));
    surf = mix(surf, coreColor, smoothstep(0.56, 0.88, g) * limb);
    col += surf * (0.26 + limb * 1.95) * core;
    alpha = max(alpha, core);
  }

  // NO explicit chromosphere ring. A gaussian centred on the limb is a circle
  // by construction, and against this disc it reads as a drawn outline rather
  // than as a glowing edge — the corona and the glare below already carry the
  // limb, because both are brightest exactly where the disc ends.

  // Corona filaments, streaming outward and churning.
  float fil = fbm(nd * 7.0 + vec2(cr * 1.3 - time * 0.15, time * 0.05));
  fil = pow(max(fil - 0.33, 0.0) * 1.9, 1.5);
  float coronaFall = exp(-cr * 1.7);
  col += coronaColor * fil * coronaFall * 2.2;
  alpha = max(alpha, fil * coronaFall);

  // Glare: two smooth exponentials. Mixing an inverse-square halo with an
  // exponential corona falloff puts a dark ring at their crossover.
  float glare = exp(-cr * 1.15) * 0.42 + exp(-cr * 0.30) * 0.055;
  col += coronaColor * glare;
  alpha = max(alpha, glare * 1.6);

  if (alpha <= 0.002) discard;
  // Tone-map before output. Without it everything above 1.0 clips to flat
  // yellow-white and the granulation, the limb and the colour all disappear —
  // which is exactly what a raw additive star looks like.
  col = col / (1.0 + col * 0.58);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * The disc's share of the billboard's width, matching `0.34` in the shader
 * above. The quad has to be this much larger than the star so the corona and
 * the glare have somewhere to go.
 */
export const STAR_DISC_FRACTION = 0.34;

/** Shader-store names. Kept as `menuStar*` so nothing about the menu changes. */
const STAR_SHADER = "menuStar";

let starShadersRegistered = false;

/** Idempotent shader registration; safe to call from either consumer. */
export function registerStarShaders(): void {
  if (starShadersRegistered) return;
  Effect.ShadersStore[`${STAR_SHADER}VertexShader`] = STAR_VERTEX;
  Effect.ShadersStore[`${STAR_SHADER}FragmentShader`] = STAR_FRAGMENT;
  starShadersRegistered = true;
}

export interface StarBillboardOptions {
  /** Mesh/material name prefix, so menu and arena stars stay distinguishable. */
  name: string;
  /** Unit direction from the viewer TOWARD the star. */
  direction: Vector3;
  /**
   * Angular size as the fraction of `distance` the DISC spans — the same
   * `apparentSize` number the menu theme authors. The quad is scaled up by the
   * shader's corona allowance on top of it.
   */
  apparentSize: number;
  /** How far out to park the billboard. */
  distance: number;
  core: Color3;
  shell: Color3;
  corona: Color3;
  parent?: TransformNode | null;
  /**
   * Pin the billboard to the CAMERA, like the skybox, so it neither parallaxes
   * nor changes apparent size as the viewer moves — which is what a body
   * millions of km away does. An arena wants this (a ship crossing a 126-unit
   * bubble would otherwise watch the sun swell by 60% on the approach); the
   * menu diorama, whose camera does not travel, deliberately does not.
   */
  infiniteDistance?: boolean;
}

export interface StarBillboard {
  mesh: Mesh;
  /** Drive its `time` uniform to animate the granulation and corona. */
  material: ShaderMaterial;
}

/**
 * Build the star. Far enough that nothing can intersect it, sized to subtend
 * the authored apparent diameter, billboarded so the disc stays circular
 * whatever the camera does.
 */
export function createStarBillboard(scene: Scene, opts: StarBillboardOptions): StarBillboard {
  registerStarShaders();

  const discSpan = opts.distance * opts.apparentSize;
  const quadSpan = discSpan / (STAR_DISC_FRACTION * 2);

  const mesh = MeshBuilder.CreatePlane(`${opts.name}.star`, { size: quadSpan }, scene);
  if (opts.parent) mesh.parent = opts.parent;
  mesh.isPickable = false;
  mesh.applyFog = false;
  mesh.position = opts.direction.normalizeToNew().scale(opts.distance);
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.renderingGroupId = 0;
  // Rides the camera when asked, so `position` reads as a fixed OFFSET from the
  // viewer rather than a fixed point in the arena. It still draws over the
  // panorama without any sort hint: the skybox is opaque and this is
  // alpha-blended, and Babylon draws every opaque mesh before any transparent one.
  mesh.infiniteDistance = opts.infiniteDistance ?? false;

  const material = new ShaderMaterial(
    `${opts.name}.starMat`,
    scene,
    { vertex: STAR_SHADER, fragment: STAR_SHADER },
    {
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "time", "coreColor", "shellColor", "coronaColor"],
      needAlphaBlending: true,
    },
  );
  material.setColor3("coreColor", opts.core);
  material.setColor3("shellColor", opts.shell);
  material.setColor3("coronaColor", opts.corona);
  material.backFaceCulling = false;
  // Depth-write off: it is a transparent billboard, and writing depth would
  // punch its own corona out of anything drawn after it.
  material.disableDepthWrite = true;
  // PREMULTIPLIED, not additive (owner 2026-08-21: "we should not see the
  // skybox behind the sun itself").
  //
  //   result = src + dst * (1 - srcAlpha)
  //
  // The photosphere writes alpha 1, so it REPLACES the galaxy — a star is an
  // opaque body, and seeing stars through it read as a decal. The corona and
  // the glare write alpha near 0 with real colour, so they still ADD over the
  // galaxy exactly as before. One blend mode, both behaviours, one draw.
  material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
  mesh.material = material;

  return { mesh, material };
}

/** Azimuth/elevation in degrees → a unit direction in Babylon's Y-up world. */
export function starDirection(azimuthDeg: number, elevationDeg: number): Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}
