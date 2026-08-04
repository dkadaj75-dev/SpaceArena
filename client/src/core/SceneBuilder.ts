import {
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  FresnelParameters,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointsCloudSystem,
  ShaderMaterial,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type CloudPoint,
  type Material,
  type Node,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  type ArenaConfig,
  type ArenaRender,
  type ConfigService,
  type EventBus,
  type ConfigEvents,
  type QualityConfig,
} from "@space-arena/shared";
import {
  BOUNDARY_HEX_DENSITY_MAX,
  BOUNDARY_HEX_DENSITY_MIN,
  boundaryShieldOpacity,
  boundaryShieldRedMix,
  boundaryShieldRenderParams,
} from "./boundaryProximity.js";
import { DustField, resolveDustParams } from "./dustField.js";

const log = createLogger("SceneBuilder");

/**
 * The arena's playable radius — the bubble's radius (BUBBLE.md), or a rect
 * arena's half-diagonal, matching the minimap's rule. The one place scene
 * geometry learns how big the world is, so nothing downstream needs an
 * arena-sized literal.
 */
function boundsRadiusOf(arena: ArenaConfig): number {
  const b = arena.bounds;
  return b.shape === "sphere" ? b.radius : Math.hypot(b.width, b.verticalExtent, b.height) / 2;
}

function colorFromHex(hex: string | undefined, fallback: Color3): Color3 {
  if (!hex) return fallback;
  try {
    return Color3.FromHexString(hex);
  } catch {
    return fallback;
  }
}

const TEAM_COLORS = [new Color3(0.2, 0.55, 1.0), new Color3(1.0, 0.35, 0.25)];

/** Everything SceneBuilder reads off the active quality tier (§10 5.6). */
export type SceneQuality = Pick<QualityConfig, "glow" | "scene" | "render">;

/** Conservative defaults for callers that predate the quality system. */
const DEFAULT_QUALITY: SceneQuality = {
  glow: { enabled: true, intensity: 0.5 },
  scene: {
    skyboxEnabled: true,
    boundaryShieldShader: true,
    starfieldPoints: 400,
    spawnMarkers: true,
  },
  // `dust` deliberately omitted: this bag exists for callers that predate the
  // quality system, and `resolveDustParams` already owns the documented default.
  render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: false },
};

/**
 * Builds (and rebuilds, on hot-reload) the arena scene: the bounds shell,
 * skybox, light rig, spawn markers and the editor's pick plane. Every
 * node/material it creates is tracked so a rebuild leaves nothing behind.
 *
 * Perf (§10 5.6): the arena is entirely static, so once built its meshes get
 * `freezeWorldMatrix()` and their materials `freeze()`. Both are correctly
 * reversed whenever the arena is hidden (the dev editor stages its own content
 * and adds its own lights — a frozen StandardMaterial would never recompile for
 * the new light count) and on every rebuild.
 *
 * Note on `scene.freezeActiveMeshes()`: deliberately **not** used. It freezes
 * the scene-wide active-mesh list, and this scene also holds ships, projectiles
 * and asteroids that appear and disappear every frame — freezing it would
 * strand them. Per-mesh freezing gets the static-arena win without that.
 */
export class SceneBuilder {
  private root: TransformNode | null = null;
  private visible = true;
  private glowLayer: GlowLayer | null = null;
  private skybox: Mesh | null = null;
  private unsubscribers: Array<() => void> = [];
  private generation = 0;
  private quality: SceneQuality;
  private frozen = false;
  private arenaId: string | null = null;
  private arena: ArenaConfig | null = null;
  private boundaryMaterial: StandardMaterial | ShaderMaterial | null = null;
  private skyboxMaterialReadyToFreeze: StandardMaterial | null = null;
  private dust: DustField | null = null;
  /**
   * Editor override for `quality.scene.spawnMarkers`. `null` = follow the tier
   * (which is `false` in every shipped pack); `true` = the dev editor is open and
   * designers must still see where teams spawn. See {@link setSpawnMarkerOverride}.
   */
  private spawnMarkerOverride: boolean | null = null;
  private readonly boundaryBlue = new Color3();
  private readonly boundaryRed = new Color3();
  private readonly boundaryColor = new Color3();

  constructor(
    private readonly scene: Scene,
    private readonly configService: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    quality: SceneQuality = DEFAULT_QUALITY,
  ) {
    this.quality = quality;
  }

  /**
   * Swap the active quality tier. Cheap knobs (glow intensity/enabled) apply in
   * place; anything baked into geometry (starfield density, decoration meshes)
   * needs the rebuild this triggers.
   */
  setQuality(quality: SceneQuality): void {
    const previous = this.quality;
    this.quality = quality;
    if (!this.root) return;
    const needsRebuild =
      previous.scene.starfieldPoints !== quality.scene.starfieldPoints ||
      previous.scene.spawnMarkers !== quality.scene.spawnMarkers ||
      previous.scene.skyboxEnabled !== quality.scene.skyboxEnabled ||
      previous.scene.boundaryShieldShader !== quality.scene.boundaryShieldShader ||
      // Dust capacity, sizes and lifetimes are all baked into the ParticleSystem
      // at construction, so a tier swap rebuilds rather than mutating it.
      !sameDust(previous.scene.dust, quality.scene.dust);
    if (needsRebuild && this.arenaId) {
      const arena = this.configService.get<ArenaConfig>("arena", this.arenaId);
      if (arena) {
        this.rebuild(arena);
        return;
      }
    }
    this.applyGlowQuality();
    if (previous.render.freezeStatics !== quality.render.freezeStatics) {
      if (quality.render.freezeStatics) this.freezeStatics();
      else this.unfreezeStatics();
    }
  }

