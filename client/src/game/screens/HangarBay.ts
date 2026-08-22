import {
  Color3,
  Constants,
  DynamicTexture,
  MeshBuilder,
  PointLight,
  RawCubeTexture,
  ShadowGenerator,
  SpotLight,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
  type Mesh,
  type Scene,
} from "@babylonjs/core";

/**
 * The physical hangar the ship is parked in (owner 2026-07-31).
 *
 * Before this the outfitting screen floated the hull in open space, which read
 * as "a model viewer" rather than "your ship, in a bay". A room does three
 * things a void cannot: it gives the hull a floor to sit on so its size is
 * legible, it gives the orbit camera parallax so rotating feels like walking
 * around something, and its lights put a warm key on one side and a cool rim on
 * the other so the silhouette reads at every angle.
 *
 * It remains deliberately bounded: a tiny procedural IBL cube and one small,
 * blurred shadow map make the hull read as metal without turning a menu into a
 * second arena renderer. The whole thing is owned by the screen visit.
 */
export interface HangarBayOptions {
  /** Radius of the landing pad. Sized from the hull the bay is built around. */
  padRadius?: number;
  /** Accent colour of the guide strips and lamps. */
  accent?: Color3;
}

const DEFAULT_ACCENT = new Color3(0.94, 0.48, 0.02);

/**
 * The bay's light rig, in one place (owner 2026-08-22: "more light in the
 * hangar 3D view — the hull has to read").
 *
 * Every value below was raised from the first pass, which was lit for MOOD and
 * left a dark hull sitting in a dark room: the pilot could see the bay but not
 * the thing they came to look at. The rule for raising them was that the ROOM
 * must not get brighter with the ship — the structural surfaces are
 * `StandardMaterial` with a black specular, so they take the punctual lights
 * flatly, while the hulls are PBR and take both the lights and the IBL. That is
 * why the biggest lift here is the environment intensity: it is the one knob
 * that reaches the hull and skips the bay entirely.
 *
 * Four lights, and deliberately not five: `StandardMaterial`/`PBRMaterial`
 * default to `maxSimultaneousLights = 4`, so a fifth would not add light — it
 * would silently evict one of these from some materials.
 */
const RIG = {
  /** Warm front-left key. Doubled: this is the light that shapes the hull. */
  keyIntensity: 1.3,
  /** Cool back-right rim, kept well under the key so the silhouette still reads. */
  rimIntensity: 0.75,
  /** Overhead work light — the room's own practical, and the shadow caster. */
  overheadIntensity: 3,
  /** Deck bounce, so the underside is shaded rather than solid black. */
  bounceIntensity: 0.45,
  /**
   * Ambient/IBL gain for the visit. **Restored on dispose**, because it is a
   * SCENE property and the menu diorama sets its own (0.35 for a night sky) and
   * never puts it back — so a hangar opened straight from the menu used to
   * inherit a third of the ambient it was authored for. Owning the value for the
   * duration of the visit is what makes the bay's brightness its own.
   */
  environmentIntensity: 1.3,
} as const;

export class HangarBay {
  readonly root: TransformNode;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly previousEnvironment: BaseTexture | null;
  private readonly previousEnvironmentIntensity: number;
  private readonly environment: RawCubeTexture | null;
  private readonly shadows: ShadowGenerator;

