import { describe, expect, it } from "vitest";
import { ConfigService } from "../core/ConfigService.js";
import {
  cosmeticAppliesTo,
  cosmeticDisplayName,
  cosmeticSchema,
  cosmeticSwatch,
  baseCosmeticIdFor,
  type CosmeticConfig,
} from "./cosmetic.js";

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
