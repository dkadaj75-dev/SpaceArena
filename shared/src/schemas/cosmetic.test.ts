import { describe, expect, it } from "vitest";
import { ConfigService } from "../core/ConfigService.js";
import {
  cosmeticAppliesTo,
  cosmeticDisplayName,
  cosmeticSchema,
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
  paint: { primary: "#112233", accent: "#445566", emissive: "#778899" },
};

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
    expect(parses((d) => ((d.paint as Record<string, unknown>).primary = "red"))).toBe(false);
    expect(parses((d) => ((d.paint as Record<string, unknown>).primary = "#fff"))).toBe(false);
    expect(parses((d) => ((d.paint as Record<string, unknown>).accent = "#12345g"))).toBe(false);
    expect(parses((d) => ((d.paint as Record<string, unknown>).emissive = "rgba(1,2,3,1)"))).toBe(false);
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

describe("base paint ids", () => {
  it("derive the canonical hull-scoped standard id", () => {
    expect(baseCosmeticIdFor("ship.interceptor")).toBe("cosmetic.paint-interceptor-standard");
  });
});