  constructor(scene: Scene, parent: TransformNode, opts: HangarBayOptions = {}) {
    const padRadius = opts.padRadius ?? 9;
    const accent = opts.accent ?? DEFAULT_ACCENT;
    this.root = new TransformNode("hangarBay", scene);
    this.root.parent = parent;

    // A compact, authored-in-code cube gives the GLB PBR hulls broad cool bay
    // reflections and a warm ceiling practical. RawCubeTexture supports mip
    // generation, so rough surfaces naturally blur it without an HDR download.
    this.previousEnvironment = scene.environmentTexture;
    this.environment = this.createEnvironment(scene);
    if (this.environment) scene.environmentTexture = this.environment;
    // Taken unconditionally, IBL cube or not: the intensity is what the menu
    // diorama leaves behind, and restoring it is the bay's job either way.
    this.previousEnvironmentIntensity = scene.environmentIntensity;
    scene.environmentIntensity = RIG.environmentIntensity;

    const deck = this.plated(scene, "hangarBay.deck", new Color3(0.075, 0.08, 0.09));
    const trim = this.plated(scene, "hangarBay.trim", new Color3(0.14, 0.15, 0.165), 0.45);
    const seamMat = this.matte(scene, "hangarBay.seam", new Color3(0.03, 0.033, 0.038));
    const glow = this.emissive(scene, "hangarBay.glow", accent);
    const hazard = this.emissive(scene, "hangarBay.hazard", accent.scale(0.5));
    const window_ = this.emissive(scene, "hangarBay.window", new Color3(0.38, 0.55, 0.78));
    const lampMat = this.emissive(scene, "hangarBay.lamp", new Color3(0.95, 0.92, 0.82));

    // The ship floats a little above its pad, the way a docked hull sits in its
    // clamps; everything below is measured down from there.
    const deckY = -padRadius * 0.55;

    // --- the pad -----------------------------------------------------------
    // Octagonal deck plate, the way a real docking pad is built: a structural
    // ring you can see the segments of rather than a smooth disc.
    const pad = MeshBuilder.CreateCylinder(
      "hangarBay.pad",
      { diameter: padRadius * 2, height: 0.5, tessellation: 8 },
      scene,
    );
    pad.material = deck;
    pad.receiveShadows = true;
    pad.position.y = deckY;
    this.add(pad);

    // Recessed seams across the plate. Purely visual, but they are what gives
    // the deck a SIZE — a blank disc reads as a texture, a panelled one reads
    // as engineering the ship is standing on.
    for (let i = 0; i < 4; i++) {
      const seam = MeshBuilder.CreateBox(
        "hangarBay.seam",
        { width: padRadius * 1.95, depth: 0.11, height: 0.06 },
        scene,
      );
      seam.material = seamMat;
      seam.position.set(0, deckY + 0.26, 0);
      seam.rotation.y = (Math.PI / 4) * i;
      this.add(seam);
    }

    // Guide ring just inside the pad edge — the one bright line that says
    // "this is the spot", and the thing the eye tracks while orbiting.
    const ring = MeshBuilder.CreateTorus(
      "hangarBay.ring",
      { diameter: padRadius * 1.72, thickness: 0.14, tessellation: 8 },
      scene,
    );
    ring.material = glow;
    ring.position.y = deckY + 0.27;
    this.add(ring);

    // Hazard chevrons around the pad edge: the marking every real dock has,
    // and the cheapest possible cue that the middle is where the ship goes.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const chevron = MeshBuilder.CreateBox(
        "hangarBay.chevron",
        { width: padRadius * 0.2, depth: 0.5, height: 0.05 },
        scene,
      );
      chevron.material = i % 2 === 0 ? hazard : seamMat;
      chevron.position.set(Math.cos(a) * padRadius * 0.93, deckY + 0.27, Math.sin(a) * padRadius * 0.93);
      chevron.rotation.y = -a;
      this.add(chevron);
    }

    // Docking clamps: four arms reaching in from the pad edge, stopping short of
    // the hull. They are what makes the ship look BERTHED rather than hovering.
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
      const armLen = padRadius * 0.5;
      const arm = MeshBuilder.CreateBox(
        "hangarBay.clamp",
        { width: armLen, depth: 0.55, height: 0.45 },
        scene,
      );
      arm.material = trim;
      const r = padRadius * 0.72;
      arm.position.set(Math.cos(a) * r, deckY + 0.7, Math.sin(a) * r);
      arm.rotation.y = -a;
      this.add(arm);

      const head = MeshBuilder.CreateBox("hangarBay.clampHead", { width: 0.3, depth: 0.7, height: 0.7 }, scene);
      head.material = glow;
      const hr = r - armLen * 0.5;
      head.position.set(Math.cos(a) * hr, deckY + 0.9, Math.sin(a) * hr);
      head.rotation.y = -a;
      this.add(head);
    }

    // --- the room ----------------------------------------------------------
    // Floor plate the pad stands on, wide enough to fill the lower half of the
    // frame at any orbit angle without ever becoming the subject.
    const floor = MeshBuilder.CreateBox(
      "hangarBay.floor",
      { width: padRadius * 7, depth: padRadius * 7, height: 0.3 },
      scene,
    );
    floor.material = deck;
    floor.receiveShadows = true;
    floor.position.y = deckY - 0.4;
    this.add(floor);

    // Floor grid: long recessed lines running out from the pad. They carry the
    // parallax while orbiting far more than the walls do.
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      for (const axis of [0, 1] as const) {
        const line = MeshBuilder.CreateBox(
          "hangarBay.grid",
          axis === 0
            ? { width: padRadius * 7, depth: 0.09, height: 0.05 }
            : { width: 0.09, depth: padRadius * 7, height: 0.05 },
          scene,
        );
        line.material = seamMat;
        line.position.set(
          axis === 1 ? i * padRadius * 1.1 : 0,
          deckY - 0.23,
          axis === 0 ? i * padRadius * 1.1 : 0,
        );
        this.add(line);
      }
    }

    // Rear wall + two side walls: enough enclosure for parallax, open at the
    // front so the camera never ends up inside geometry.
    const wallH = padRadius * 3;
    for (const [x, z, w, d] of [
      [0, -padRadius * 3.2, padRadius * 7, 0.4],
      [-padRadius * 3.2, 0, 0.4, padRadius * 7],
      [padRadius * 3.2, 0, 0.4, padRadius * 7],
    ] as const) {
      const wall = MeshBuilder.CreateBox("hangarBay.wall", { width: w, depth: d, height: wallH }, scene);
      wall.material = trim;
      wall.position.set(x, deckY + wallH / 2, z);
      this.add(wall);
    }

    // Lit windows along the rear wall — a control gallery looking down at the
    // pad. One row of small emissive panels does more for "this place is
    // staffed" than any amount of extra structure.
    for (let i = -4; i <= 4; i++) {
      const win = MeshBuilder.CreateBox("hangarBay.window", { width: padRadius * 0.5, depth: 0.12, height: 0.9 }, scene);
      win.material = window_;
      win.position.set(i * padRadius * 0.68, deckY + wallH * 0.62, -padRadius * 3.15);
      this.add(win);
    }

    // Gantry pillars at the pad corners, with a lit strip up each one. They are
    // what gives the orbit its sense of motion.
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const x = sx * padRadius * 1.9;
      const z = sz * padRadius * 1.9;
      const pillar = MeshBuilder.CreateBox(
        "hangarBay.pillar",
        { width: 0.8, depth: 0.8, height: wallH * 0.86 },
        scene,
      );
      pillar.material = trim;
      pillar.position.set(x, deckY + (wallH * 0.86) / 2, z);
      this.add(pillar);

      const strip = MeshBuilder.CreateBox(
        "hangarBay.strip",
        { width: 0.16, depth: 0.16, height: wallH * 0.66 },
        scene,
      );
      strip.material = glow;
      strip.position.set(x - sx * 0.47, deckY + (wallH * 0.66) / 2, z - sz * 0.47);
      this.add(strip);

      // Service platform partway up each pillar, facing the pad.
      const deckPlate = MeshBuilder.CreateBox(
        "hangarBay.platform",
        { width: padRadius * 0.9, depth: 1.1, height: 0.18 },
        scene,
      );
      deckPlate.material = trim;
      deckPlate.position.set(x - sx * padRadius * 0.42, deckY + wallH * 0.42, z);
      this.add(deckPlate);
    }

    // Overhead trusses: the ceiling a hangar has, and the thing that stops the
    // upper half of the frame being empty black when the camera looks up.
    for (let i = -2; i <= 2; i++) {
      const truss = MeshBuilder.CreateBox(
        "hangarBay.truss",
        { width: padRadius * 6.6, depth: 0.5, height: 0.5 },
        scene,
      );
      truss.material = trim;
      truss.position.set(0, deckY + wallH * 0.94, i * padRadius * 1.5);
      this.add(truss);

      // Work lamp slung under every other truss, aimed at the pad.
      if (i % 2 === 0) {
        const lamp = MeshBuilder.CreateBox("hangarBay.lamp", { width: padRadius * 0.7, depth: 0.3, height: 0.14 }, scene);
        lamp.material = lampMat;
        lamp.position.set(0, deckY + wallH * 0.9, i * padRadius * 1.5);
        this.add(lamp);
      }
    }

    // Key and rim: warm from the front-left, cool from behind-right. Both are
    // parented to the bay root and RANGE-CLAMPED to it, which is what keeps this
    // a stage rig rather than a scene one — the arena lives ~200 units away in
    // the same scene, well outside any of these ranges, so a match is lit by
    // `SceneBuilder`'s rig exactly as it was before this screen existed.
    const key = new PointLight("hangarBay.key", new Vector3(-padRadius, padRadius * 1.4, padRadius * 1.6), scene);
    key.diffuse = new Color3(1, 0.72, 0.47);
    key.intensity = RIG.keyIntensity;
    key.range = padRadius * 9;
    key.parent = this.root;
    this.disposables.push(key);

    const rim = new PointLight("hangarBay.rim", new Vector3(padRadius * 1.3, padRadius * 0.6, -padRadius * 1.8), scene);
    rim.diffuse = new Color3(0.45, 0.66, 1);
    rim.intensity = RIG.rimIntensity;
    rim.range = padRadius * 9;
    rim.parent = this.root;
    this.disposables.push(rim);

    // Overhead work light: what actually makes the hull read as lit FROM the
    // room rather than floodlit from nowhere, and what puts the ship's shadow
    // side where the eye expects it.
    const overhead = new SpotLight(
      "hangarBay.overhead",
      new Vector3(0, padRadius * 2.4, padRadius * 0.2),
      new Vector3(0, -1, -0.08),
      Math.PI / 2.4,
      6,
      scene,
    );
    overhead.diffuse = new Color3(1, 0.78, 0.52);
    overhead.intensity = RIG.overheadIntensity;
    overhead.range = padRadius * 8;
    overhead.parent = this.root;
    this.disposables.push(overhead);

    // One 512px blurred map is enough to ground the displayed ship. It is
    // deliberately attached only to the work light: extra maps are costly and
    // make the stage unstable on integrated/mobile GPUs.
    this.shadows = new ShadowGenerator(512, overhead);
    this.shadows.useBlurExponentialShadowMap = true;
    this.shadows.blurKernel = 8;
    // Release the render target before its casters/receivers go away.
    this.disposables.unshift(this.shadows);

    // Low bounce off the deck, so the hull's underside is not a silhouette.
    const bounce = new PointLight("hangarBay.bounce", new Vector3(0, deckY + 0.8, padRadius * 0.4), scene);
    bounce.diffuse = new Color3(0.28, 0.42, 0.62);
    bounce.intensity = RIG.bounceIntensity;
    bounce.range = padRadius * 4;
    bounce.parent = this.root;
    this.disposables.push(bounce);
  }

  private add(mesh: Mesh): void {
    mesh.parent = this.root;
    mesh.isPickable = false;
    this.disposables.push(mesh);
  }

  /** Matte structural surface — no specular, so nothing competes with the hull. */
  private matte(scene: Scene, name: string, colour: Color3): StandardMaterial {
    const mat = new StandardMaterial(name, scene);
    mat.diffuseColor = colour;
    mat.specularColor = Color3.Black();
    this.disposables.push(mat);
    return mat;
  }

  /** Structural plating with a modest procedural albedo, bump and specular variation. */
  private plated(scene: Scene, name: string, colour: Color3, bumpStrength = 0.7): StandardMaterial {
    const mat = this.matte(scene, name, colour);
    mat.specularColor = new Color3(0.22, 0.24, 0.27);
    mat.specularPower = 48;
    // Headless NullEngine has neither a canvas context nor a GPU texture
    // target. Keep material/lifecycle tests deterministic there.
    if (!scene.getEngine().getRenderingCanvas()) return mat;
    const { albedo, normal, specular } = this.createPlateMaps(scene, name, colour);
    mat.diffuseTexture = albedo;
    mat.bumpTexture = normal;
    mat.bumpTexture.level = bumpStrength;
    // StandardMaterial has no roughness map; a low-contrast specular map is
    // the equivalent control and keeps seams/wear from reflecting uniformly.
    mat.specularTexture = specular;
    this.disposables.push(albedo, normal, specular);
    return mat;
  }

  private createPlateMaps(scene: Scene, name: string, colour: Color3): { albedo: DynamicTexture; normal: DynamicTexture; specular: DynamicTexture } {
    const size = 256;
    const albedo = new DynamicTexture(`${name}.albedo`, { width: size, height: size }, scene, true);
    const normal = new DynamicTexture(`${name}.normal`, { width: size, height: size }, scene, true);
    const specular = new DynamicTexture(`${name}.specular`, { width: size, height: size }, scene, true);
    for (const texture of [albedo, normal, specular]) {
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.uScale = 5;
      texture.vScale = 5;
    }
    normal.gammaSpace = false;
    specular.gammaSpace = false;

    const albedoContext = albedo.getContext();
    albedoContext.fillStyle = `rgb(${Math.round(colour.r * 255)}, ${Math.round(colour.g * 255)}, ${Math.round(colour.b * 255)})`;
    albedoContext.fillRect(0, 0, size, size);
    // Plate edges, fine brushing and sparse worn streaks. These are laid into
    // the same deterministic height field used below for the tangent-space map.
    albedoContext.fillStyle = "rgba(0, 0, 0, 0.34)";
    for (let p = 0; p <= size; p += 64) {
      albedoContext.fillRect(p, 0, 2, size);
      albedoContext.fillRect(0, p, size, 2);
    }
    albedoContext.fillStyle = "rgba(190, 205, 220, 0.045)";
    for (let y = 7; y < size; y += 9) albedoContext.fillRect(0, y, size, 1);
    albedoContext.fillStyle = "rgba(215, 190, 145, 0.08)";
    for (let i = 0; i < 18; i++) albedoContext.fillRect((i * 47) % size, (i * 83) % size, 13 + (i % 4) * 9, 1);
    albedo.update();

    const normalPixels = new Uint8ClampedArray(size * size * 4);
    const specularPixels = new Uint8ClampedArray(size * size * 4);
    const height = (x: number, y: number): number => {
      const seam = x % 64 < 2 || y % 64 < 2 ? -1.2 : 0;
      const brush = Math.sin(y * 0.72 + x * 0.04) * 0.055;
      const wear = Math.sin(x * 0.13 + y * 0.19) * 0.035;
      return seam + brush + wear;
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const dx = (height((x + 1) % size, y) - height((x + size - 1) % size, y)) * 3.2;
      const dy = (height(x, (y + 1) % size) - height(x, (y + size - 1) % size)) * 3.2;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      normalPixels[index] = Math.round((0.5 - dx * inv * 0.5) * 255);
      normalPixels[index + 1] = Math.round((0.5 - dy * inv * 0.5) * 255);
      normalPixels[index + 2] = Math.round(inv * 255);
      normalPixels[index + 3] = 255;
      const variation = 104 + Math.round((height(x, y) + 1.2) * 20);
      specularPixels[index] = variation;
      specularPixels[index + 1] = variation;
      specularPixels[index + 2] = variation;
      specularPixels[index + 3] = 255;
    }
    normal.getContext().putImageData(new ImageData(normalPixels, size, size), 0, 0);
    specular.getContext().putImageData(new ImageData(specularPixels, size, size), 0, 0);
    normal.update();
    specular.update();
    return { albedo, normal, specular };
  }

  private createEnvironment(scene: Scene): RawCubeTexture | null {
    // NullEngine has no WebGL texture backend. Keeping this guard lets the
    // lifecycle tests exercise every other owned resource without faking IBL.
    if (!scene.getEngine().getRenderingCanvas()) return null;
    const size = 16;
    const faceColours: readonly [number, number, number][] = [
      [48, 68, 96], [48, 68, 96], [232, 158, 91], [18, 25, 39], [32, 47, 68], [32, 47, 68],
    ];
    const faces = faceColours.map(([r, g, b]) => {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const glow = y < 3 && (x > 4 && x < 12) ? 42 : 0;
        data[i] = Math.min(255, r + glow);
        data[i + 1] = Math.min(255, g + glow);
        data[i + 2] = Math.min(255, b + glow);
        data[i + 3] = 255;
      }
      return data;
    });
    const environment = new RawCubeTexture(scene, faces, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, true);
    environment.coordinatesMode = Texture.CUBIC_MODE;
    environment.gammaSpace = false;
    environment.level = 0.72;
    return environment;
  }

  /** Register the current hull after it exists; keeps the shadow map scoped to the bay. */
  addShadowCaster(mesh: AbstractMesh): void {
    this.shadows.addShadowCaster(mesh, true);
  }

  /** Unlit strip light: emissive only, so it reads the same at every angle. */
  private emissive(scene: Scene, name: string, colour: Color3): StandardMaterial {
    const mat = new StandardMaterial(name, scene);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = colour;
    this.disposables.push(mat);
    return mat;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    const scene = this.root.getScene();
    if (this.environment && scene.environmentTexture === this.environment) scene.environmentTexture = this.previousEnvironment;
    // Hand the ambient gain back too — leaving the bay's brighter value behind
    // would light the next arena with the hangar's rig (the exact bug this took
    // over from the menu diorama).
    scene.environmentIntensity = this.previousEnvironmentIntensity;
    this.environment?.dispose();
    this.root.dispose();
  }
}
