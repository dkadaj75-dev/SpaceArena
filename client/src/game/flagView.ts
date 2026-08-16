/**
 * The capture-the-flag flag family: pole, cloth pennant, wake and base beacon.
 *
 * Split out of `EntityView.ts` because none of it is entangled with the rest of
 * the view: no other view family touches the flag map, the beacon clock or the
 * trail scratch buffers, and nothing in here needs a ship, an asteroid, a
 * projectile or the content registry. Keeping it here means the whole flag
 * story — geometry, pose, wake and beacon — reads in one place, and
 * {@link import("./EntityView.js").ViewManager} keeps one field and one call.
 *
 * The maths this leans on stays in `flagTrail.ts` (wake resampling) and
 * `flagBeacon.ts` (beacon radius and breath), both pure and Babylon-free; this
 * module is the Babylon half that turns those numbers into meshes.
 */
import {
  Color3,
  FresnelParameters,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type LinesMesh,
  type Scene,
} from "@babylonjs/core";
import type { EntityId, FlagSnapshot, Snapshot } from "@space-arena/shared";
import { resampleTrail, trailAlphas, TRAIL_POINTS, type TrailPoint } from "./flagTrail.js";
import { advanceBeaconClock, beaconPhase, beaconPulse, beaconRadius } from "./flagBeacon.js";
// Type-only, so this does NOT close a runtime import cycle with EntityView:
// `ViewQuality` is that module's contract for the active tier and the flag
// family reads one knob off it, so re-declaring it here would only let the two
// drift apart.
import type { ViewQuality } from "./EntityView.js";

const FLAG_BANNER_COLUMNS = 9;
const FLAG_BANNER_ROWS = 4;
const FLAG_BANNER_WIDTH = 5.8;
const FLAG_BANNER_HEIGHT = 3.2;
const FLAG_BANNER_BASE_Y = 0.2;
const FLAG_BANNER_WAVE_MS = 34;
const FLAG_TRANSITION_MS = 130;

/**
 * Distance plus projected-size gate for expensive transparent shells.
 *
 * Written for shells in general rather than for beacons in particular, and kept
 * exported for the next one — but the base beacon is its only caller today, so
 * it lives beside that caller instead of in the general view module.
 */
export function transparentShellVisible(
  distance: number,
  radius: number,
  cullDistance: number,
  verticalFov = 1.05,
  viewportHeight = 720,
  minDiameterPixels = 3,
): boolean {
  if (distance > cullDistance) return false;
  if (distance <= radius) return true;
  const diameterPixels = (radius * 2 / (2 * distance * Math.tan(verticalFov / 2))) * viewportHeight;
  return diameterPixels >= minDiameterPixels;
}

/**
 * One capture-the-flag flag in the scene: a physical pole and cloth pennant,
 * plus the fading breadcrumb wake. The pennant's small fixed vertex grid is
 * updated at 30 Hz, which gives it a stately ripple without shader/material
 * lifetime complexity or per-frame allocations.
 *
 * It also owns the BASE BEACON (owner 2026-08-01) — the shell standing on the
 * flag's home, which is what tells a carrier where to deliver. The beacon is
 * tied to the flag view purely for lifetime: it never follows the flag, and it
 * stays lit whether the flag is home, dropped or carried.
 */
interface FlagView {
  root: TransformNode;
  pole: Mesh;
  stand: Mesh;
  banner: Mesh;
  /** Bright free-edge hem shares the cloth material, making the silhouette read at range. */
  bannerEdge: Mesh;
  bannerPositions: Float32Array;
  poleMaterial: StandardMaterial;
  bannerMaterial: StandardMaterial;
  /** State is smoothed into these values so a pickup/drop never snaps. */
  scale: number;
  tilt: number;
  standScale: number;
  bannerClockMs: number;
  bannerUpdateMs: number;
  trail: LinesMesh;
  /** Base beacon shell, parked on `flag.home` for the life of the view. */
  beacon: Mesh;
  beaconMaterial: StandardMaterial;
  /** Where this beacon sits in the shared breath, so bases don't pulse as one. */
  beaconPhase: number;
  team: number;
}

