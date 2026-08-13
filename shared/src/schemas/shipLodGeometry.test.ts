import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { shipSchema } from "./ship.js";

const CONTENT = resolve(fileURLToPath(new URL("../../../content", import.meta.url)));

async function triangles(model: string): Promise<number> {
  const doc = await new NodeIO().readBinary(await readFile(resolve(CONTENT, model)));
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      total += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0) / 3;
    }
  }
  return total;
}

describe("shipped ship LOD geometry budget", () => {
  it("has monotonic ladders and keeps ten combat-distance hulls below 110k triangles", async () => {
    const files = ["interceptor.json", "support.json", "brawler.json"];
    for (const file of files) {
      const ship = shipSchema.parse(JSON.parse(await readFile(resolve(CONTENT, "ships", file), "utf8")));
      const lods = ship.render.lods ?? [];
      expect(lods.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < lods.length; i++) expect(lods[i]!.distance).toBeGreaterThan(lods[i - 1]!.distance);
      expect(await triangles(lods[1]!.model) * 10).toBeLessThanOrEqual(110_000);
    }
  });
});