  /** Builds the arena named by `arenaId`, subscribing to hot-reload for arena/asteroid types. */
  buildArena(arenaId: string): void {
    const arena = this.configService.get<ArenaConfig>("arena", arenaId);
    if (!arena) {
      log.error(`arena config not found: ${arenaId}`);
      return;
    }
    this.arenaId = arenaId;

    this.rebuild(arena);

    // Rebuild cleanly on any relevant hot-reload — arena layout or the
    // asteroid/ship types it references may have changed shape/params.
    this.clearSubscriptions();
    this.unsubscribers.push(
      this.bus.on("config:changed", (evt) => {
        if (evt.type === "arena") {
          log.info(`rebuilding arena after ${evt.type} change: ${evt.id}`);
          const fresh = this.configService.get<ArenaConfig>("arena", arenaId);
          if (fresh) this.rebuild(fresh);
        }
      }),
    );
  }

  private rebuild(arena: ArenaConfig): void {
    // A rebuild disposes everything, so the frozen bookkeeping resets with it.
    this.disposeSceneNodes();
    this.frozen = false;
    const generation = ++this.generation;
    this.arena = arena;
    this.boundaryMaterial = null;

    const root = new TransformNode("arenaRoot", this.scene);
    this.root = root;
    root.setEnabled(this.visible);

    this.buildLighting(arena, root);
    this.buildSkybox(arena, root, generation);
    this.buildBounds(arena, root);
    this.buildPickPlane(arena, root);
    if (this.spawnMarkersVisible) this.buildSpawnMarkers(arena, root);
    this.buildDust();

    if (this.visible) this.freezeStatics();
  }

  /** Whether spawn gizmos should be drawn: the editor override, else the tier. */
  private get spawnMarkersVisible(): boolean {
    return this.spawnMarkerOverride ?? this.quality.scene.spawnMarkers;
  }

  /**
   * Force the team spawn gizmos on (or back to the quality tier's setting).
   *
   * Every shipped tier sets `quality.scene.spawnMarkers: false` — they are an
   * authoring aid and players should not see them mid-match. The dev Map editor
   * and the arena Inspector place spawns in ARENA coordinates against this very
   * scene, though, so they turn the override on for as long as the editor is
   * open. Kept as an override rather than a second flag so there is still ONE
   * shipped answer, and the editor's exception is visibly an exception.
   *
   * `null` clears it. Rebuilds only when the resolved answer actually changes.
   */
  setSpawnMarkerOverride(override: boolean | null): void {
    if (override === this.spawnMarkerOverride) return;
    const before = this.spawnMarkersVisible;
    this.spawnMarkerOverride = override;
    if (before === this.spawnMarkersVisible) return;
    const arena = this.arena;
    if (arena) this.rebuild(arena);
  }

  /**
   * Ambient dust motes (see {@link DustField}). Built per arena rebuild so a tier
   * swap re-bakes its capacity, and NOT parented to `arenaRoot`: a particle system
   * renders off the scene's list rather than its emitter's enabled flag, so its
   * visibility is driven explicitly from {@link setVisible} instead.
   */
  private buildDust(): void {
    this.dust?.dispose();
    this.dust = null;
    const params = resolveDustParams(this.quality.scene.dust);
    if (!params) return;
    const floorY = this.arena?.bounds.shape === "sphere" ? this.arena.bounds.floorY : undefined;
    this.dust = new DustField(this.scene, params, floorY);
    this.dust.setEnabled(this.visible);
  }

  /**
   * Show/hide the whole static arena — bounds shell, skybox, spawn markers
   * AND the light rig, which is parented to the same root. Callers that hide it
   * to stage something else must supply their own lighting (see EditorStage).
   * Latched so a hot-reload rebuild keeps the current visibility.
   *
   * Hiding also unfreezes: the editor adds its own lights while the arena is
   * away, and a material frozen against the old light set would come back with
   * a stale shader. Showing re-freezes against whatever is in the scene then.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root?.setEnabled(visible);
    this.dust?.setEnabled(visible);
    if (visible) this.freezeStatics();
    else this.unfreezeStatics();
  }

  /** Whether the static arena meshes/materials are currently frozen (test hook). */
  get staticsFrozen(): boolean {
    return this.frozen;
  }

