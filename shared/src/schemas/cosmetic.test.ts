import { describe, expect, it } from "vitest";
import { ConfigService } from "../core/ConfigService.js";
import {
  cosmeticAppliesTo,
  cosmeticDisplayName,
  cosmeticSchema,
  cosmeticSwatch,
  baseCosmeticIdFor,
  isTextureSkin,
  skinEmissiveFor,
  skinSwapsAnyTexture,
  skinTextureFor,
  type CosmeticConfig,
} from "./cosmetic.js";
import { shipEmissiveGap, type ShipSkinWiring } from "./skin.js";

const VALID = {
  id: "cosmetic.paint-fixture",
  type: "cosmetic",
  version: 1,
  name: "Fixture Paint",
  kind: "paint",
  price: 0,
  target: "ship.interceptor",
  elements: {
    body: { color: "#112233", finish: { gloss: 0.7, glow: 0.2 } },
    wings: { color: "#445566" },
    propulsion: { effect: "fx.engine-trail" },
  },
};

/** The `elements` sub-object, for mutating one element in a `parses` callback. */
function body(draft: Record<string, unknown>): Record<string, unknown> {
  return (draft.elements as Record<string, Record<string, unknown>>).body!;
}

function parses(mutate: (draft: Record<string, unknown>) => void): boolean {
  const draft = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
  mutate(draft);
  return cosmeticSchema.safeParse(draft).success;
}

describe("cosmetic schema", () => {
  it("accepts the canonical shape", () => {
    expect(cosmeticSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects a colour that is not #rrggbb", () => {
    expect(parses((d) => (body(d).color = "red"))).toBe(false);
    expect(parses((d) => (body(d).color = "#fff"))).toBe(false);
    expect(parses((d) => (body(d).patternColor = "#12345g"))).toBe(false);
    expect(parses((d) => (body(d).color = "rgba(1,2,3,1)"))).toBe(false);
  });

  it("keeps every part of an element optional — a blank element is legal", () => {
    expect(parses((d) => (d.elements = {}))).toBe(true);
    expect(parses((d) => (d.elements = { canopy: {} }))).toBe(true);
    // ...but a named element that is not one of the five is not.
    expect(parses((d) => (d.elements = { fuselage: { color: "#112233" } }))).toBe(false);
  });

  it("bounds the finish knobs to 0..1 so a typo cannot make a hull a light source", () => {
    expect(parses((d) => (body(d).finish = { glow: 1 }))).toBe(true);
    expect(parses((d) => (body(d).finish = { glow: 4 }))).toBe(false);
    expect(parses((d) => (body(d).finish = { gloss: -0.1 }))).toBe(false);
  });

  it("takes a texture and an effect only as config ids", () => {
    expect(parses((d) => (body(d).texture = "texture.hull-plate-rough"))).toBe(true);
    expect(parses((d) => (body(d).texture = "textures/plate.jpg"))).toBe(false);
    expect(parses((d) => ((d.elements as Record<string, unknown>).propulsion = { effect: "not an id" }))).toBe(false);
  });

  it("rejects a negative or fractional price", () => {
    expect(parses((d) => (d.price = -1))).toBe(false);
    expect(parses((d) => (d.price = 12.5))).toBe(false);
    expect(parses((d) => (d.price = 250))).toBe(true); // the economy is off, not absent
  });

  it("rejects an unknown kind and a missing target", () => {
    expect(parses((d) => (d.kind = "decal"))).toBe(false);
    expect(parses((d) => delete d.target)).toBe(false);
  });

  it("falls back to the id slug when no name is authored", () => {
    expect(parses((d) => delete d.name)).toBe(true);
    expect(cosmeticDisplayName({ id: "cosmetic.paint-void" })).toBe("paint-void");
    expect(cosmeticDisplayName({ id: "cosmetic.paint-void", name: "Void Runner" })).toBe("Void Runner");
  });
});

describe("cosmeticAppliesTo", () => {
  const interceptor = cosmeticSchema.parse(VALID) as CosmeticConfig;
  const brawler = cosmeticSchema.parse({ ...VALID, target: "ship.brawler" }) as CosmeticConfig;

  it("accepts only the single target hull", () => {
    expect(cosmeticAppliesTo(interceptor, "ship.interceptor")).toBe(true);
    expect(cosmeticAppliesTo(brawler, "ship.brawler")).toBe(true);
    expect(cosmeticAppliesTo(brawler, "ship.interceptor")).toBe(false);
  });
});

describe("cosmetic references", () => {
  it("fails the pack load when target names an item that does not exist", async () => {
    const files: Record<string, unknown> = {
      "manifest.json": { id: "manifest.t", type: "manifest", version: 1, files: ["cosmetics/bad.json"] },
      "cosmetics/bad.json": { ...VALID, id: "cosmetic.paint-bad", target: "ship.does-not-exist" },
    };
    const service = new ConfigService((rel) => Promise.resolve(files[rel]));
    const result = await service.load("manifest.json");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "target")).toBe(true);
  });
});

