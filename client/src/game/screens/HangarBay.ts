import {
  Color3,
  MeshBuilder,
  PointLight,
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

    const deck = this.matte(scene, "hangarBay.deck", new Color3(0.07, 0.075, 0.085));
    const trim = this.matte(scene, "hangarBay.trim", new Color3(0.13, 0.14, 0.155));
    const glow = this.emissive(scene, "hangarBay.glow", accent);

    // The ship floats a little above its pad, the way a docked hull sits in its
    // clamps; everything below is measured down from there.
    const deckY = -padRadius * 0.55;

    const pad = MeshBuilder.CreateCylinder(
      "hangarBay.pad",
      { diameter: padRadius * 2, height: 0.4, tessellation: 8 },
      scene,
    );
    pad.material = deck;
    pad.position.y = deckY;
    this.add(pad);

    // Guide ring just inside the pad edge — the one bright line that says
    // "this is the spot", and the thing the eye tracks while orbiting.
    const ring = MeshBuilder.CreateTorus(
      "hangarBay.ring",
      { diameter: padRadius * 1.72, thickness: 0.16, tessellation: 8 },
      scene,
    );
    ring.material = glow;
    ring.position.y = deckY + 0.22;
    this.add(ring);

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
        { width: 0.7, depth: 0.7, height: wallH * 0.8 },
        scene,
      );
      pillar.material = trim;
      pillar.position.set(x, deckY + (wallH * 0.8) / 2, z);
      this.add(pillar);

      const strip = MeshBuilder.CreateBox(
        "hangarBay.strip",
        { width: 0.16, depth: 0.16, height: wallH * 0.62 },
        scene,
      );
      strip.material = glow;
      strip.position.set(x - sx * 0.42, deckY + (wallH * 0.62) / 2, z - sz * 0.42);
      this.add(strip);
    }

    // Key and rim: warm from the front-left, cool from behind-right. Range is
    // clamped to the bay so nothing here can reach the arena.
    const key = new PointLight("hangarBay.key", new Vector3(-padRadius, padRadius * 1.4, padRadius * 1.6), scene);
    key.diffuse = new Color3(1, 0.82, 0.62);
    key.intensity = 0.9;
    key.range = padRadius * 9;
    key.parent = this.root;
    this.disposables.push(key);

    const rim = new PointLight("hangarBay.rim", new Vector3(padRadius * 1.3, padRadius * 0.6, -padRadius * 1.8), scene);
    rim.diffuse = new Color3(0.45, 0.66, 1);
    rim.intensity = 0.6;
    rim.range = padRadius * 9;
    rim.parent = this.root;
    this.disposables.push(rim);
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