  /**
   * `freezeWorldMatrix()` + `material.freeze()` across the arena. The skybox's
   * `infiniteDistance` world matrix stays live, and its material joins only
   * after one texture-ready render (see {@link buildSkybox}).
   */
  private freezeStatics(): void {
    if (this.frozen || !this.root || !this.quality.render.freezeStatics) return;
    this.frozen = true;
    const materials = new Set<Material>();
    forEachMesh(this.root, (mesh) => {
      if (mesh.infiniteDistance) return;
      mesh.freezeWorldMatrix();
      // Its world matrix is static, but opacity/color are driven every frame by
      // player proximity, so the boundary material must stay mutable.
      if (mesh.name === "boundsShell") return;
      if (mesh.material) materials.add(mesh.material);
    });
    if (this.skyboxMaterialReadyToFreeze) materials.add(this.skyboxMaterialReadyToFreeze);
    for (const material of materials) material.freeze();
  }

  private unfreezeStatics(): void {
    if (!this.frozen || !this.root) return;
    this.frozen = false;
    const materials = new Set<Material>();
    forEachMesh(this.root, (mesh) => {
      mesh.unfreezeWorldMatrix();
      if (mesh.material) materials.add(mesh.material);
    });
    for (const material of materials) material.unfreeze();
  }

  /**
   * The arena's light rig: one ambient fill + one key light, both parented to
   * `arenaRoot` so hiding the arena hides the lights with it (the dev editor
   * stages its own — see {@link setVisible}).
   *
   * The key light is a `DirectionalLight` (parallel rays, as a star at that
   * distance really is). When the arena's skybox authors a `sun`, that block IS
   * the key light: the panorama has a star painted into it at a known bearing,
   * and `sun.dir` points from the arena toward it, so the light travels along
   * **-dir** and every lit face ends up pointing back at the painted star. The
   * authored color/intensity replace the generic rig's entirely —
   * `lighting.directionalIntensity` is only consulted for an arena with no
   * authored sun (and remains the fallback for the built-in default rig).
   *
   * The hemispheric fill is deliberately KEPT, and leans toward the star, so the
   * unlit side of a hull reads as shadowed rather than as a black silhouette.
   */
  private buildLighting(arena: ArenaConfig, root: TransformNode): void {
    const sun = arena.render?.skybox.sun;
    const sunDir = sun ? normalizedOrNull(sun.dir) : null;

    // Hemispheric `direction` is where its SKY colour comes from, so pointing it
    // at the star puts the fill on the same side as the key light instead of
    // fighting it from world-up.
    const hemi = new HemisphericLight("arenaHemiLight", sunDir ?? new Vector3(0, 1, 0), this.scene);
    hemi.intensity = arena.lighting?.ambientIntensity ?? 0.4;
    hemi.diffuse = colorFromHex(arena.lighting?.ambientColor, new Color3(0.6, 0.65, 0.8));
    hemi.groundColor = colorFromHex(arena.lighting?.groundBounceColor, Color3.Black());
    hemi.parent = root;

    const dir = new DirectionalLight(
      "arenaDirLight",
      sunDir ? sunDir.scale(-1) : new Vector3(-0.4, -1, -0.3),
      this.scene,
    );
    dir.intensity = sun && sunDir ? sun.intensity : (arena.lighting?.directionalIntensity ?? 0.9);
    if (sun && sunDir) dir.diffuse = colorFromHex(sun.color, Color3.White());
    dir.parent = root;
  }