/** The flag family's whole surface to its owner (see {@link createFlagViews}). */
export interface FlagViews {
  /** Create/update/retire every flag view for this frame's snapshot. */
  sync(cur: Snapshot, frameDtMs: number): void;
  /**
   * Adopt a new quality tier. Mirrors the juice pools' `setQuality` because the
   * beacon's cull distance is read LIVE every frame: a tier changed mid-match
   * would otherwise keep culling at the distance that was current when this
   * family was built.
   */
  setQuality(quality: ViewQuality): void;
  /** Tear every flag view down (view teardown; snapshot exits go through `sync`). */
  dispose(): void;
}

/**
 * Build the flag family against an existing scene and view root.
 *
 * `viewRoot` is PASSED IN rather than owned: every view family hangs off the
 * one node ViewManager toggles with `setVisible`, so the flags must join it
 * rather than create a second root that no one would hide.
 *
 * Neither the content registry nor the viewer's team is here, and deliberately:
 * flags are built entirely from the snapshot, and their colours are TEAM-stable
 * (blue is team 0 in every replay and on both sides of a split screen), unlike
 * the shield bubbles that do care who is watching.
 */
export function createFlagViews(
  scene: Scene,
  quality: ViewQuality,
  viewRoot: TransformNode,
): FlagViews {
  /** Capture-the-flag flags and their wakes (owner 2026-07-31). */
  const flags = new Map<EntityId, FlagView>();
  let tier = quality;
  /** Shared beacon breath clock, wrapped to one period (see `flagBeacon.ts`). */
  let beaconClockMs = 0;
  /** Scratch trail ladder — resampled in place every frame, never reallocated. */
  const sTrail: TrailPoint[] = [];
  const sTrailVectors: Vector3[] = [];

  function createFlagView(flag: FlagSnapshot): FlagView {
    const id: EntityId = flag.id;
    // Team identity (not viewer allegiance) keeps both physical banners
    // consistently blue/red in replays, spectators and split-screen.
    const colour = flag.team === 1 ? new Color3(1.0, 0.18, 0.28) : new Color3(0.12, 0.62, 1.0);
    const root = new TransformNode(`flag.${id}`, scene);
    root.parent = viewRoot;

    const poleMaterial = new StandardMaterial(`mat.flagPole.${id}`, scene);
    poleMaterial.diffuseColor = new Color3(0.16, 0.2, 0.27);
    poleMaterial.specularColor = new Color3(0.72, 0.8, 0.92);
    poleMaterial.specularPower = 96;
    const pole = MeshBuilder.CreateCylinder(`flagPole.${id}`, { diameter: 0.22, height: 7.2, tessellation: 8 }, scene);
    pole.material = poleMaterial;
    pole.position.y = 0.1;
    pole.isPickable = false;
    pole.parent = root;

    const stand = MeshBuilder.CreateCylinder(`flagStand.${id}`, { diameter: 2.5, height: 0.32, tessellation: 12 }, scene);
    stand.material = poleMaterial;
    stand.position.y = -3.65;
    stand.isPickable = false;
    stand.parent = root;

    const bannerMaterial = new StandardMaterial(`mat.flagBanner.${id}`, scene);
    bannerMaterial.diffuseColor = colour.scale(0.34);
    bannerMaterial.emissiveColor = colour.scale(0.72);
    bannerMaterial.specularColor = colour.scale(0.4);
    bannerMaterial.specularPower = 72;
    bannerMaterial.backFaceCulling = false;
    const { banner, positions } = createFlagBanner(id, bannerMaterial, scene, root);
    const bannerEdge = MeshBuilder.CreateBox(
      `flagBannerEdge.${id}`,
      { width: 0.13, height: FLAG_BANNER_HEIGHT, depth: 0.1 },
      scene,
    );
    bannerEdge.material = bannerMaterial;
    bannerEdge.position.set(FLAG_BANNER_WIDTH, FLAG_BANNER_BASE_Y + FLAG_BANNER_HEIGHT / 2, 0);
    bannerEdge.isPickable = false;
    bannerEdge.parent = root;

    for (let i = sTrailVectors.length; i < TRAIL_POINTS; i++) sTrailVectors.push(new Vector3());
    const seed = sTrailVectors.slice(0, TRAIL_POINTS);
    const trail = MeshBuilder.CreateLines(
      `flagTrail.${id}`,
      { points: seed, colors: trailAlphas().map(() => colour.toColor4(1)), updatable: true },
      scene,
    );
    trail.color = colour;
    trail.isPickable = false;
    trail.parent = viewRoot;
    trail.setEnabled(false);
    // The fade lives in the VERTEX COLOURS, written once: the ribbon's shape
    // changes every frame but its gradient never does, so there is nothing to
    // recompute on the hot path.
    if (trail.getVerticesData("color")) {
      trail.setVerticesData(
        "color",
        trailAlphas().flatMap((a) => [colour.r, colour.g, colour.b, a]),
        true,
      );
    }

    const radius = beaconRadius(flag.baseRadius);
    const beaconMat = new StandardMaterial(`mat.flagBeacon.${id}`, scene);
    beaconMat.diffuseColor = Color3.Black();
    // A little specular is what sells "shiny" rather than "coloured fog".
    beaconMat.specularColor = colour.scale(0.35);
    beaconMat.specularPower = 96;
    beaconMat.emissiveColor = colour;
    beaconMat.alpha = beaconPulse(0, beaconPhase(id)).alpha;
    // Rim glow, clear middle — the objective-beacon look. The fresnel ramps
    // emission and opacity toward grazing angles, so the shell reads as a hard
    // bubble from outside while the fight inside it stays legible.
    beaconMat.emissiveFresnelParameters = fresnel(colour, colour.scale(0.12), 0.2, 2.6);
    beaconMat.opacityFresnelParameters = fresnel(
      new Color3(1, 1, 1),
      new Color3(0.3, 0.3, 0.3),
      0.1,
      2.2,
    );
    // Both faces, because a shell you can fly INTO must not vanish from inside.
    beaconMat.backFaceCulling = false;
    // Never write depth: this thing is bigger than the fight it contains, and a
    // depth-writing transparent shell would punch holes in the trails and
    // particles drawn inside it.
    beaconMat.disableDepthWrite = true;

    const beacon = MeshBuilder.CreateSphere(
      `flagBeacon.${id}`,
      { diameter: radius * 2, segments: 10 },
      scene,
    );
    beacon.material = beaconMat;
    beacon.isPickable = false;
    beacon.parent = viewRoot;
    // The base never moves, so this is the only position write it ever needs.
    beacon.position.set(flag.home.x, flag.home.y, flag.home.z);

    return {
      root,
      pole,
      stand,
      banner,
      bannerEdge,
      bannerPositions: positions,
      poleMaterial,
      bannerMaterial,
      scale: flag.state === "carried" ? 0.68 : 1,
      tilt: flag.state === "dropped" ? 1.08 : 0,
      standScale: flag.state === "home" ? 1 : 0,
      bannerClockMs: 0,
      bannerUpdateMs: FLAG_BANNER_WAVE_MS,
      trail,
      beacon,
      beaconMaterial: beaconMat,
      beaconPhase: beaconPhase(id),
      team: flag.team,
    };
  }

  return {
    /**
     * Capture-the-flag flags and their wakes (owner 2026-07-31).
     *
     * The physical flag changes pose by state: upright on its stand at home,
     * compact when carried, and tilted loose when dropped. Its wake still fades
     * from nothing at its oldest end to bright at the runner.
     *
     * The base beacon (owner 2026-08-01) breathes off a single shared clock. It
     * is recomputed from that clock every frame rather than nudged, so a frame
     * hitch cannot leave a base permanently the wrong size or opacity.
     */
    sync(cur: Snapshot, frameDtMs: number): void {
      beaconClockMs = advanceBeaconClock(beaconClockMs, frameDtMs);

      for (const flag of cur.flags) {
        let view = flags.get(flag.id);
        if (!view) {
          view = createFlagView(flag);
          flags.set(flag.id, view);
        }

        // The beacon marks the BASE, so it ignores everything the flag is doing.
        const pulse = beaconPulse(beaconClockMs, view.beaconPhase);
        view.beacon.scaling.setAll(pulse.scale);
        view.beaconMaterial.alpha = pulse.alpha;
        const camera = scene.activeCamera;
        const shellCull = tier.scene?.transparentShellCullDistance;
        if (camera && shellCull) {
          camera.computeWorldMatrix();
          const distance = Vector3.Distance(camera.globalPosition, view.beacon.getAbsolutePosition());
          view.beacon.setEnabled(transparentShellVisible(
            distance,
            view.beacon.getBoundingInfo().boundingSphere.radius * pulse.scale,
            shellCull,
            camera.fov,
            scene.getEngine().getRenderHeight(),
          ));
        } else {
          view.beacon.setEnabled(true);
        }

        view.root.position.set(flag.pos.x, flag.pos.y, flag.pos.z);
        // The replicated flag position follows the carrier. Put the mast above
        // its hull while keeping home/drop exactly at the sim position.
        if (flag.state === "carried") view.root.position.y += 3.6;
        const blend = 1 - Math.exp(-Math.max(0, frameDtMs) / FLAG_TRANSITION_MS);
        const targetScale = flag.state === "carried" ? 0.68 : 1;
        const targetTilt = flag.state === "dropped" ? 1.08 : 0;
        view.scale += (targetScale - view.scale) * blend;
        view.tilt += (targetTilt - view.tilt) * blend;
        view.standScale += ((flag.state === "home" ? 1 : 0) - view.standScale) * blend;
        view.root.scaling.setAll(view.scale);
        view.root.rotation.z = view.tilt;
        // Flip the second team's silhouette; colour is team-stable too.
        view.root.rotation.y = view.team === 1 ? Math.PI : 0;
        view.stand.scaling.set(1, view.standScale, 1);
        view.stand.setEnabled(view.standScale > 0.01);
        view.bannerClockMs += Math.max(0, frameDtMs);
        view.bannerUpdateMs += Math.max(0, frameDtMs);
        if (view.bannerUpdateMs >= FLAG_BANNER_WAVE_MS) {
          updateFlagBanner(view);
          view.bannerUpdateMs %= FLAG_BANNER_WAVE_MS;
        }

        if (resampleTrail(flag.trail, sTrail, TRAIL_POINTS)) {
          for (let i = 0; i < TRAIL_POINTS; i++) {
            sTrailVectors[i]!.set(sTrail[i]!.x, sTrail[i]!.y, sTrail[i]!.z);
          }
          MeshBuilder.CreateLines(view.trail.name, { points: sTrailVectors, instance: view.trail }, scene);
          view.trail.setEnabled(true);
        } else {
          view.trail.setEnabled(false);
        }
      }

      // A mode change or match reset can drop flags entirely.
      for (const [id, view] of flags) {
        if (cur.flags.some((f) => f.id === id)) continue;
        disposeFlagView(view);
        flags.delete(id);
      }
    },

    setQuality(quality: ViewQuality): void {
      tier = quality;
    },

    dispose(): void {
      for (const v of flags.values()) disposeFlagView(v);
      flags.clear();
    },
  };
}

