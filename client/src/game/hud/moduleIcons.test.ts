import { describe, expect, it } from "vitest";
import type { ModuleConfig } from "@space-arena/shared";
import {
  FALLBACK_ICON_ID,
  hasModuleIcon,
  iconIdFromRef,
  moduleIconId,
  moduleIconIds,
  moduleIconSvg,
} from "./moduleIcons.js";

type IconCfg = Pick<ModuleConfig, "family" | "ui">;

function cfg(family: ModuleConfig["family"], icon: string, iconId?: string): IconCfg {
  return { family, ui: iconId === undefined ? { icon, label: "X" } : { icon, iconId, label: "X" } };
}

describe("iconIdFromRef", () => {
  it("unwraps the authored placeholder form, the same way [SOUND: …] is unwrapped", () => {
    expect(iconIdFromRef("[ICON: laser]")).toBe("laser");
    expect(iconIdFromRef("[icon:heat-sink]")).toBe("heat-sink");
    expect(iconIdFromRef("  [ICON:  shield  ]  ")).toBe("shield");
  });

  it("accepts a bare id and resolves aliases", () => {
    expect(iconIdFromRef("missile")).toBe("missile");
    expect(iconIdFromRef("beam")).toBe("laser");
    expect(iconIdFromRef("afterburner")).toBe("boost");
  });

  it("refuses anything that is not a shipped id, so callers can fall through", () => {
    expect(iconIdFromRef("»")).toBeUndefined();
    expect(iconIdFromRef("")).toBeUndefined();
    expect(iconIdFromRef("[ICON: plasma-lance]")).toBeUndefined();
    expect(iconIdFromRef(undefined)).toBeUndefined();
  });
});

describe("moduleIconId", () => {
  it("resolves every shipped module's placeholder icon to a real glyph", () => {
    expect(moduleIconId(cfg("laser", "[ICON: laser]"))).toBe("laser");
    expect(moduleIconId(cfg("kinetic", "[ICON: kinetic]"))).toBe("kinetic");
    expect(moduleIconId(cfg("missile", "[ICON: missile]"))).toBe("missile");
    expect(moduleIconId(cfg("shield", "[ICON: shield]"))).toBe("shield");
    expect(moduleIconId(cfg("boost", "[ICON: boost]"))).toBe("boost");
    // The two utility modules share a family and are told apart ONLY by their
    // authored icon tag — which is why step 2 exists at all.
    expect(moduleIconId(cfg("utility", "[ICON: capacitor]"))).toBe("capacitor");
    expect(moduleIconId(cfg("utility", "[ICON: heat-sink]"))).toBe("heat-sink");
  });

  it("prefers an explicit ui.iconId over the family and the authored tag", () => {
    expect(moduleIconId(cfg("kinetic", "[ICON: kinetic]", "missile"))).toBe("missile");
  });

  it("falls back to the family when the icon reference means nothing to us", () => {
    expect(moduleIconId(cfg("shield", "🛡"))).toBe("shield");
    expect(moduleIconId(cfg("laser", ""))).toBe("laser");
  });

  it("falls back to the generic glyph for an unknown family or a missing config", () => {
    expect(moduleIconId(cfg("utility", "?"))).toBe(FALLBACK_ICON_ID);
    expect(moduleIconId(undefined)).toBe(FALLBACK_ICON_ID);
    // An unknown explicit override is a content bug — surfaced, not masked.
    expect(moduleIconId(cfg("laser", "[ICON: laser]", "plasma-lance"))).toBe(FALLBACK_ICON_ID);
  });
});

describe("moduleIconSvg", () => {
  it("returns drawable inline SVG for every shipped id", () => {
    for (const id of moduleIconIds()) {
      const svg = moduleIconSvg(id);
      expect(hasModuleIcon(id)).toBe(true);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain("<path");
      // currentColor is what lets one glyph carry every module-button state tint.
      expect(svg).toContain('stroke="currentColor"');
    }
  });

  it("draws the fallback glyph rather than nothing for an unknown id", () => {
    expect(moduleIconSvg("nope")).toBe(moduleIconSvg(FALLBACK_ICON_ID));
  });
});