  private buildSkybox(arena: ArenaConfig, root: TransformNode, generation: number): void {
    const authored = arena.render?.skybox;
    if (authored && this.quality.scene.skyboxEnabled) {
      const skybox = MeshBuilder.CreateSphere(
        "skybox",
        { diameter: boundsRadiusOf(arena) * 6, segments: 32, sideOrientation: Mesh.BACKSIDE },
        this.scene,
      );
      const skyMat = new StandardMaterial("mat.skybox", this.scene);
      skyMat.diffuseColor = Color3.Black();
      skyMat.specularColor = Color3.Black();
      // The standard shader ADDS the emissive texture to emissiveColor
      // (default.fragment: `emissiveColor = vEmissiveColor; emissiveColor +=
      // tex * vEmissiveInfos.y`) — it never multiplies them. emissiveColor must
      // therefore stay BLACK permanently, or it paints a flat tint*intensity
      // wash over the whole sky (the "white sky" in every one of its forms).
      // Intensity rides the texture's own `level` (that IS vEmissiveInfos.y),
      // and the tint hue is an emissive Fresnel with equal left/right colors —
      // the one hook in this shader that MULTIPLIES the emissive result.
      skyMat.emissiveColor = Color3.Black();
      const tint = colorFromHex(authored.tint, Color3.White());
      skyMat.emissiveFresnelParameters = new FresnelParameters({
        isEnabled: true,
        leftColor: tint,
        rightColor: tint,
        bias: 1,
        power: 1,
      });
      // invertY=false: with the default flip, the equirectangular panorama
      // rendered upside down (image top row at the NADIR) — unnoticeable on a
      // nebula, glaring on a pano with a painted ground, and the reason a
      // painted sun never sat where `sun.dir` said it was. Marker-texture
      // probe: BACKSIDE sphere + default invertY shows the image BOTTOM at
      // the zenith; invertY=false restores "image top = up".
      const panorama = new Texture(
        `${import.meta.env.BASE_URL}content/${authored.texture}`,
        this.scene,
        undefined,
        false,
        undefined,
        () => {
          if (generation !== this.generation) return;
          // Texture is ready. With emissiveColor pinned to black a stale
          // textureless effect renders a BLACK sky, never a wash — but it can
          // persist indefinitely: an async texture load does not reliably
          // dirty this material's compiled effect (observed on Intel GPUs and
          // the software renderer alike; the sky stayed textureless forever).
          // Compile the texture-ready variant EXPLICITLY, and only then let
          // the material freeze.
          skyMat.unfreeze();
          void skyMat
            .forceCompilationAsync(skybox)
            .then(() => {
              if (generation !== this.generation || skybox.isDisposed()) return;
              this.skyboxMaterialReadyToFreeze = skyMat;
              if (this.frozen) skyMat.freeze();
            })
            .catch(() => undefined);
        },
        (message, exception) => {
          log.warn(
            `skybox texture failed for "${authored.texture}": ${message || String(exception)} — using solid authored tint`,
          );
          // A failed texture otherwise leaves the sky pure black. A DIM
          // color-only backdrop is the one place emissiveColor may be non-black
          // — there is no texture left for it to wash over.
          if (generation === this.generation) {
            skyMat.emissiveTexture?.dispose();
            skyMat.emissiveTexture = null;
            skyMat.emissiveColor.copyFrom(tint.scale(authored.intensity * 0.12));
          }
        },
      );
      panorama.isBlocking = false;
      panorama.level = authored.intensity;
      skyMat.emissiveTexture = panorama;
      skyMat.disableLighting = true;
      // The panorama is only a backdrop. Writing its near sphere depth hid the
      // farther point-cloud star shell even though both are visual sky layers.
      skyMat.disableDepthWrite = true;
      skybox.material = skyMat;
      skybox.infiniteDistance = true;
      skybox.isPickable = false;
      skybox.parent = root;
      this.skybox = skybox;
      this.glowLayer?.addExcludedMesh(skybox);
    }

    // Cheap starfield: a few hundred points via PointsCloudSystem, density per
    // quality tier (the point count is baked into the mesh at build time).
    const starCount = this.quality.scene.starfieldPoints;
    if (starCount <= 0) return;
    // The shell is sized off the ARENA, not a literal: at ring-nebula's radius
    // 90 the floor keeps the old 300-550 band, and on a radius-300 field
    // (FLIGHT.md §6) it opens out so the "distant stars" are not scattered
    // through the play space the player is flying in. 1.8× the bubble's radius
    // keeps every star outside it however far a ship climbs.
    const shellInner = Math.max(300, boundsRadiusOf(arena) * 1.8);
    const shellSpan = shellInner * 0.85;
    const pcs = new PointsCloudSystem("stars", 1, this.scene);
    pcs.addPoints(starCount, (particle: CloudPoint) => {
      const radius = shellInner + Math.random() * shellSpan;
      const theta = Math.random() * Math.PI * 2;
      // Uniform on the full sphere. This used to fold y to the upper hemisphere
      // and squash it — correct for a camera that only ever looked down at a
      // floor, a visible hole in the sky the moment a ship can dive and look up
      // from underneath (BUBBLE.md §C).
      const phi = Math.acos(2 * Math.random() - 1);
      particle.position = new Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
      const b = 0.5 + Math.random() * 0.5;
      particle.color = new Color4(b, b, b * 1.05, 1);
    });
    void pcs.buildMeshAsync().then((mesh) => {
      // Guard against a rebuild happening while the async mesh build was in flight.
      if (generation !== this.generation) {
        mesh.dispose();
        return;
      }
      mesh.isPickable = false;
      mesh.parent = root;
      // The starfield lands after rebuild() froze everything else — freeze it
      // too, or it would be the one arena mesh recomputing its matrix forever.
      if (this.frozen) {
        mesh.freezeWorldMatrix();
        mesh.material?.freeze();
      }
    });
  }

