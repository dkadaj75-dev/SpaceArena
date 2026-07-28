import { describe, expect, it } from "vitest";
import { moduleSchema } from "./module.js";

const MODULE = {
  id: "module.render-test",
  type: "module",
  version: 1,
  name: "Render Test",
  family: "utility",
  level: 1,
  activation: { deployTime: 0, retractTime: 0 },
  energy: { drawIdle: 0, drawActive: 0 },
  heat: {
    perSecondActive: 0,
    overheatThreshold: 1,
    overheatCooldown: 0,
    overheatSelfDamage: 0,
  },
  ui: { icon: "[ICON: utility]", label: "Test" },
  price: 0,
  requiresLevel: 1,
} as const;

describe("module render schema", () => {
  it("round-trips the shared render recipe shape", () => {
    const render = {
      recipe: "procedural.module.utility",
      palette: { primary: "#334455", accent: "#88ccff" },
      model: "modules/utility/test.glb",
      modelScale: 1.75,
      modelRotationY: Math.PI / 2,
    };
    expect(moduleSchema.parse({ ...MODULE, render }).render).toEqual(render);
  });

  it("keeps render optional for every existing procedural module", () => {
    expect(moduleSchema.parse(MODULE).render).toBeUndefined();
  });
});