/**
 * The single place a flag view is torn down — both exit routes (a flag leaving
 * the snapshot, and view teardown) go through here so a material can never be
 * leaked by one of them drifting out of step with the other.
 */
function disposeFlagView(view: FlagView): void {
  view.bannerMaterial.dispose();
  view.poleMaterial.dispose();
  view.banner.dispose();
  view.bannerEdge.dispose();
  view.pole.dispose();
  view.stand.dispose();
  view.trail.dispose();
  view.beaconMaterial.dispose();
  view.beacon.dispose();
  view.root.dispose();
}

/** Build one small, updatable cloth grid. It is deliberately not shared: each
 * flag needs its own wave phase and colour, while there are only two flags. */
function createFlagBanner(
  id: EntityId,
  material: StandardMaterial,
  scene: Scene,
  parent: TransformNode,
): { banner: Mesh; positions: Float32Array } {
  const vertexCount = FLAG_BANNER_COLUMNS * FLAG_BANNER_ROWS;
  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  for (let row = 0; row < FLAG_BANNER_ROWS - 1; row++) {
    for (let column = 0; column < FLAG_BANNER_COLUMNS - 1; column++) {
      const a = row * FLAG_BANNER_COLUMNS + column;
      const b = a + 1;
      const c = a + FLAG_BANNER_COLUMNS;
      indices.push(a, c, b, b, c, c + 1);
    }
  }
  const normals = new Float32Array(positions.length);
  writeFlagBanner(positions, 0, id);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  const banner = new Mesh(`flagBanner.${id}`, scene);
  data.applyToMesh(banner, true);
  banner.material = material;
  banner.isPickable = false;
  banner.parent = parent;
  // Seed vertices before the first render, so a just-created flag never shows
  // as a single point for one frame.
  banner.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
  return { banner, positions };
}