  /**
   * The arena's edge. For a bubble that is a **shell**, not a ring (BUBBLE.md
   * §C): ships leave the play space in any direction, so the boundary has to read
   * as a surface the player can approach from the inside at any latitude.
   *
   * `boundsShell` is a barely-there translucent sphere. It is what makes the
   *    edge feel like a wall when you fly at it, and it is drawn BACKSIDE so the
   *    inside faces render and the far half never occludes the view forward.
   */
  private buildBounds(arena: ArenaConfig, root: TransformNode): void {
    this.applyGlowQuality();

    if (arena.bounds.shape === "sphere") {
      const diameter = arena.bounds.radius * 2;
      const shield = arena.render?.boundaryShield;
      if (shield) {
        const shell = MeshBuilder.CreateSphere(
          "boundsShell",
          { diameter, segments: 48, sideOrientation: Mesh.BACKSIDE },
          this.scene,
        );
        shell.isPickable = false;
        this.boundaryBlue.copyFrom(colorFromHex(shield.blueColor, Color3.Blue()));
        this.boundaryRed.copyFrom(colorFromHex(shield.redColor, Color3.Red()));
        clampColorInPlace(this.boundaryBlue);
        clampColorInPlace(this.boundaryRed);
        this.boundaryColor.copyFrom(this.boundaryBlue);
        const renderParams = boundaryShieldRenderParams(shield.hexDensity, shield.baseOpacity);

        if (this.quality.scene.boundaryShieldShader) {
          const shellMat = createBoundaryShader(this.scene);
          shellMat.setFloat("hexDensity", renderParams.hexDensity);
          shellMat.setFloat("opacity", renderParams.opacity);
          shellMat.setColor3("shieldColor", this.boundaryBlue);
          shell.material = shellMat;
          this.boundaryMaterial = shellMat;
        } else {
          const shellMat = new StandardMaterial("mat.boundsShell", this.scene);
          shellMat.diffuseColor = Color3.Black();
          shellMat.specularColor = Color3.Black();
          shellMat.emissiveColor.copyFrom(this.boundaryBlue);
          shellMat.disableLighting = true;
          // Same hard bounds as the shader path: this material can never turn a
          // malformed hot-reload value into an opaque or over-bright shell.
          shellMat.alpha = renderParams.opacity;
          clampColorInPlace(shellMat.emissiveColor);
          shellMat.backFaceCulling = false;
          shell.material = shellMat;
          this.boundaryMaterial = shellMat;
        }
        shell.parent = root;

      }

      // A floor is physical terrain, not another face of the energy shield.
      // Build it even when an arena elects not to render a boundary shield.
      if (arena.bounds.floorY !== undefined) this.buildTerrain(arena.bounds.radius, arena.bounds.floorY, root);

    } else {
      // Box arena: six translucent walls matching the sim's finite y bounds.
      const { width, height, verticalExtent } = arena.bounds;
      const mat = new StandardMaterial("mat.boundsRect", this.scene);
      mat.diffuseColor = Color3.Black();
      mat.emissiveColor = new Color3(1.0, 0.5, 0.2);
      mat.alpha = 0.08;
      const thickness = 0.6;
      const walls: Array<[number, number, number, number, number, number]> = [
        [0, 0, height / 2, width, verticalExtent, thickness],
        [0, 0, -height / 2, width, verticalExtent, thickness],
        [width / 2, 0, 0, thickness, verticalExtent, height],
        [-width / 2, 0, 0, thickness, verticalExtent, height],
        [0, verticalExtent / 2, 0, width, thickness, height],
        [0, -verticalExtent / 2, 0, width, thickness, height],
      ];
      for (const [x, y, z, w, h, d] of walls) {
        const seg = MeshBuilder.CreateBox("boundsRectSeg", { width: w, height: h, depth: d }, this.scene);
        seg.position.set(x, y, z);
        seg.material = mat;
        seg.isPickable = false;
        seg.parent = root;
      }
    }
  }

  /**
   * Update the boundary shield from the local player's position. Returns the
   * signed distance to the nearest boundary (positive inside) so the HUD can
   * drive its independently latched warning without recomputing geometry.
   */
  updatePlayerPosition(x: number, y: number, z: number): number {
    // The dust box rides the player's follow point — the chase camera orbits a
    // few units off it, so a 120-unit box centred here contains the camera and
    // everything it can see up close, which is the only place motes read at all.
    this.dust?.setCenter(x, y, z);
    const arena = this.arena;
    if (!arena) return Number.POSITIVE_INFINITY;
    const bounds = arena.bounds;
    // Warnings and shield glow describe the enclosing shell only. The simulation
    // still owns floor collision/damage, but visible terrain needs no HUD alarm.
    const distance =
      bounds.shape === "sphere"
        ? bounds.radius - Math.hypot(x, y, z)
        : Math.min(
            bounds.width / 2 - Math.abs(x),
            bounds.verticalExtent / 2 - Math.abs(y),
            bounds.height / 2 - Math.abs(z),
          );
    const shield = arena.render?.boundaryShield;
    const material = this.boundaryMaterial;
    if (!shield || !material) return distance;

    const renderParams = boundaryShieldRenderParams(
      shield.hexDensity,
      boundaryShieldOpacity(distance, shield.glowStartDistance, shield.baseOpacity),
    );
    const redMix = boundaryShieldRedMix(distance, shield.redTransitionDistance);
    Color3.LerpToRef(this.boundaryBlue, this.boundaryRed, redMix, this.boundaryColor);
    clampColorInPlace(this.boundaryColor);
    if (material instanceof ShaderMaterial) {
      material.setFloat("opacity", renderParams.opacity);
      material.setFloat("hexDensity", renderParams.hexDensity);
      material.setColor3("shieldColor", this.boundaryColor);
    } else {
      material.alpha = renderParams.opacity;
      material.emissiveColor.copyFrom(this.boundaryColor);
      clampColorInPlace(material.emissiveColor);
    }
    return distance;
  }

