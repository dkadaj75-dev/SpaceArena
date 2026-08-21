import {
  Color3,
  Color4,
  Constants,
  DirectionalLight,
  Effect,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  CubeTexture,
  RawCubeTexture,
  ShaderMaterial,
  StandardMaterial,
  TargetCamera,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  type BaseTexture,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import type { ConfigService, PropConfig, ShipConfig, ThemeConfig } from "@space-arena/shared";
import type { AssetRegistry } from "../../core/AssetRegistry.js";
import { ShipPaintBank } from "../shipPaint.js";

/**
 * The main menu's backdrop: the player's main hull parked on lunar regolith,
 * with Earth low over the horizon.
 *
 * Everything the scene is MADE of is authored (`theme.menu.diorama`) — texture
 * paths, where Earth sits, how big it looks, where the sun is. This file only
 * knows how to assemble those into Babylon objects, which is what lets the
 * Theme tool move the earthrise without a rebuild.
 *
 * It owns a camera of its own and restores the previous one on dispose, so the
 * menu can frame its diorama without disturbing whatever the match left behind.
 */

/** Content-relative asset path → the URL the dev server and the build both serve. */
function contentUrl(path: string): string {
  return `${import.meta.env.BASE_URL}content/${path}`;
}

type MenuScene = NonNullable<NonNullable<ThemeConfig["menu"]>["scene"]>;
type Earthrise = NonNullable<MenuScene["earthrise"]>;
type Starfield = NonNullable<MenuScene["starfield"]>;

const DEFAULT_RADIUS = 320;
const DEFAULT_TILING = 42;

/**
 * Earth is drawn by a custom shader rather than a PBR material because three of
 * the things that make a planet read as a planet are not PBR features:
 *
 *  - the TERMINATOR. A PBR material lit by a directional light gives a hard
 *    day/night edge; a real one is a soft band tens of kilometres wide, and the
 *    softness is most of what sells the scale.
 *  - CITY LIGHTS, which appear only on the unlit side and have to fade in
 *    across that same band rather than switch on.
 *  - the ATMOSPHERE, a forward-scattering rim that is brightest where the limb
 *    is most edge-on to the viewer AND lit — not a uniform fresnel glow.
 */
const EARTH_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 worldViewProjection;
uniform mat4 world;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPositionW;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(world) * normal);
  vPositionW = (world * vec4(position, 1.0)).xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const EARTH_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPositionW;
uniform vec3 sunDir;      // world-space direction TOWARDS the sun
uniform vec3 cameraPos;
uniform sampler2D albedoMap;
uniform sampler2D cloudMap;
uniform sampler2D nightMap;
uniform sampler2D oceanMap;
uniform float cloudOffset; // clouds drift a little faster than the surface
uniform float hasClouds;
uniform float hasNight;
uniform float hasOcean;

