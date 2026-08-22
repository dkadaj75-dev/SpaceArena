import type { ModuleConfig } from "@space-arena/shared";

/**
 * The HUD's inline module-icon set.
 *
 * Module buttons used to render their config's `ui.icon` as literal text, which
 * meant a live match showed `[ICON: laser]` on every button — the placeholder
 * form content is *supposed* to carry until a real glyph exists (§ iron rule 5).
 * This file is that glyph: a handful of stroke-only SVGs, inlined in the bundle
 * (no sprite sheet, no font, no network request) and coloured entirely through
 * `currentColor`, so a button's state ring recolours its icon with it.
 *
 * Resolution is data-driven and never invents a glyph (see {@link moduleIconId}):
 *
 *   1. `ui.iconId` — an explicit designer override.
 *   2. the tag inside `ui.icon` — `[ICON: countermeasure]` → `countermeasure`, the same
 *      unwrapping `client/src/audio/soundIds.ts` does for `[SOUND: …]`. This is
 *      what makes the *shipped* content resolve with no re-authoring, and it is
 *      the only key that distinguishes the two `utility`-family modules.
 *   3. `family` — the honest structural key (`laser`, `kinetic`, `missile`,
 *      `shield`, `disruptor`, `repair`, `boost`, `utility`), so a brand-new module in a known family
 *      gets a sensible glyph before anyone authors an icon for it.
 *   4. {@link FALLBACK_ICON_ID} — a generic hardpoint glyph. A button is never
 *      blank and never shows raw placeholder text.
 */

/** Icon drawn when nothing else resolves. */
export const FALLBACK_ICON_ID = "module";

/**
 * Inner markup for each icon, on a 24x24 grid. Stroke-only and unfilled by
 * design: the CSS sets `stroke: currentColor`, so one glyph serves the
 * retracted/active/on-cooldown tints without a second asset.
 */
const ICON_PATHS: Readonly<Record<string, string>> = {
  /** Pulse laser / beam emitter: muzzle block firing right, with energy ticks. */
  laser:
    '<path d="M2.5 12h4.6"/>' +
    '<path d="M7.1 9h4.4l3.1 3-3.1 3H7.1z"/>' +
    '<path d="M15.4 12h6.1"/>' +
    '<path d="M17.6 9.7v4.6"/>' +
    '<path d="M20.2 10.7v2.6"/>',
  /** Autocannon: cased round with a pointed nose and a feed tick. */
  kinetic:
    '<path d="M2.5 9.4h6.6v5.2H2.5z"/>' +
    '<path d="M9.1 9.4h4.6l3.4 2.6-3.4 2.6H9.1z"/>' +
    '<path d="M19 12h2.5"/>' +
    '<path d="M5.8 16.9v3.1"/>',
  /** Seeker missile: finned body with a nose cone and an exhaust trail. */
  missile:
    '<path d="M2.5 12h4.2"/>' +
    '<path d="M6.7 9.5h6.6l4.4 2.5-4.4 2.5H6.7z"/>' +
    '<path d="M8.3 9.5 6.1 6.4"/>' +
    '<path d="M8.3 14.5 6.1 17.6"/>' +
    '<path d="M19.6 12h1.9"/>',
  /** Deflector shield: shield outline with a deflection arc across it. */
  shield:
    '<path d="M12 2.9 20 5.6v6.3c0 4.3-3.4 7.1-8 8.8-4.6-1.7-8-4.5-8-8.8V5.6z"/>' +
    '<path d="M6.6 10.4q5.4-2.6 10.8 0"/>',
  /** Afterburner: stacked chevrons driving into a thrust bar. */
  boost:
    '<path d="M3.4 6.4 9.2 12l-5.8 5.6"/>' +
    '<path d="M10.4 6.4 16.2 12l-5.8 5.6"/>' +
    '<path d="M19.4 7.4v9.2"/>',
  /** Capacitor battery: cell body, terminal and a charge bolt. */
  capacitor:
    '<path d="M2.6 7.4h13.6v9.2H2.6z"/>' +
    '<path d="M18.6 10.2v3.6"/>' +
    '<path d="M10.8 8.9 7.6 12.4h2.6L9.2 15.9l3.4-3.9H10z"/>',
  /** Countermeasure pod: a canister throwing three burning trails clear. */
  countermeasure:
    '<path d="M4.4 19.6a2.4 2.4 0 1 0 3.4-3.4 2.4 2.4 0 0 0-3.4 3.4z"/>' +
    '<path d="M9.4 15.2 15.4 9.2"/>' +
    '<path d="M15.4 12.4V9.2h-3.2"/>' +
    '<path d="M10.8 18 18.6 15.6"/>' +
    '<path d="M8.2 13.4 10.6 5.6"/>',
  /** Slowing ray: an emitter throwing a beam that breaks into braking bars. */
  disruptor:
    '<path d="M2.6 12h4.2"/>' +
    '<path d="M6.8 9.2h3.4v5.6H6.8z"/>' +
    '<path d="M11.8 12h9.6"/>' +
    '<path d="M14.6 9.6v4.8"/>' +
    '<path d="M17.6 10.4v3.2"/>' +
    '<path d="M20.4 11.2v1.6"/>',
  /** Repair field: a cross inside the bubble the pulse fills. */
  repair:
    '<path d="M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z"/>' +
    '<path d="M12 7.8v8.4"/>' +
    '<path d="M7.8 12h8.4"/>',
  /** Generic hardpoint: the fallback, and the glyph for an unclassed utility. */
  [FALLBACK_ICON_ID]:
    '<path d="M12 2.8 19.6 7.4v9.2L12 21.2 4.4 16.6V7.4z"/>' +
    '<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z"/>',
};

