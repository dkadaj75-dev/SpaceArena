import { describe, expect, it } from "vitest";
import { ConfigService } from "../core/ConfigService.js";
import {
  cosmeticAppliesTo,
  cosmeticDisplayName,
  cosmeticSchema,
  STANDARD_COSMETIC_ID,
  type CosmeticConfig,
} from "./cosmetic.js";

const VALID = {
  id: "cosmetic.paint-fixture",
  type: "cosmetic",
  version: 1,
  name: "Fixture Paint",
  kind: "paint",
  price: 0,
  appliesTo: "any",
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

  it("rejects an unknown kind and an empty hull list", () => {
    expect(parses((d) => (d.kind = "decal"))).toBe(false);
    expect(parses((d) => (d.appliesTo = []))).toBe(false);
    expect(parses((d) => (d.appliesTo = ["ship.interceptor"]))).toBe(true);
  });

  it("falls back to the id slug when no name is authored", () => {
    expect(parses((d) => delete d.name)).toBe(true);
    expect(cosmeticDisplayName({ id: "cosmetic.paint-void" })).toBe("paint-void");
    expect(cosmeticDisplayName({ id: "cosmetic.paint-void", name: "Void Runner" })).toBe("Void Runner");
  });
});

describe("cosmeticAppliesTo", () => {
  const universal = cosmeticSchema.parse(VALID) as CosmeticConfig;
  const signature = cosmeticSchema.parse({ ...VALID, appliesTo: ["ship.brawler"] }) as CosmeticConfig;

  it("lets a universal paint on any hull and pins a signature paint to its own", () => {
    expect(cosmeticAppliesTo(universal, "ship.interceptor")).toBe(true);
    expect(cosmeticAppliesTo(signature, "ship.brawler")).toBe(true);
    expect(cosmeticAppliesTo(signature, "ship.interceptor")).toBe(false);
  });
});

describe("cosmetic references", () => {
  it("fails the pack load when appliesTo names a hull that does not exist", async () => {
    const files: Record<string, unknown> = {
      "manifest.json": { id: "manifest.t", type: "manifest", version: 1, files: ["cosmetics/bad.json"] },
      "cosmetics/bad.json": { ...VALID, id: "cosmetic.paint-bad", appliesTo: ["ship.does-not-exist"] },
    };
    const service = new ConfigService((rel) => Promise.resolve(files[rel]));
    const result = await service.load("manifest.json");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "appliesTo[0]")).toBe(true);
  });
});

describe("the standard paint", () => {
  it("is a real id, so a selection is never undefined semantics", () => {
    expect(STANDARD_COSMETIC_ID).toBe("cosmetic.paint-standard");
  });
});