  /** Build deterministic, diffuse-lit lunar regolith at the collision floor. */
  private buildTerrain(radius: number, floorY: number, root: TransformNode): void {
    // A small overshoot closes the numerical seam where terrain meets the shell.
    const terrainRadius = Math.sqrt(Math.max(0, radius ** 2 - floorY ** 2)) * 1.005;
    const lowTier = !this.quality.scene.boundaryShieldShader;
    const rings = lowTier ? 24 : 40;
    const segments = lowTier ? 72 : 112;
    const floor = createTerrainDisc(this.scene, terrainRadius, rings, segments);
    floor.name = "terrainGround";
    floor.position.y = floorY;
    floor.isPickable = false;
    floor.parent = root;

    const material = new StandardMaterial("mat.terrainRegolith", this.scene);
    material.diffuseColor = new Color3(0.52, 0.51, 0.49);
    material.emissiveColor = Color3.Black();
    material.specularColor = new Color3(0.015, 0.015, 0.015);
    material.specularPower = 4;
    const textureSize = lowTier ? 256 : 1024;
    const textures = createRegolithTextures(this.scene, textureSize, !lowTier && this.quality.scene.skyboxEnabled);
    if (textures) {
      material.diffuseTexture = textures.albedo;
      material.diffuseTexture.hasAlpha = true;
      material.useAlphaFromDiffuseTexture = true;
      if (textures.normal) {
        material.bumpTexture = textures.normal;
        material.bumpTexture.level = 0.75;
      }
    }
    material.backFaceCulling = false;
    floor.material = material;
  }

  /** Stable authored warning knobs for the active arena; no per-frame object. */
  get boundaryWarning(): ArenaRender["boundaryShield"] | null {
    return this.arena?.render?.boundaryShield ?? null;
  }

  /**
   * The arena `GlowLayer`, created/disposed and tuned per quality tier. Measured
   * on the practice-bots arena: enabling it roughly **doubles** the frame's draw
   * calls (47 → 24 with it off), because every emissive submesh is re-rendered
   * into the blur target. It is the first thing the low tier drops.
   */
  private applyGlowQuality(): void {
    const glow = this.quality.glow;
    if (!glow.enabled) {
      this.glowLayer?.dispose();
      this.glowLayer = null;
      return;
    }
    if (!this.glowLayer) {
      this.glowLayer = new GlowLayer(
        "arenaGlow",
        this.scene,
        glow.blurKernelSize === undefined ? undefined : { blurKernelSize: glow.blurKernelSize },
      );
    }
    this.glowLayer.intensity = glow.intensity;
    if (this.skybox) this.glowLayer.addExcludedMesh(this.skybox);
  }

  /**
   * The invisible `y = 0` plane the dev Map editor picks against when placing
   * asteroids (`MapEditor.ts` matches it by name). All that survives of the old
   * ground: the faint grid disc that used to sit on it retired with the floor
   * (BUBBLE.md §C — ships fly through the whole bubble, so a disc at y=0 was a
   * lie about the play space) and the spatial reference it gave moved onto the
   * bounds shell.
   *
   * It stays part of the arena rather than the editor's own stage because the
   * editor authors placements in ARENA coordinates and needs the plane sized to
   * whichever arena is loaded.
   */
  private buildPickPlane(arena: ArenaConfig, root: TransformNode): void {
    const size = boundsRadiusOf(arena) * 2.1;
    const ground = MeshBuilder.CreateGround("groundPlane", { width: size, height: size }, this.scene);
    ground.isVisible = false;
    ground.isPickable = true;
    ground.parent = root;
  }

  private buildSpawnMarkers(arena: ArenaConfig, root: TransformNode): void {
    const material0 = new StandardMaterial("mat.spawnTeam0", this.scene);
    material0.emissiveColor = TEAM_COLORS[0] ?? Color3.Blue();
    material0.diffuseColor = Color3.Black();
    const material1 = new StandardMaterial("mat.spawnTeam1", this.scene);
    material1.emissiveColor = TEAM_COLORS[1] ?? Color3.Red();
    material1.diffuseColor = Color3.Black();

    for (const sp of arena.spawnPoints) {
      const disc = MeshBuilder.CreateDisc(`spawnMarker.${sp.id}`, { radius: 2, tessellation: 24 }, this.scene);
      disc.rotation.x = Math.PI / 2;
      // Authored altitude (BUBBLE.md §E gives spawns a `y`), nudged clear of the
      // exact spawn point so the marker never z-fights the hull sitting on it.
      disc.position.set(sp.position.x, (sp.position.y ?? 0) + 0.05, sp.position.z);
      disc.material = sp.team === 0 ? material0 : material1;
      disc.isPickable = false;
      disc.parent = root;
    }
  }