/** `family` → icon id, for a module that authored no icon reference at all. */
const FAMILY_ICONS: Readonly<Record<string, string>> = {
  laser: "laser",
  kinetic: "kinetic",
  missile: "missile",
  shield: "shield",
  disruptor: "disruptor",
  repair: "repair",
  boost: "boost",
  countermeasure: "countermeasure",
  utility: FALLBACK_ICON_ID,
};

/** Aliases, so a pack can author the word a designer would reach for. */
const ICON_ALIASES: Readonly<Record<string, string>> = {
  beam: "laser",
  cannon: "kinetic",
  autocannon: "kinetic",
  rocket: "missile",
  afterburner: "boost",
  thruster: "boost",
  battery: "capacitor",
  tether: "disruptor",
  slow: "disruptor",
  heal: "repair",
  medic: "repair",
  nanite: "repair",
  flare: "countermeasure",
  flares: "countermeasure",
  chaff: "countermeasure",
  decoy: "countermeasure",
};

const PLACEHOLDER = /^\s*\[\s*icon\s*:\s*(.+?)\s*\]\s*$/i;

/**
 * The bare id inside an icon reference: `[ICON: laser]` → `laser`, and a plain
 * `laser` → `laser`. Returns undefined for anything that is not an id we ship
 * (an emoji, a `»`, an empty string), so a caller can fall through to the next
 * key rather than resolving to a glyph nobody asked for.
 */
export function iconIdFromRef(ref: string | undefined): string | undefined {
  if (typeof ref !== "string") return undefined;
  const match = PLACEHOLDER.exec(ref);
  const raw = (match?.[1] ?? ref).trim().toLowerCase();
  if (raw === "") return undefined;
  const resolved = ICON_ALIASES[raw] ?? raw;
  return resolved in ICON_PATHS ? resolved : undefined;
}

/** True when {@link moduleIconSvg} has a real glyph for this id. */
export function hasModuleIcon(id: string): boolean {
  return id in ICON_PATHS;
}

/**
 * The icon id for a module config, following the four-step resolution documented
 * at the top of this file. Always returns an id {@link moduleIconSvg} can draw.
 */
export function moduleIconId(cfg: Pick<ModuleConfig, "family" | "ui"> | undefined): string {
  if (!cfg) return FALLBACK_ICON_ID;
  const override = iconIdFromRef(cfg.ui?.iconId);
  if (override) return override;
  // An unknown explicit iconId is a content bug, not a reason to keep looking:
  // fall straight to the generic glyph so the mistake is visible rather than
  // silently masked by the family default.
  if (typeof cfg.ui?.iconId === "string" && cfg.ui.iconId.trim() !== "") return FALLBACK_ICON_ID;
  const authored = iconIdFromRef(cfg.ui?.icon);
  if (authored) return authored;
  return FAMILY_ICONS[cfg.family] ?? FALLBACK_ICON_ID;
}

/**
 * One icon as a complete `<svg>` string, ready for `innerHTML`. The markup is a
 * module-level constant (never user input), and `vector-effect` keeps the stroke
 * a hairline at every HUD scale.
 */
export function moduleIconSvg(id: string): string {
  const paths = ICON_PATHS[id] ?? ICON_PATHS[FALLBACK_ICON_ID]!;
  return (
    '<svg class="hud-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    paths +
    "</svg>"
  );
}

/** Every id the set ships — the Theme/Module editors' allowed-values list. */
export function moduleIconIds(): string[] {
  return Object.keys(ICON_PATHS);
}
