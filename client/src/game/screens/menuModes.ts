import type { GamemodeConfig } from "@space-arena/shared";

/**
 * How the Play modes are grouped on the main menu.
 *
 * The grouping is authored per gamemode (`gamemode.menu.group`), not hardcoded
 * here, so a content pack that adds a mode gets a menu entry with no code
 * change — the property the existing menu already had and worth keeping.
 */

/** Where a mode with no authored `menu.group` lands. */
export const UNGROUPED = "Play";

export interface MenuMode {
  id: string;
  /** The face of the card: the short label when the heading carries the name. */
  label: string;
  /** One line under it, or empty. */
  blurb: string;
  /** Icon key, resolved by `menuIcon`. */
  icon: string | undefined;
  /** Team shape, so the team icon can carry the real headcount. */
  teams: string;
}

export interface MenuGroup {
  title: string;
  modes: MenuMode[];
}

/**
 * Playable modes, grouped and ordered for the menu.
 *
 * Group ORDER is first appearance in pack order, and mode order inside a group
 * is the authored `menu.order` with pack order as the tie-break. Both are
 * stable rather than alphabetical: a designer who reorders the manifest expects
 * the menu to follow, and a menu whose buttons move when a mode is renamed is
 * a menu nobody can build muscle memory on.
 */
export function menuGroups(gamemodes: readonly GamemodeConfig[]): MenuGroup[] {
  /** A mode plus the two keys the sort needs and the menu does not. */
  interface Sortable extends MenuMode {
    order: number;
    packIndex: number;
  }

  const groups: { title: string; modes: Sortable[] }[] = [];
  const byTitle = new Map<string, { title: string; modes: Sortable[] }>();

  gamemodes.forEach((mode, packIndex) => {
    // `launch: "offline"` is the tutorial, which has its own destination.
    if (mode.hidden || mode.launch === "offline") return;
    const title = mode.menu?.group ?? UNGROUPED;
    let group = byTitle.get(title);
    if (!group) {
      group = { title, modes: [] };
      byTitle.set(title, group);
      groups.push(group);
    }
    group.modes.push({
      id: mode.id,
      label: mode.menu?.label ?? mode.name ?? mode.id,
      blurb: mode.menu?.blurb ?? "",
      icon: mode.menu?.icon,
      teams: mode.teams,
      order: mode.menu?.order ?? 0,
      packIndex,
    });
  });

  return groups.map((group) => ({
    title: group.title,
    modes: group.modes
      .slice()
      .sort((a, b) => a.order - b.order || a.packIndex - b.packIndex)
      .map(({ order: _order, packIndex: _packIndex, ...mode }) => mode),
  }));
}