void main() {
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPos - vPositionW);
  float ndl = dot(n, sunDir);

  // The terminator: a soft band, not an edge. Everything below keys off this.
  float day = smoothstep(-0.12, 0.22, ndl);

  vec3 albedo = texture2D(albedoMap, vUv).rgb;

  // Ocean glint: only water, only near the mirror direction, only in daylight.
  float water = hasOcean > 0.5 ? texture2D(oceanMap, vUv).r : 0.0;
  vec3 h = normalize(sunDir + v);
  // Tight and restrained: a wide, strong glint reads as a blown-out sun sitting
  // on the planet rather than as sunlight on an ocean.
  float glint = pow(max(dot(n, h), 0.0), 420.0) * water * day;

  vec3 lit = albedo * (0.06 + 1.12 * day);
  lit += vec3(1.0, 0.96, 0.86) * glint * 0.55;

  // Clouds sit above the surface, so they take the light a touch more directly
  // and cast the planet's own colour out of what they cover.
  if (hasClouds > 0.5) {
    float cover = texture2D(cloudMap, vec2(fract(vUv.x + cloudOffset), vUv.y)).r;
    vec3 cloudLit = vec3(1.0) * (0.10 + 1.05 * day);
    lit = mix(lit, cloudLit, clamp(cover, 0.0, 1.0) * 0.92);
  }

  // City lights: the unlit side only, and dimmed under thick cloud.
  if (hasNight > 0.5) {
    float night = 1.0 - smoothstep(-0.18, 0.06, ndl);
    vec3 lights = texture2D(nightMap, vUv).rgb;
    lit += lights * night * 1.5;
  }

  // Atmosphere: brightest where the limb is edge-on AND lit. A plain fresnel
  // would ring the night side too, which reads as a neon hoop.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6);
  float lit_rim = smoothstep(-0.35, 0.35, ndl);
  lit += vec3(0.36, 0.60, 1.0) * rim * lit_rim * 1.25;

  gl_FragColor = vec4(lit, 1.0);
}
`;

/**
 * The star, on a billboard.
 *
 * Same construction as the title screen's — a granulated photosphere with limb
 * darkening, a chromosphere rim, and a corona of filaments — with two changes
 * that only matter in 3D: it writes ALPHA so the galaxy shows through its
 * corona rather than being punched out by a black quad, and its geometry is a
 * camera-facing plane, so the shader works in the quad's own UVs instead of in
 * screen space.
 *
 * The corona is sampled along a unit DIRECTION vector rather than an angle,
 * because atan() has a branch cut at ±pi and sampling noise across it draws a
 * seam straight through the corona.
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
const STAR_DISC_FRACTION = 0.34;

let shadersRegistered = false;
function registerShaders(): void {
  if (shadersRegistered) return;
  Effect.ShadersStore["menuEarthVertexShader"] = EARTH_VERTEX;
  Effect.ShadersStore["menuEarthFragmentShader"] = EARTH_FRAGMENT;
  Effect.ShadersStore["menuStarVertexShader"] = STAR_VERTEX;
  Effect.ShadersStore["menuStarFragmentShader"] = STAR_FRAGMENT;
  shadersRegistered = true;
}

/** An authored `#rrggbb`, or the fallback when the theme leaves it out. */
function colorOf(hex: string | undefined, fallback: string): Color3 {
  return Color3.FromHexString(hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback);
}

/** Azimuth/elevation in degrees → a unit direction in Babylon's Y-up world. */
function direction(azimuthDeg: number, elevationDeg: number): Vector3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

export interface MenuDioramaOptions {
  /** Where the hull sits above the regolith. */
  shipHeight?: number;
  /** Camera distance from the hull. */
  distance?: number;
  /**
   * How far below the hull the camera aims, in world units. The menu's buttons
   * own the bottom two thirds of the screen, so the frame is deliberately
   * dropped: aiming low pushes the hull into the clear upper tier instead of
   * parking it behind the mode cards.
   */
  framingLift?: number;
}

export class MenuDiorama {
  readonly root: TransformNode;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly camera: TargetCamera;
  /**
   * The camera's own right/up axes, computed once from the pose below.
   * `theme.menu.scene.starfield.ship` places the hull in THIS basis, so an
   * authored "push it right" means right on screen rather than along world +X.
   */
  private readonly camRight = new Vector3(1, 0, 0);
  private readonly camUp = new Vector3(0, 1, 0);
  private readonly previousCamera: TargetCamera | null;
  private previousEnvironment: BaseTexture | null = null;
  private readonly previousClear: Color4;
  private earthMaterial: ShaderMaterial | null = null;
  private earth: Mesh | null = null;
  private starMaterial: ShaderMaterial | null = null;
  private skybox: Mesh | null = null;
  private beforeRender: Observer<Scene> | null = null;
  private elapsed = 0;

