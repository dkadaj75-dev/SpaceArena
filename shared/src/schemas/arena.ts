import { z } from "zod";
import { baseShape } from "./base.js";
import { vec2, vec3 } from "./common.js";

/** Largest positive coordinate representable by the signed int16 deci wire. */
export const WIRE_POSITION_LIMIT = 3276.7;
/** Projectile cull overshoot used when tuning omits `projectileBoundsMargin`. */
export const DEFAULT_PROJECTILE_BOUNDS_MARGIN = 20;

export interface ArenaWireIssue {
  path: readonly (string | number)[];
  message: string;
}

/** Schema-local check: authored arena geometry itself must fit on the wire. */
export function arenaWireBoundsIssues(
  bounds:
    | { shape: "sphere"; radius: number; floorY?: number }
    | { shape: "rect"; width: number; height: number; verticalExtent: number }
    | { shape: "box"; width: number; height: number; floorY: number; ceilingY: number },
): ArenaWireIssue[] {
  if (bounds.shape === "sphere") {
    return bounds.radius > WIRE_POSITION_LIMIT
      ? [{
          path: ["bounds", "radius"],
          message: `radius must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
        }]
      : [];
  }
  const issues: ArenaWireIssue[] = [];
  const extents = bounds.shape === "box"
    ? [["width", bounds.width / 2], ["height", bounds.height / 2], ["floorY", Math.abs(bounds.floorY)], ["ceilingY", Math.abs(bounds.ceilingY)]] as const
    : [["width", bounds.width / 2], ["height", bounds.height / 2], ["verticalExtent", bounds.verticalExtent / 2]] as const;
  for (const [key, extent] of extents) {
    if (extent > WIRE_POSITION_LIMIT) {
      issues.push({
        path: ["bounds", key],
        message: `extent must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
      });
    }
  }
  return issues;
}

/**
 * Check every arena extent that replicated projectiles can reach. Kept separate
 * from the schema so pack validation can repeat it with an authored tuning
 * margin instead of the schema's documented default.
 */
export function arenaWireEnvelopeIssues(
  bounds:
    | { shape: "sphere"; radius: number; floorY?: number }
    | { shape: "rect"; width: number; height: number; verticalExtent: number }
    | { shape: "box"; width: number; height: number; floorY: number; ceilingY: number },
  margin: number,
): ArenaWireIssue[] {
  const issues: ArenaWireIssue[] = [];
  if (bounds.shape === "sphere") {
    if (bounds.radius + margin > WIRE_POSITION_LIMIT) {
      issues.push({
        path: ["bounds", "radius"],
        message: `radius plus projectile margin (${margin}) must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
      });
    }
  } else {
    const extents = bounds.shape === "box"
      ? [["width", bounds.width / 2], ["height", bounds.height / 2], ["floorY", Math.abs(bounds.floorY)], ["ceilingY", Math.abs(bounds.ceilingY)]] as const
      : [["width", bounds.width / 2], ["height", bounds.height / 2], ["verticalExtent", bounds.verticalExtent / 2]] as const;
    for (const [key, extent] of extents) {
      if (extent + margin > WIRE_POSITION_LIMIT) {
        issues.push({
          path: ["bounds", key],
          message: `half extent plus projectile margin (${margin}) must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
        });
      }
    }
  }
  return issues;
}

/**
 * Arena bounds. The planar `circle` is RETIRED (BUBBLE.md): ships fly in 3D, so
 * the play space is a **sphere** — a bubble of the same radius the circle had —
 * and every boundary/cull check works on 3D radial distance. A sphere may have
 * a `floorY` world-space plane in (-radius, 0], making its play space the dome
 * above that plane; floors above the sphere's centre are not supported. `rect`
 * survives for non-spherical fields as a bounded 3D box. `height` is its z
 * extent and `verticalExtent` is its y extent.
 */
