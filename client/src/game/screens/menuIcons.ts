/**
 * The main menu's icon set.
 *
 * Inline SVG, drawn on a 24×24 grid with `currentColor` strokes, so an icon
 * inherits the button's colour and its focus/hover states for free — an <img>
 * or a sprite sheet would need a second theme pass and a second asset to load.
 *
 * Every glyph says something about the mode rather than decorating it: the
 * team icons carry their own headcount, so 2v2 and 5v5 are distinguishable
 * before the label is read.
 */

export type MenuIconKey =
  | "team"
  | "duel"
  | "flag"
  | "hangar"
  | "shop"
  | "tutorial"
  | "settings"
  | "play"
  | "back";

const S = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"`;

/**
 * Two facing formations. The dots ARE the headcount — the icon for 2v2 and the
 * icon for 5v5 differ, which is the whole reason to draw ships rather than a
 * generic "versus".
 */
function formation(perSide: number): string {
  const left: string[] = [];
  const right: string[] = [];
  // A wedge: one at the point, the rest fanned behind it.
  const rows = [
    { x: 4.2, y: 12 },
    { x: 2.2, y: 9 },
    { x: 2.2, y: 15 },
    { x: 0.9, y: 6.4 },
    { x: 0.9, y: 17.6 },
  ].slice(0, perSide);
  for (const { x, y } of rows) {
    left.push(`<circle cx="${x}" cy="${y}" r="1.35" />`);
    right.push(`<circle cx="${24 - x}" cy="${y}" r="1.35" />`);
  }
  return `<svg ${S}>${left.join("")}${right.join("")}<path d="M12 4.5v15" stroke-dasharray="2 2.4" opacity="0.55" /></svg>`;
}

const ICONS: Record<MenuIconKey, string> = {
  // Filled in per team size at call time; this is the 5-a-side default.
  team: formation(5),
  /** Two ships, nose to nose. */
  duel: `<svg ${S}><path d="M3 12h5.5" /><path d="M15.5 12H21" /><path d="M8.5 8.4 12 12l-3.5 3.6z" /><path d="M15.5 8.4 12 12l3.5 3.6z" /></svg>`,
  /** A pennant on a staff, with the base it has to be carried to. */
  flag: `<svg ${S}><path d="M6.5 21V3.6" /><path d="M6.5 4.4h11l-2.6 3.7 2.6 3.7h-11" /><path d="M3.2 21h6.6" /></svg>`,
  /** A bay with its doors open and a hull inside. */
  hangar: `<svg ${S}><path d="M3 20V10.5L12 5l9 5.5V20" /><path d="M3 20h18" /><path d="M8.5 20v-5.5h7V20" /><path d="M12 11.2v2.2" /></svg>`,
  /** A price tag, not a trolley: this shop sells one thing at a time. */
  shop: `<svg ${S}><path d="M11.4 3.2 20.8 12.6a1.4 1.4 0 0 1 0 2L14.6 20.8a1.4 1.4 0 0 1-2 0L3.2 11.4V3.2z" /><circle cx="7.6" cy="7.6" r="1.5" /></svg>`,
  /** A flight path with a waypoint — the tutorial teaches flying, not reading. */
  tutorial: `<svg ${S}><path d="M3 18.5c5.4 0 6.6-13 10.4-13 2.6 0 3.4 3.4 1.6 5" /><circle cx="18.4" cy="7.4" r="2.4" /><path d="M3 21h18" opacity="0.45" /></svg>`,
  settings: `<svg ${S}><circle cx="12" cy="12" r="3.1" /><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4 5.5 5.5" /></svg>`,
  play: `<svg ${S}><path d="M8 5.2 19 12 8 18.8z" /></svg>`,
  back: `<svg ${S}><path d="M19 12H5.6" /><path d="m11 5.6-5.8 6.4 5.8 6.4" /></svg>`,
};

/**
 * One icon as an SVG string. `teams` refines the team glyph to its real
 * headcount; unknown keys fall back to `play`, so a pack naming an icon this
 * client does not ship still renders a button rather than a hole.
 */
export function menuIcon(key: string | undefined, teams?: string): string {
  if (key === "team") {
    const perSide = Number.parseInt(teams?.split("v")[0] ?? "5", 10);
    return formation(Number.isFinite(perSide) ? Math.min(5, Math.max(1, perSide)) : 5);
  }
  return ICONS[(key ?? "") as MenuIconKey] ?? ICONS.play;
}

/** An element carrying `menuIcon`'s markup, ready to append. */
export function iconElement(key: string | undefined, teams?: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "sa-menu-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = menuIcon(key, teams);
  return span;
}

/** The icon a section heading wears when its modes disagree. */
export const GROUP_ICON: Record<string, MenuIconKey> = {
  "team deathmatch": "team",
  deathmatch: "duel",
  "capture the flag": "flag",
};