  private readonly paint: ShipPaintBank;
  /**
   * Every asset fetch this diorama has started and not yet settled — cubemap
   * faces, ground/planet maps, the hull GLB. {@link ready} drains it, which is
   * what lets the launch sequence hold the boot screen up until the menu behind
   * it is actually drawn instead of fading into a black frame.
   */
  private readonly pending: Promise<unknown>[] = [];
  private hull: Mesh | null = null;
  private readonly shipHeight: number;
  /** Hull loads already kicked, so a re-show does not re-fetch the GLB. */
  private readonly kicked = new Set<string>();

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly assets: AssetRegistry,
    private readonly config: MenuScene,
    options: MenuDioramaOptions = {},
  ) {
    registerShaders();
    this.root = new TransformNode("menuDiorama", scene);
    const distance = options.distance ?? 8.6;
    const shipHeight = options.shipHeight ?? 1.35;
    this.shipHeight = shipHeight;
    this.paint = new ShipPaintBank(scene, configs);

    this.previousClear = scene.clearColor.clone();
    scene.clearColor = new Color4(0.004, 0.005, 0.012, 1);

    // The camera looks along +Z at the hull, from slightly above it, with Earth
    // placed by azimuth relative to that forward — so the authored angles in the
    // theme mean what a designer expects them to mean.
    this.previousCamera = (scene.activeCamera as TargetCamera | null) ?? null;
    this.camera = new TargetCamera(
      "menuDioramaCamera",
      new Vector3(distance * 0.46, shipHeight + 1.5, -distance),
      scene,
    );
    // Aim below the hull, not at it — see `framingLift`. The hull therefore
    // projects ABOVE the screen's centre line, which is the only part of the
    // menu the UI does not cover.
    this.camera.setTarget(new Vector3(0, shipHeight + 0.55 - (options.framingLift ?? 1.7), 0));
    // Screen basis for hull placement. Left-handed: right = up x forward.
    const forward = this.camera
      .getTarget()
      .subtract(this.camera.position)
      .normalize();
    Vector3.CrossToRef(Vector3.Up(), forward, this.camRight);
    this.camRight.normalize();
    Vector3.CrossToRef(forward, this.camRight, this.camUp);
    this.camUp.normalize();

    this.camera.fov = 0.78;
    this.camera.minZ = 0.35;
    // Earth is parked 900 units out; a default far plane would clip it away.
    this.camera.maxZ = 4000;
    this.camera.parent = this.root;

    this.buildLights();
    this.buildEnvironment();
    if (config.kind === "starfield") this.buildStarfield();
    else this.buildEarthrise();

    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  /** The scene the theme selected, or `null` when it names none. */
  private get earthrise(): Earthrise | null {
    return this.config.kind === "earthrise" ? (this.config.earthrise ?? null) : null;
  }
  private get starfield(): Starfield | null {
    return this.config.kind === "starfield" ? (this.config.starfield ?? null) : null;
  }

  /**
   * Whichever scene is live supplies the KEY LIGHT — which is deliberately a
   * separate authored direction from the visible star (`starfield.star`).
   *
   * A sun drawn in front of the camera backlights everything: the hull becomes a
   * silhouette and none of the metal catches anything (owner, 2026-08-21: "I
   * want to see the nice sunlight reflections on it"). The shipped starfield
   * therefore cheats the key round to the camera's side while the star stays
   * where it is drawn. Every other cue — colour, glare, the corona washing the
   * galaxy out — still says "that is the light source", which is what makes the
   * cheat invisible and standard practice for a hero shot.
   */
  private get sunConfig(): { azimuthDeg?: number; elevationDeg?: number; intensity?: number } | undefined {
    return this.starfield?.sun ?? this.earthrise?.sun;
  }

  /**
   * The hull adrift against a live star, with the galaxy behind it.
   *
   * The sky is a real cubemap and doubles as the scene's environment texture,
   * so the galaxy is what the hull's metal reflects — the same photons lighting
   * the shot are the ones in the background, which is most of why it sits in
   * the scene rather than on top of it.
   */
  private buildStarfield(): void {
    const cfg = this.starfield;
    if (!cfg) return;

    if (cfg.sky) {
      const ext = cfg.skyExtension ?? ".webp";
      const files = ["_px", "_py", "_pz", "_nx", "_ny", "_nz"].map(
        (face) => `${contentUrl(cfg.sky!)}${face}${ext}`,
      );
      let skyLoaded: () => void = () => undefined;
      this.track(new Promise<void>((resolve) => (skyLoaded = resolve)));
      const sky = new CubeTexture(contentUrl(cfg.sky), this.scene, null, false, files, skyLoaded, skyLoaded);
      this.disposables.push(sky);

      const box = MeshBuilder.CreateBox("menuDiorama.sky", { size: 6000 }, this.scene);
      box.parent = this.root;
      box.isPickable = false;
      box.infiniteDistance = true;
      const mat = new StandardMaterial("menuDiorama.skyMat", this.scene);
      mat.backFaceCulling = false;
      mat.disableLighting = true;
      mat.reflectionTexture = sky;
      mat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.specularColor = new Color3(0, 0, 0);
      box.material = mat;
      box.renderingGroupId = 0;
      this.skybox = box;
      this.disposables.push(mat);

      // The galaxy IS the fill light. Replaces the procedural cube built above.
      this.scene.environmentTexture = sky;
      this.scene.environmentIntensity = cfg.skyLight ?? 0.35;
    }

    const star = cfg.star;
    if (!star) return;

    // Far enough that nothing can intersect it, sized to subtend the authored
    // apparent diameter. The quad is bigger than the disc by the shader's own
    // corona allowance, or the glare would be clipped at the quad's edge.
    const distance = 1500;
    const discSpan = distance * (star.apparentSize ?? 0.68);
    const quadSpan = discSpan / (STAR_DISC_FRACTION * 2);

    const plane = MeshBuilder.CreatePlane("menuDiorama.star", { size: quadSpan }, this.scene);
    plane.parent = this.root;
    plane.isPickable = false;
    plane.applyFog = false;
    plane.position = direction(star.azimuthDeg ?? -26, star.elevationDeg ?? 7).scale(distance);
    // Billboarded so the disc stays circular whatever the camera does.
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.renderingGroupId = 0;

    const mat = new ShaderMaterial(
      "menuDiorama.starMat",
      this.scene,
      { vertex: "menuStar", fragment: "menuStar" },
      {
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection", "time", "coreColor", "shellColor", "coronaColor"],
        needAlphaBlending: true,
      },
    );
    mat.setColor3("coreColor", colorOf(star.core, "#fff4d2"));
    mat.setColor3("shellColor", colorOf(star.shell, "#ff8a1e"));
    mat.setColor3("coronaColor", colorOf(star.corona, "#ff9433"));
    mat.backFaceCulling = false;
    // Depth-write off: it is a transparent billboard, and writing depth would
    // punch its own corona out of anything drawn after it.
    mat.disableDepthWrite = true;
    // PREMULTIPLIED, not additive (owner 2026-08-21: "we should not see the
    // skybox behind the sun itself").
    //
    //   result = src + dst * (1 - srcAlpha)
    //
    // The photosphere writes alpha 1, so it REPLACES the galaxy — a star is an
    // opaque body, and seeing stars through it read as a decal. The corona and
    // the glare write alpha near 0 with real colour, so they still ADD over the
    // galaxy exactly as before. One blend mode, both behaviours, one draw.
    mat.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    plane.material = mat;

    this.starMaterial = mat;
    this.disposables.push(mat);
  }

  private buildEarthrise(): void {
    this.buildGround();
    this.buildEarth();
    this.buildRocks();
  }

  private buildLights(): void {
    const sun = this.sunConfig;
    const dir = direction(sun?.azimuthDeg ?? 62, sun?.elevationDeg ?? 14).negate();
    const key = new DirectionalLight("menuDiorama.sun", dir, this.scene);
    key.intensity = sun?.intensity ?? 3.4;
    // Sunlight in vacuum is white; the warmth in a lunar photograph is the
    // regolith, not the star.
    key.diffuse = new Color3(1, 0.98, 0.94);
    key.specular = new Color3(1, 1, 1);
    key.parent = this.root;
    this.disposables.push(key);

    // Earthshine: the only fill on the Moon, and it is blue.
    const fill = new HemisphericLight("menuDiorama.earthshine", new Vector3(0.2, 1, -0.4), this.scene);
    fill.intensity = 0.28;
    fill.diffuse = new Color3(0.42, 0.58, 0.88);
    fill.groundColor = new Color3(0.06, 0.07, 0.10);
    fill.parent = this.root;
    this.disposables.push(fill);
  }

  /** A dim IBL so the hull's metallic surfaces are not black — same trick HangarBay uses. */
  private buildEnvironment(): void {
    this.previousEnvironment = this.scene.environmentTexture;
    const size = 8;
    const faces: Uint8Array[] = [];
    for (let f = 0; f < 6; f++) {
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        // Up is starlight, down is the regolith bounce.
        const up = f === 2 ? 1 : f === 3 ? 0 : 0.4;
        data[i * 4 + 0] = Math.round(255 * (0.03 + 0.05 * up));
        data[i * 4 + 1] = Math.round(255 * (0.04 + 0.06 * up));
        data[i * 4 + 2] = Math.round(255 * (0.06 + 0.10 * up));
        data[i * 4 + 3] = 255;
      }
      faces.push(data);
    }
    const cube = new RawCubeTexture(this.scene, faces, size);
    this.scene.environmentTexture = cube;
    this.disposables.push(cube);
  }

  /**
   * The regolith plain. A ground mesh with real subdivisions, displaced by a
   * cheap deterministic hash so the horizon is not a razor line, wearing the
   * pack's moon PBR set at a high tiling.
   */
  private buildGround(): void {
    const ground = this.earthrise?.ground;
    if (!ground) return;
    const radius = ground.radius ?? DEFAULT_RADIUS;
    const relief = ground.relief ?? 1.6;
    const mesh = MeshBuilder.CreateGround(
      "menuDiorama.regolith",
      { width: radius * 2, height: radius * 2, subdivisions: 96, updatable: relief > 0 },
      this.scene,
    );
    mesh.parent = this.root;
    mesh.isPickable = false;

    if (relief > 0) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (positions) {
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i]!;
          const z = positions[i + 2]!;
          const d = Math.hypot(x, z);
          // Flat under the ship, undulating further out: a hull parked on a
          // dune reads as a bug, and the relief is there for the horizon.
          const mask = Math.min(1, Math.max(0, (d - 14) / 60));
          positions[i + 1] =
            relief * mask * (Math.sin(x * 0.07) * Math.cos(z * 0.055) + 0.5 * Math.sin(x * 0.021 + z * 0.03));
        }
        mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
        mesh.createNormals(true);
      }
    }

    const mat = new PBRMaterial("menuDiorama.regolithMat", this.scene);
    const tiling = ground.tiling ?? DEFAULT_TILING;
    const tile = (path: string): Texture => {
      const tex = this.trackedTexture(path);
      tex.uScale = tiling;
      tex.vScale = tiling;
      return tex;
    };
    mat.albedoTexture = tile(ground.albedo);
    if (ground.normal) mat.bumpTexture = tile(ground.normal);
    if (ground.ao) mat.ambientTexture = tile(ground.ao);
    // Regolith is uniformly, extremely rough and not remotely metallic. The one
    // number that matters here is that nothing on it glints.
    mat.metallic = 0;
    mat.roughness = 0.97;
    mat.albedoColor = new Color3(0.62, 0.60, 0.58);
    mat.specularIntensity = 0.15;
    mesh.material = mat;
    this.disposables.push(mat);
  }

  /** Earth on the horizon, drawn by the shader above. */
  private buildEarth(): void {
    const earth = this.earthrise?.earth;
    if (!earth) return;

    // Placed far away and sized to subtend the authored apparent diameter, so
    // the ground plane can never intersect it and the framing is resolution
    // independent.
    const distance = 900;
    const apparent = earth.apparentSize ?? 0.6;
    const radius = distance * apparent * 0.5;

    const sphere = MeshBuilder.CreateSphere("menuDiorama.earth", { diameter: radius * 2, segments: 64 }, this.scene);
    sphere.parent = this.root;
    sphere.isPickable = false;
    sphere.applyFog = false;
    // Behind everything: it is 900 units away and must never sort in front of
    // the hull or clip against the plain.
    sphere.renderingGroupId = 0;
    sphere.infiniteDistance = false;

    const dir = direction(earth.azimuthDeg ?? -21, earth.elevationDeg ?? 9);
    sphere.position = dir.scale(distance);
    sphere.rotation.z = ((earth.tiltDeg ?? 23.4) * Math.PI) / 180;

    const mat = new ShaderMaterial(
      "menuDiorama.earthMat",
      this.scene,
      { vertex: "menuEarth", fragment: "menuEarth" },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: [
          "worldViewProjection",
          "world",
          "sunDir",
          "cameraPos",
          "cloudOffset",
          "hasClouds",
          "hasNight",
          "hasOcean",
        ],
        samplers: ["albedoMap", "cloudMap", "nightMap", "oceanMap"],
      },
    );
    const map = (path: string): Texture => this.trackedTexture(path);
    mat.setTexture("albedoMap", map(earth.albedo));
    // Every sampler must be bound even when the pack ships no such map, or the
    // draw fails on some drivers rather than taking the `has*` branch.
    const blank = map(earth.albedo);
    mat.setTexture("cloudMap", earth.clouds ? map(earth.clouds) : blank);
    mat.setTexture("nightMap", earth.night ? map(earth.night) : blank);
    mat.setTexture("oceanMap", earth.ocean ? map(earth.ocean) : blank);
    mat.setFloat("hasClouds", earth.clouds ? 1 : 0);
    mat.setFloat("hasNight", earth.night ? 1 : 0);
    mat.setFloat("hasOcean", earth.ocean ? 1 : 0);
    mat.backFaceCulling = true;
    sphere.material = mat;

    this.earth = sphere;
    this.earthMaterial = mat;
    this.disposables.push(mat);
  }

  /**
   * Scatter the authored boulder props across the plain.
   *
   * Deterministic placement from a fixed hash, not a roll: the menu should look
   * the same every time a player opens it, and a rock that moves between visits
   * reads as a rendering bug rather than as variety.
   */
  private buildRocks(): void {
    const ids = this.earthrise?.rocks ?? [];
    if (ids.length === 0) return;
    // A cleared ring around the pad, then rocks out to the middle distance.
    const places = [
      { x: -9.5, z: 6.0, s: 1.5, r: 0.7 },
      { x: 12.5, z: 9.5, s: 2.4, r: 2.1 },
      { x: -17.0, z: -8.0, s: 1.9, r: 4.0 },
      { x: 21.0, z: -4.5, s: 3.1, r: 1.2 },
      { x: -26.0, z: 14.0, s: 4.2, r: 5.4 },
      { x: 33.0, z: 18.0, s: 5.6, r: 3.3 },
      { x: -41.0, z: -19.0, s: 6.4, r: 0.2 },
      { x: 48.0, z: -26.0, s: 7.8, r: 2.7 },
    ];
    places.forEach((place, index) => {
      const prop = this.configs.get<PropConfig>("prop", ids[index % ids.length]!);
      if (!prop?.render) return;
      void this.track(this.assets.ensureModel(prop.render)).then((master) => {
        if (!master || this.root.isDisposed()) return;
        const rock = master.createInstance(`menuDiorama.rock.${index}`);
        rock.parent = this.root;
        rock.isPickable = false;
        rock.position.set(place.x, -0.15 * place.s, place.z);
        rock.rotation.set(0, place.r, 0);
        rock.scaling.setAll(place.s);
      });
    });
  }

  /** Register an in-flight load so {@link ready} waits for it. Never rejects. */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.push(promise.catch(() => undefined));
    return promise;
  }

  /**
   * A {@link Texture} whose load is tracked. Babylon starts the fetch in the
   * constructor and reports it through callbacks, so the promise is just those
   * callbacks in a shape `ready` can await.
   */
  private trackedTexture(path: string): Texture {
    let settle: () => void = () => undefined;
    this.track(new Promise<void>((resolve) => (settle = resolve)));
    // Both arms resolve: a texture that 404s must not hold the boot screen up
    // forever — the menu is better shown with one map missing than not at all.
    const tex = new Texture(contentUrl(path), this.scene, undefined, undefined, undefined, settle, settle);
    this.disposables.push(tex);
    return tex;
  }

  /**
   * Resolves once every asset staged so far has settled AND one frame has been
   * drawn with them, or after `timeoutMs` — whichever comes first.
   *
   * The timeout is load-bearing, not defensive padding: a slow CDN or a missing
   * file must delay the menu, never withhold it. Draining in a loop matters too,
   * because finishing one load starts another (the hull GLB lands, which builds
   * the painted master, which is what actually has to be on screen).
   */
  async ready(timeoutMs = 5000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const settled = (async () => {
      while (this.pending.length > 0) {
        await Promise.all(this.pending.splice(0));
      }
      if (this.root.isDisposed()) return;
      // Assets being in MEMORY is not the same as the renderer having used
      // them: textures upload and shaders compile on first draw, and that is
      // the second of black this exists to prevent.
      //
      // We render here, by hand, rather than waiting on an observable —
      // `engine.runRenderLoop` does not start until AFTER the boot screen comes
      // down (main.ts), so waiting for a frame would simply time out and the
      // fade would land on a scene that had never been drawn at all.
      await this.scene.whenReadyAsync().catch(() => undefined);
      for (let i = 0; i < 3 && !this.root.isDisposed(); i++) {
        try {
          this.scene.render();
        } catch {
          break; // a scene that cannot draw must not hold the menu hostage
        }
      }
    })();
    try {
      await Promise.race([settled, cutoff]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Park the pilot's main hull on the pad, wearing its equipped skin.
   *
   * Idempotent per (ship, skin): re-showing the menu must not re-fetch the GLB
   * or leak a second hull onto the pad.
   */
  showHull(shipId: string | null, cosmeticId: string | null): void {
    this.hull?.dispose();
    this.hull = null;
    if (!shipId) return;
    const ship = this.configs.get<ShipConfig>("ship", shipId);
    if (!ship) return;

    const key = `${ship.id}:${ship.render.model ?? ""}`;
    if (ship.render.model && !this.kicked.has(key)) {
      this.kicked.add(key);
      void this.track(
        this.assets.ensureModel(ship.render).then((master) => {
          if (master && !this.root.isDisposed()) this.showHull(shipId, cosmeticId);
        }),
      );
    }

    const base = this.assets.getShipMaster(ship.render);
    const master = this.paint.masterFor(base, ship, cosmeticId);
    const mesh = master.clone(`menuDiorama.hull.${ship.id}`);
    if (!mesh) return;
    mesh.setParent(this.root);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    // Authored placement, in the camera's own basis (see `camRight`/`camUp`).
    const place = this.starfield?.ship;
    mesh.position.set(0, this.shipHeight, 0);
    mesh.position.addInPlace(this.camRight.scale(place?.shiftRight ?? 0));
    mesh.position.addInPlace(this.camUp.scale(place?.lift ?? 0));
    // Three-quarter view: the nose away from the camera and canted, so the
    // silhouette reads as a ship rather than as a dart pointed at the viewer.
    const rad = (deg: number): number => (deg * Math.PI) / 180;
    mesh.rotation.set(
      rad(place?.pitchDeg ?? 0),
      place?.yawDeg === undefined ? Math.PI * 0.82 : rad(place.yawDeg),
      rad(place?.rollDeg ?? 0),
    );
    this.hull = mesh;
  }

  private tick(): void {
    const dt = this.scene.getEngine().getDeltaTime() / 1000;
    this.elapsed += dt;
    const earth = this.earthrise?.earth;
    if (this.earth && earth) {
      this.earth.rotation.y = (this.elapsed * (earth.spinDegPerSec ?? 0.35) * Math.PI) / 180;
    }
    const sky = this.starfield;
    if (this.skybox && sky?.skyDriftDegPerSec) {
      this.skybox.rotation.y = (this.elapsed * sky.skyDriftDegPerSec * Math.PI) / 180;
    }
    if (this.starMaterial) {
      this.starMaterial.setFloat("time", this.elapsed * (sky?.star?.speed ?? 1));
    }
    if (this.earthMaterial) {
      const sun = this.sunConfig;
      this.earthMaterial.setVector3("sunDir", direction(sun?.azimuthDeg ?? 62, sun?.elevationDeg ?? 14));
      this.earthMaterial.setVector3("cameraPos", this.scene.activeCamera?.position ?? Vector3.Zero());
      // Clouds drift a little faster than the surface turns — the difference is
      // what stops the two layers reading as one painted texture.
      this.earthMaterial.setFloat("cloudOffset", this.elapsed * 0.0009);
    }
  }

  /** The camera the menu renders through, so the caller can activate it. */
  get dioramaCamera(): TargetCamera {
    return this.camera;
  }

  /** Point the diorama camera at the scene; call when the menu becomes visible. */
  activate(): void {
    this.scene.activeCamera = this.camera;
  }

  dispose(): void {
    if (this.beforeRender) this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.beforeRender = null;
    this.scene.environmentTexture = this.previousEnvironment;
    this.scene.clearColor = this.previousClear;
    if (this.previousCamera) this.scene.activeCamera = this.previousCamera;
    this.hull?.dispose();
    this.hull = null;
    // Painted clones first: a bank disposed after its textures would free
    // materials whose maps have already gone.
    this.paint.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.camera.dispose();
    this.root.dispose();
  }
}