function updateFlagBanner(view: FlagView): void {
  writeFlagBanner(view.bannerPositions, view.bannerClockMs, view.team);
  view.banner.updateVerticesData(VertexBuffer.PositionKind, view.bannerPositions, false, false);
  // The hem follows the outer edge's average displacement. It shares the
  // banner's emissive material, giving the waving silhouette a small readable
  // glow without a second material or texture.
  const top = ((FLAG_BANNER_ROWS - 1) * FLAG_BANNER_COLUMNS + FLAG_BANNER_COLUMNS - 1) * 3 + 2;
  const bottom = (FLAG_BANNER_COLUMNS - 1) * 3 + 2;
  view.bannerEdge.position.z = (view.bannerPositions[top]! + view.bannerPositions[bottom]!) * 0.5;
}

/** Writes a gently travelling ripple into the preallocated position buffer. */
function writeFlagBanner(positions: Float32Array, clockMs: number, phaseSeed: number): void {
  const time = clockMs * 0.001;
  let offset = 0;
  for (let row = 0; row < FLAG_BANNER_ROWS; row++) {
    const y = FLAG_BANNER_BASE_Y + (row / (FLAG_BANNER_ROWS - 1)) * FLAG_BANNER_HEIGHT;
    for (let column = 0; column < FLAG_BANNER_COLUMNS; column++) {
      const along = column / (FLAG_BANNER_COLUMNS - 1);
      positions[offset++] = along * FLAG_BANNER_WIDTH;
      positions[offset++] = y;
      // Fixed at the pole; the free edge has the most motion. The phase seed
      // prevents blue and red fabric folding in exact unison.
      positions[offset++] = Math.sin(time * 2.1 + along * 4.8 + row * 0.42 + phaseSeed) * 0.42 * along;
    }
  }
}

/** A `FresnelParameters` with `left` at grazing angles and `right` head-on. */
function fresnel(left: Color3, right: Color3, bias: number, power: number): FresnelParameters {
  const f = new FresnelParameters();
  f.isEnabled = true;
  f.leftColor = left;
  f.rightColor = right;
  f.bias = bias;
  f.power = power;
  return f;
}