export const arenaBounds = z
  .discriminatedUnion("shape", [
    z.object({ shape: z.literal("sphere"), radius: z.number().positive(), floorY: z.number().optional() }),
    z.object({
      shape: z.literal("rect"),
      width: z.number().positive(),
      height: z.number().positive(),
      verticalExtent: z.number().positive(),
    }),
    z.object({
      shape: z.literal("box"),
      width: z.number().positive(),
      height: z.number().positive(),
      floorY: z.number(),
      ceilingY: z.number(),
    }),
  ])
  .superRefine((bounds, ctx) => {
    if (bounds.shape === "sphere" && bounds.floorY !== undefined && (bounds.floorY <= -bounds.radius || bounds.floorY > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["floorY"],
        message: "floorY must be greater than -radius and at most 0",
      });
    }
    if (bounds.shape === "box" && bounds.ceilingY <= bounds.floorY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ceilingY"], message: "ceilingY must be greater than floorY" });
    }
  });
export type ArenaBounds = z.infer<typeof arenaBounds>;

const asteroidPlacement = z.object({
  /** References an `asteroid.*` config id. */
  asteroidId: z.string(),
  /** Bubble position; `y` omitted ⇒ 0 (the old ground plane). */
  position: vec3,
  rotation: z.number().optional(),
  scale: z.number().positive().optional(),
});

const propPlacement = z.object({
  propId: z.string(),
  position: vec3,
  rotation: z.object({ y: z.number().optional(), x: z.number().optional(), z: z.number().optional() }).optional(),
  scale: z.number().positive().optional(),
  locked: z.boolean().optional(),
});

const navGraph = z.object({
  nodes: z.array(z.object({ id: z.string(), position: vec3, hub: z.boolean().optional() })),
  links: z.array(z.tuple([z.string(), z.string()])),
});

const spawnPoint = z.object({
  id: z.string(),
  team: z.number().int().nonnegative(),
  /** Bubble position; `y` omitted ⇒ 0. */
  position: vec3,
  heading: z.number(),
  /** Initial nose elevation in radians; omitted ⇒ 0 (level). */
  pitch: z.number().gt(-Math.PI / 2).lt(Math.PI / 2).optional(),
});

/**
 * A team's flag base (owner 2026-07-31) — where that team's flag lives, where it
 * returns to, and the sphere a carrier must reach to score. Only capture-the-flag
 * gamemodes look at these; every other mode ignores them, so an arena may carry
 * bases and still be played as a deathmatch.
 */
const flagBase = z.object({
  id: z.string(),
  /** Owning team. Exactly one base per team is expected by the CTF rules. */
  team: z.number().int().nonnegative(),
  /** Bubble position of the flag stand; `y` omitted ⇒ 0. */
  position: vec3,
  /** Capture/return sphere radius, in world units. */
  radius: z.number().positive(),
});