  private clearSubscriptions(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private disposeSceneNodes(): void {
    this.skyboxMaterialReadyToFreeze = null;
    this.skybox = null;
    if (this.root) {
      disposeRecursive(this.root);
      this.root = null;
    }
    // Not under `arenaRoot` (see buildDust), so it needs its own teardown.
    this.dust?.dispose();
    this.dust = null;
    this.boundaryMaterial = null;
  }

  /** Full teardown: subscriptions, scene nodes, glow layer, and cached asset masters. */
  dispose(): void {
    this.generation++;
    this.clearSubscriptions();
    this.disposeSceneNodes();
    this.glowLayer?.dispose();
    this.glowLayer = null;
  }
}

/** Concentric-ring mesh gives the terrain real interior vertices (unlike CreateDisc's fan). */
function createTerrainDisc(scene: Scene, radius: number, rings: number, segments: number): Mesh {
  const mesh = new Mesh("terrainGround", scene);
  const positions: number[] = [0, terrainHeight(0, 0, radius), 0];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];
  for (let ring = 1; ring <= rings; ring++) {
    const r = (ring / rings) * radius;
    for (let segment = 0; segment < segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      positions.push(x, terrainHeight(x, z, radius), z);
      uvs.push(x / (radius * 2) + 0.5, z / (radius * 2) + 0.5);
    }
  }
  for (let segment = 0; segment < segments; segment++) {
    indices.push(0, 1 + segment, 1 + ((segment + 1) % segments));
  }
  for (let ring = 2; ring <= rings; ring++) {
    const inner = 1 + (ring - 2) * segments;
    const outer = 1 + (ring - 1) * segments;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      indices.push(inner + segment, outer + segment, outer + next, inner + segment, outer + next, inner + next);
    }
  }
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  mesh.setIndices(indices);
  return mesh;
}

/** Gentle deterministic relief; edge returns to the collision plane at the horizon. */
function terrainHeight(x: number, z: number, radius: number): number {
  const radial = Math.hypot(x, z) / radius;
  const edgeTaper = Math.max(0, Math.min(1, (1 - radial) * 8));
  const broad = valueNoise(x * 0.025, z * 0.025, 0x51f15e) * 1.35;
  const fine = valueNoise(x * 0.085, z * 0.085, 0xa17e3) * 0.55;
  return (broad + fine) * edgeTaper;
}

interface RegolithTextures {
  albedo: DynamicTexture;
  normal: DynamicTexture | null;
}

/** Canvas textures: layered grain/mottling plus crater floors and raised rims. */
function createRegolithTextures(scene: Scene, size: number, includeNormal: boolean): RegolithTextures | null {
  try {
    const albedo = new DynamicTexture("terrain.regolith.albedo", { width: size, height: size }, scene, false);
    const albedoContext = albedo.getContext();
    const albedoImage = albedoContext.getImageData(0, 0, size, size);
    const normal = includeNormal
      ? new DynamicTexture("terrain.regolith.normal", { width: size, height: size }, scene, false)
      : null;
    const normalContext = normal?.getContext() ?? null;
    const normalImage = normalContext?.getImageData(0, 0, size, size) ?? null;
    const heights = normalImage ? new Float32Array(size * size) : null;
    const craters = makeCraters(0xc0ffee, size >= 512 ? 52 : 34);

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const u = px / (size - 1);
        const v = py / (size - 1);
        const grain = valueNoise(u * 170, v * 170, 0x8d12) * 0.022;
        const fine = valueNoise(u * 68, v * 68, 0x61ea) * 0.032;
        const medium = valueNoise(u * 25, v * 25, 0x4ab3) * 0.045;
        const broad = valueNoise(u * 7, v * 7, 0x912f) * 0.052;
        let height = grain * 0.5 + fine * 0.7 + medium * 0.65 + broad * 0.35;
        let shade = grain + fine + medium + broad;
        for (const crater of craters) {
          const d = Math.hypot(u - crater.x, v - crater.y) / crater.radius;
          if (crater.radius > 0.07 && d >= 1 && d < 3.8) {
            const angle = Math.atan2(v - crater.y, u - crater.x);
            const rays = Math.max(0, Math.cos(angle * 11 + crater.x * 37));
            const ray = rays ** 10 * (1 - (d - 1) / 2.8) * crater.depth;
            shade += ray * 0.22;
          }
          if (d < 1) {
            const floor = (1 - Math.min(1, d / 0.72)) * crater.depth;
            const rim = Math.exp(-((d - 0.86) ** 2) / 0.006) * crater.depth * 1.15;
            height += rim - floor;
            shade += rim * 0.65 - floor * 0.75;
          }
        }
        const radial = Math.hypot(u - 0.5, v - 0.5) * 2;
        const edgeAlpha = Math.max(0, Math.min(1, (1 - radial) * 16));
        const base = Math.max(0.27, Math.min(0.61, 0.445 + shade));
        const i = (py * size + px) * 4;
        albedoImage.data[i] = Math.round(base * 255);
        albedoImage.data[i + 1] = Math.round(base * 0.985 * 255);
        albedoImage.data[i + 2] = Math.round(base * 0.955 * 255);
        albedoImage.data[i + 3] = Math.round(edgeAlpha * 255);
        if (heights) heights[py * size + px] = height;
      }
    }
    albedoContext.putImageData(albedoImage, 0, 0);
    albedo.update(false);
    if (normal && normalContext && normalImage && heights) {
      const sample = (x: number, y: number): number => heights[Math.max(0, Math.min(size - 1, y)) * size + Math.max(0, Math.min(size - 1, x))]!;
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const sx = (sample(px + 1, py) - sample(px - 1, py)) * 5.5;
          const sy = (sample(px, py + 1) - sample(px, py - 1)) * 5.5;
          const invLength = 1 / Math.hypot(sx, sy, 1);
          const i = (py * size + px) * 4;
          normalImage.data[i] = Math.round((-sx * invLength * 0.5 + 0.5) * 255);
          normalImage.data[i + 1] = Math.round((sy * invLength * 0.5 + 0.5) * 255);
          normalImage.data[i + 2] = Math.round(invLength * 255);
          normalImage.data[i + 3] = 255;
        }
      }
      normalContext.putImageData(normalImage, 0, 0);
      normal.update(false);
    }
    return { albedo, normal };
  } catch {
    // NullEngine and other canvas-less hosts still get lit geometry/material.
    return null;
  }
}