describe("shop swatch", () => {
  it("takes the first authored colour and the first DIFFERING one", () => {
    expect(cosmeticSwatch(cosmeticSchema.parse(VALID))).toEqual({
      primary: "#112233",
      accent: "#445566",
      glow: "#112233",
    });
  });

  it("lights the glow corner only when an element self-illuminates", () => {
    const dull = cosmeticSchema.parse({ ...VALID, elements: { body: { color: "#112233" } } });
    expect(cosmeticSwatch(dull).glow).toBeUndefined();
  });

  it("still fills a card for a skin that authors no colour at all", () => {
    // A texture-only skin is legal, and a swatch with no fill looks broken
    // rather than subtle — so it gets the neutral, not an empty string.
    const textured = cosmeticSchema.parse({ ...VALID, elements: { body: { texture: "texture.plate" } } });
    expect(cosmeticSwatch(textured).primary).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("base paint ids", () => {
  it("derive the canonical hull-scoped standard id", () => {
    expect(baseCosmeticIdFor("ship.interceptor")).toBe("cosmetic.paint-interceptor-standard");
  });
});

// ------------------------------------------------- kind: "skin" (current) ----

const PACK = {
  id: "cosmetic.skin-talon-ash",
  type: "cosmetic",
  version: 1,
  name: "Ash",
  kind: "skin",
  price: 0,
  target: "ship.interceptor",
  textures: {
    body: "ships/textures/talon/ash/body.png",
    emissive: "ships/textures/talon/ash/emissive.png",
  },
};

function parsesSkin(mutate: (draft: Record<string, unknown>) => void): boolean {
  const draft = JSON.parse(JSON.stringify(PACK)) as Record<string, unknown>;
  mutate(draft);
  return cosmeticSchema.safeParse(draft).success;
}

/** The `textures` block, for mutating one element in a `parsesSkin` callback. */
function pack(draft: Record<string, unknown>): Record<string, unknown> {
  return draft.textures as Record<string, unknown>;
}

describe("texture skins", () => {
  it("accepts a pack of authored images", () => {
    const parsed = cosmeticSchema.parse(PACK);
    expect(isTextureSkin(parsed)).toBe(true);
    expect(skinTextureFor(parsed, "body")).toBe("ships/textures/talon/ash/body.png");
    expect(skinTextureFor(parsed, "wings")).toBeUndefined();
  });

  it("accepts an EMPTY pack — a skin is scaffolded before it is painted", () => {
    expect(parsesSkin((d) => (d.textures = {}))).toBe(true);
    expect(parsesSkin((d) => delete d.textures)).toBe(true);
  });

  it("takes a content-relative image path, never a config id or an absolute one", () => {
    expect(parsesSkin((d) => (pack(d).body = "ships/textures/t/a/body.webp"))).toBe(true);
    expect(parsesSkin((d) => (pack(d).body = "texture.hull-plate-rough"))).toBe(false);
    expect(parsesSkin((d) => (pack(d).body = "/ships/textures/t/a/body.png"))).toBe(false);
    // Every asset path in the pack is relative to content/; the prefix is the
    // mistake that keeps slipping past the reachability sweep.
    expect(parsesSkin((d) => (pack(d).body = "content/ships/textures/t/a/body.png"))).toBe(false);
    expect(parsesSkin((d) => (pack(d).body = "ships/textures/t/a/body.glb"))).toBe(false);
  });

  it("rejects an element that is not one of the four surfaces", () => {
    expect(parsesSkin((d) => (pack(d).propulsion = "ships/textures/t/a/x.png"))).toBe(false);
    expect(parsesSkin((d) => (pack(d).fuselage = "ships/textures/t/a/x.png"))).toBe(false);
  });

  it("keeps the two kinds from bleeding into each other", () => {
    // A texture skin authoring procedural colours would render as silence.
    expect(parsesSkin((d) => (d.elements = { body: { color: "#112233" } }))).toBe(false);
    // ...but propulsion is not a surface, and a texture skin may still swap it.
    expect(parsesSkin((d) => (d.elements = { propulsion: { effect: "fx.boost-trail" } }))).toBe(true);
    // And a legacy paint reads no textures at all.
    expect(parses((d) => ((d.textures as unknown) = { body: "ships/textures/t/a/body.png" }))).toBe(false);
    expect(parses((d) => (d.emissive = "ships/textures/t/a/lights.png"))).toBe(false);
  });

  it("gives a texture pack the neutral swatch rather than an invented hue", () => {
    const swatch = cosmeticSwatch(cosmeticSchema.parse(PACK));
    expect(swatch.primary).toBe(swatch.accent);
    expect(swatch.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(swatch.glow).toBeUndefined();
  });
});

describe("emissive light maps", () => {
  const hull: ShipSkinWiring = { body: ["HULL"], emissive: ["GLOW"], emissiveTexture: "ships/textures/t/standard/lights.png" };

  it("falls back to the HULL's map, because the lit plates are the model's", () => {
    const plain = cosmeticSchema.parse(PACK);
    expect(skinEmissiveFor(hull, plain)).toBe("ships/textures/t/standard/lights.png");
  });

  it("lets a livery relight the ship with its own", () => {
    const relit = cosmeticSchema.parse({ ...PACK, emissive: "ships/textures/t/ash/lights.png" });
    expect(skinEmissiveFor(hull, relit)).toBe("ships/textures/t/ash/lights.png");
  });

  it("answers the HULL's map for anything that authors none — including a paint", () => {
    // The question is "what lights this hull under this livery", so a legacy
    // paint (which lights plates with `finish.glow`, never with a map) answers
    // the hull's own. The runtime never asks: it gates on kind first, so a
    // paint's materials are untouched either way.
    expect(skinEmissiveFor(hull, cosmeticSchema.parse(VALID))).toBe("ships/textures/t/standard/lights.png");
    expect(skinEmissiveFor(undefined, cosmeticSchema.parse(VALID))).toBeUndefined();
    expect(skinEmissiveFor(undefined, undefined)).toBeUndefined();
  });

  it("names the gap rather than failing the load", () => {
    expect(shipEmissiveGap(hull)).toBeNull();
    expect(shipEmissiveGap({ body: ["HULL"], emissive: ["GLOW"] })).toBe("unpainted");
    expect(shipEmissiveGap({ body: ["HULL"] })).toBe("unwired");
    expect(shipEmissiveGap(undefined)).toBe("unwired");
  });
});

describe("whether a texture skin is worth a painted master", () => {
  const parsed = (over: Record<string, unknown> = {}): CosmeticConfig =>
    cosmeticSchema.parse({ ...PACK, ...over }) as CosmeticConfig;

  it("needs BOTH sides: the hull wires the element and the skin paints it", () => {
    expect(skinSwapsAnyTexture({ body: ["HULL"] }, parsed())).toBe(true);
    // Wired to nothing: the images have nowhere to land.
    expect(skinSwapsAnyTexture({ wings: ["WING"] }, parsed())).toBe(false);
    // Wired, but the skin authors nothing.
    expect(skinSwapsAnyTexture({ body: ["HULL"] }, parsed({ textures: {} }))).toBe(false);
  });

  it("counts the hull's own light map — an equipped livery must not darken the ship", () => {
    const hull: ShipSkinWiring = { emissive: ["GLOW"], emissiveTexture: "ships/textures/t/standard/lights.png" };
    expect(skinSwapsAnyTexture(hull, parsed({ textures: {} }))).toBe(true);
  });

  it("is never true for a legacy paint — that path has its own gate", () => {
    expect(skinSwapsAnyTexture({ body: ["HULL"] }, cosmeticSchema.parse(VALID) as CosmeticConfig)).toBe(false);
  });
});
