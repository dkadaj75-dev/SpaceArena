import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { musicSchema, themeSchema } from "./theme.js";

describe("theme music schema", () => {
  it("validates tracks, trims, licenses, fades, and nullable screen mappings", () => {
    expect(musicSchema.safeParse({
      enabled: true,
      defaultVolume: 0.5,
      fadeInSec: 1,
      fadeOutSec: 1,
      tracks: {
        menu: { src: "content/sounds/menu.mp3", volume: 0.75, loop: true, license: "licensed" },
      },
      screens: { boot: "menu", menu: "menu", hangar: "menu", shop: null, match: null },
    }).success).toBe(true);
  });

  it("rejects out-of-range levels and negative fades", () => {
    expect(musicSchema.safeParse({ defaultVolume: 1.1 }).success).toBe(false);
    expect(musicSchema.safeParse({ fadeOutSec: -1 }).success).toBe(false);
    expect(musicSchema.safeParse({ tracks: { bad: { src: "x.mp3", volume: -0.1 } } }).success).toBe(false);
  });

  it("ships a valid default theme with both routed placeholder tracks", () => {
    const path = fileURLToPath(new URL("../../../content/themes/default.json", import.meta.url));
    const parsed = themeSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.audio?.music?.screens).toMatchObject({
      boot: "main-menu", menu: "main-menu", hangar: "main-menu", shop: "main-menu", match: "arenas",
    });
    expect(Object.keys(parsed.data.audio?.music?.tracks ?? {})).toEqual(["main-menu", "arenas"]);
  });
});