function makeCraters(seed: number, count: number): Array<{ x: number; y: number; radius: number; depth: number }> {
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: count }, (_, index) => ({
    x: random(),
    y: random(),
    radius: (index < 5 ? 0.055 : 0.012) + random() * (index < 5 ? 0.09 : 0.038),
    depth: 0.035 + random() * 0.075,
  }));
}

/** Smooth deterministic value noise in [-1, 1]. */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = (x - x0) ** 2 * (3 - 2 * (x - x0));
  const ty = (y - y0) ** 2 * (3 - 2 * (y - y0));
  const hash = (ix: number, iy: number): number => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 0xffff_ffff * 2 - 1;
  };
  const a = hash(x0, y0) * (1 - tx) + hash(x0 + 1, y0) * tx;
  const b = hash(x0, y0 + 1) * (1 - tx) + hash(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}

function disposeRecursive(node: Node): void {
  for (const child of [...node.getChildren()]) {
    disposeRecursive(child);
  }
  if (node instanceof Mesh) {
    // A frozen material refuses to dispose its effect cleanly — thaw first.
    node.material?.unfreeze();
    node.material?.dispose(false, true);
  }
  node.dispose();
}

const BOUNDARY_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void) {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

/** Exported for a source-contract regression test; compiled verbatim by Babylon. */
export const BOUNDARY_FRAGMENT = `
precision highp float;
varying vec2 vUV;
uniform vec3 shieldColor;
uniform float opacity;
uniform float hexDensity;
void main(void) {
  // Mesh UV is interpolated in a unit domain. Wrap before scaling so arena
  // radius/world translation never enters fract/floor; density is bounded so
  // every periodic operand remains <= 256 even after a malformed live update.
  vec2 unitDomain = fract(vUV);
  float safeDensity = clamp(hexDensity, ${BOUNDARY_HEX_DENSITY_MIN.toFixed(1)}, ${BOUNDARY_HEX_DENSITY_MAX.toFixed(1)});
  vec2 p = unitDomain * vec2(safeDensity * 2.0, safeDensity);
  p.x += mod(floor(p.y), 2.0) * 0.5;
  vec2 cell = abs(fract(p) - 0.5);
  float hexEdge = max(cell.y, cell.x * 0.8660254 + cell.y * 0.5);
  float line = smoothstep(0.40, 0.49, hexEdge);
  float safePattern = clamp(0.18 + line * 0.82, 0.0, 1.0);
  float safeOpacity = clamp(opacity, 0.0, 1.0);
  // Apply proximity opacity last. A broken pattern result cannot exceed it.
  gl_FragColor = vec4(clamp(shieldColor, 0.0, 1.0), safePattern * safeOpacity);
}`;

function createBoundaryShader(scene: Scene): ShaderMaterial {
  const material = new ShaderMaterial(
    "mat.boundsShell.hex",
    scene,
    { vertexSource: BOUNDARY_VERTEX, fragmentSource: BOUNDARY_FRAGMENT },
    {
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "shieldColor", "opacity", "hexDensity"],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  return material;
}

/** Component-wise finite [0,1] clamp shared by shader uniforms and fallback emissive. */
function clampColorInPlace(color: Color3): void {
  color.r = Number.isFinite(color.r) ? Math.min(1, Math.max(0, color.r)) : 0;
  color.g = Number.isFinite(color.g) ? Math.min(1, Math.max(0, color.g)) : 0;
  color.b = Number.isFinite(color.b) ? Math.min(1, Math.max(0, color.b)) : 0;
}

/**
 * An authored `sun.dir` as a unit `Vector3`, or `null` for a degenerate vector.
 * The schema already rejects a non-unit direction, so this is the belt to that
 * brace: a zero-length direction would make the key light point nowhere, and the
 * arena would silently render with ambient only.
 */
function normalizedOrNull(dir: readonly [number, number, number]): Vector3 | null {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  return new Vector3(dir[0] / length, dir[1] / length, dir[2] / length);
}

/** Whether two tiers' dust blocks would produce the same particle system. */
function sameDust(a: SceneQuality["scene"]["dust"], b: SceneQuality["scene"]["dust"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.count === b.count &&
    a.size === b.size &&
    a.alpha === b.alpha &&
    a.driftSpeed === b.driftSpeed &&
    a.boxSize === b.boxSize
  );
}

/** Depth-first walk over every `Mesh` under `node` (inclusive). */
function forEachMesh(node: Node, visit: (mesh: Mesh) => void): void {
  if (node instanceof Mesh) visit(node);
  for (const child of node.getChildren()) forEachMesh(child, visit);
}