/** Trigger-zone stub (fleshed out by Map Editor + Event Editor later). */
const zone = z.object({
  id: z.string(),
  shape: z.enum(["circle", "rect"]),
  position: vec2,
  radius: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

/**
 * Tolerance on `sun.dir`'s length. The field is documented as a UNIT vector
 * because the renderer negates it into a `DirectionalLight` direction, and an
 * authored typo (a dropped digit, a swapped axis) is much easier to catch here
 * than by squinting at which side of a rock is lit. Generous enough that hand-
 * authored three-decimal vectors — both shipped arenas land within 0.001 —
 * never trip it.
 */
export const SUN_DIR_UNIT_TOLERANCE = 0.02;

/** Length of an authored `sun.dir`, for the schema check and the renderer. */
export function sunDirLength(dir: readonly [number, number, number]): number {
  return Math.hypot(dir[0], dir[1], dir[2]);
}

/**
 * Arena-owned presentation. Sky imagery and the boundary shield both describe
 * this particular play space (including its physical radius), so they live
 * beside `bounds` rather than in the global theme or gameplay tuning.
 */
export const arenaRender = z.object({
  skybox: z.object({
    /** Content-relative equirectangular panorama, served from `/content/*`. */
    texture: z.string().min(1),
    /** Emissive multiplier applied to the panorama. */
    intensity: z.number().nonnegative(),
    /** RGB tint multiplied into the panorama. */
    tint: z.string().min(1),
    /**
     * The star PAINTED INTO the panorama, promoted to the arena's real key
     * light. Optional: an arena whose sky has no recognizable star keeps the
     * generic `lighting.directionalIntensity` rig instead.
     *
     * `dir` points FROM the arena TOWARD the star (a unit vector in world
     * space), so it is the same number an author can read off the panorama.
     * The renderer builds a parallel-ray `DirectionalLight` travelling along
     * `-dir`, which is what makes every lit face point back at the painted
     * star. `color`/`intensity` replace the default key light's.
     */
    sun: z
      .object({
        dir: z.tuple([z.number(), z.number(), z.number()]),
        color: z.string().min(1),
        intensity: z.number().nonnegative(),
      })
      .optional(),
  }),
  /**
   * A STAR hung in this arena's sky as real geometry — the same granulated,
   * corona'd body the main menu flies its hull against
   * (`theme.scene.starfield.star`), rendered by `game/starBillboard` from one
   * shared shader (owner request 2026-08-21, "Parker Point").
   *
   * Distinct from `skybox.sun`, and the two are complementary: `skybox.sun`
   * describes a star PAINTED INTO the panorama and promotes it to the key
   * light, whereas this DRAWS one. An arena whose backdrop feature is a near
   * star authors both — the billboard for the disc a pilot sees, the skybox
   * sun block (pointed the same way) for the light it casts.
   *
   * Omitted ⇒ no drawn star, which is every arena that shipped before this.
   */
  star: z
    .object({
      /**
       * Unit vector pointing FROM the arena TOWARD the star — the same
       * convention (and usually the same numbers) as `skybox.sun.dir`.
       */
      dir: z.tuple([z.number(), z.number(), z.number()]),
      /**
       * Angular size, as the fraction of the billboard's parking distance that
       * the DISC spans. It is an apparent size, so it is resolution- and
       * distance-independent: 0.5 is a disc roughly 28° across.
       */
      apparentSize: z.number().positive().max(4),
      /** Photosphere hot-cell colour. */
      core: z.string().min(1),
      /** Photosphere base/lane colour — the granulation reads as core vs shell. */
      shell: z.string().min(1),
      /** Corona and glare colour. */
      corona: z.string().min(1),
      /** Granulation/corona animation rate; 1 = the menu's. */
      speed: z.number().nonnegative().optional(),
    })
    .optional(),
  boundaryShield: z.object({
    /**
     * Opacity reached at the boundary. The shell is always fully transparent
     * at and beyond `glowStartDistance`.
     */
    baseOpacity: z.number().min(0).max(1),
    /** Distance inside the boundary where the shield begins brightening. */
    glowStartDistance: z.number().positive(),
    /** Distance inside the boundary where blue begins blending toward red. */
    redTransitionDistance: z.number().positive(),
    /** Distance inside the boundary that triggers the HUD warning. */
    warnDistance: z.number().positive(),
    blueColor: z.string().min(1),
    redColor: z.string().min(1),
    /** Number of procedural hex cells around the shield. */
    hexDensity: z.number().positive(),
    /** Fractional cell width of the glowing hex strokes. */
    hexLineWidth: z.number().min(0.002).max(0.08),
    /** Existing notification-pipeline config shown on first warning-zone entry. */
    warningNotification: z.string().min(1),
  }),
});
export type ArenaRender = z.infer<typeof arenaRender>;

export const arenaSchema = z
  .object({
    ...baseShape("arena"),
    bounds: arenaBounds,
    asteroidPlacements: z.array(asteroidPlacement),
    propPlacements: z.array(propPlacement).optional(),
    navGraph: navGraph.optional(),
    spawnPoints: z.array(spawnPoint).min(1),
    /**
     * Pads sit inside enclosing structures (hangar bays): every pad spawn runs
     * the launch sequence — 3-2-1-0 hold on the pad, then a sim-flown 50%%
     * throttle run out of the bay before control is handed over. Arenas with
     * open pads leave this off and spawn ships free immediately.
     */
    spawnLaunch: z.boolean().optional(),
    /** Per-team flag bases; required only by capture-the-flag gamemodes. */
    flagBases: z.array(flagBase).optional(),
    lighting: z
      .object({
        ambientColor: z.string().optional(),
        ambientIntensity: z.number().nonnegative().optional(),
        groundBounceColor: z.string().optional(),
        directionalIntensity: z.number().nonnegative().optional(),
      })
      .optional(),
    render: arenaRender.optional(),
    zones: z.array(zone).optional(),
  })
  .superRefine((arena, ctx) => {
    // The standalone schema owns only the intrinsic arena-coordinate limit.
    // Projectile headroom depends on the pack's authored tuning margin and is
    // therefore enforced by ConfigService's cross-config validation.
    for (const issue of arenaWireBoundsIssues(arena.bounds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issue.path],
        message: issue.message,
      });
    }

    arena.spawnPoints.forEach((spawn, index) => {
      const y = spawn.position.y ?? 0;
      const inside = arena.bounds.shape === "sphere"
          ? Math.hypot(spawn.position.x, y, spawn.position.z) <= arena.bounds.radius &&
            (arena.bounds.floorY === undefined || y >= arena.bounds.floorY)
          : arena.bounds.shape === "box"
            ? Math.abs(spawn.position.x) <= arena.bounds.width / 2 && Math.abs(spawn.position.z) <= arena.bounds.height / 2 && y >= arena.bounds.floorY && y <= arena.bounds.ceilingY
            : Math.abs(spawn.position.x) <= arena.bounds.width / 2 &&
            Math.abs(spawn.position.z) <= arena.bounds.height / 2 &&
            Math.abs(y) <= arena.bounds.verticalExtent / 2;
      if (!inside) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spawnPoints", index, "position"],
          message: "spawn position must be inside arena bounds",
        });
      }
    });

    if (arena.navGraph) {
      const ids = new Set<string>();
      arena.navGraph.nodes.forEach((node, index) => {
        if (ids.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["navGraph", "nodes", index, "id"], message: "nav node ids must be unique" });
        ids.add(node.id);
      });
      arena.navGraph.links.forEach((link, index) => {
        if (link[0] === link[1]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["navGraph", "links", index], message: "nav links must not be self-links" });
        for (let endpoint = 0; endpoint < 2; endpoint++) if (!ids.has(link[endpoint]!)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["navGraph", "links", index, endpoint], message: "nav link must reference an existing node id" });
        }
      });
    }

    const sun = arena.render?.skybox.sun;
    if (sun && Math.abs(sunDirLength(sun.dir) - 1) > SUN_DIR_UNIT_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["render", "skybox", "sun", "dir"],
        message: `sun direction must be a unit vector (length ${sunDirLength(sun.dir).toFixed(4)})`,
      });
    }

    const star = arena.render?.star;
    if (star && Math.abs(sunDirLength(star.dir) - 1) > SUN_DIR_UNIT_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["render", "star", "dir"],
        message: `star direction must be a unit vector (length ${sunDirLength(star.dir).toFixed(4)})`,
      });
    }

    const shield = arena.render?.boundaryShield;
    if (shield) {
      if (shield.redTransitionDistance > shield.glowStartDistance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["render", "boundaryShield", "redTransitionDistance"],
          message: "red transition distance must not exceed glow start distance",
        });
      }
      if (shield.warnDistance > shield.glowStartDistance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["render", "boundaryShield", "warnDistance"],
          message: "warning distance must not exceed glow start distance",
        });
      }
    }
  });

export type ArenaConfig = z.infer<typeof arenaSchema>;
