import {
  Color3,
  MeshBuilder,
  PointLight,
  SpotLight,
  StandardMaterial,
  TransformNode,
  Vector3,
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
 * Deliberately cheap: a pad, a rear wall, four gantry pillars, a couple of
 * strip lights and two point lights. Every surface is unlit-emissive or matte —
 * no reflections, no shadows, nothing that would cost a frame on a phone.
 * The whole thing is one parent node, built once and disposed with the screen.
 */
export interface HangarBayOptions {
  /** Radius of the landing pad. Sized from the hull the bay is built around. */
  padRadius?: number;
  /** Accent colour of the guide strips and lamps. */
  accent?: Color3;
}

const DEFAULT_ACCENT = new Color3(0.94, 0.48, 0.02);

export class HangarBay {
  readonly root: TransformNode;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene, parent: TransformNode, opts: HangarBayOptions = {}) {
    const padRadius = opts.padRadius ?? 9;
    const accent = opts.accent ?? DEFAULT_ACCENT;
    this.root = new TransformNode("hangarBay", scene);
    this.root.parent = parent;

    const deck = this.matte(scene, "hangarBay.deck", new Color3(0.075, 0.08, 0.09));
    const trim = this.matte(scene, "hangarBay.trim", new Color3(0.14, 0.15, 0.165));
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

    // Key and rim: warm from the front-left, cool from behind-right. Range is
    // clamped to the bay so nothing here can reach the arena.
    const key = new PointLight("hangarBay.key", new Vector3(-padRadius, padRadius * 1.4, padRadius * 1.6), scene);
    key.diffuse = new Color3(1, 0.82, 0.62);
    key.intensity = 0.85;
    key.range = padRadius * 9;
    key.parent = this.root;
    this.disposables.push(key);

    const rim = new PointLight("hangarBay.rim", new Vector3(padRadius * 1.3, padRadius * 0.6, -padRadius * 1.8), scene);
    rim.diffuse = new Color3(0.45, 0.66, 1);
    rim.intensity = 0.55;
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
    overhead.diffuse = new Color3(1, 0.95, 0.86);
    overhead.intensity = 1.5;
    overhead.range = padRadius * 8;
    overhead.parent = this.root;
    this.disposables.push(overhead);

    // Low bounce off the deck, so the hull's underside is not a silhouette.
    const bounce = new PointLight("hangarBay.bounce", new Vector3(0, deckY + 0.8, padRadius * 0.4), scene);
    bounce.diffuse = accent.scale(0.55);
    bounce.intensity = 0.35;
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
    this.root.dispose();
  }
}
