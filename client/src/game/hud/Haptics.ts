import type { ConfigService, EntityId, SimEvent, ThemeConfig } from "@space-arena/shared";

/** The theme's `haptics` block, already defaulted. */
export interface HapticsSettings {
  enabled: boolean;
  overheatPattern: number[];
  killPattern: number[];
}

const THEME_ID = "theme.default";

export function hapticsSettingsOf(theme: ThemeConfig | undefined): HapticsSettings {
  const h = theme?.haptics;
  return {
    enabled: h?.enabled ?? false,
    overheatPattern: h?.overheatPattern ?? [],
    killPattern: h?.killPattern ?? [],
  };
}

/**
 * The vibration pattern one sim event should produce for `playerId`, or null.
 * Pure — the whole event→pattern policy is testable without a navigator.
 *
 * Two cues only (ROADMAP 5.4):
 *  - the player's OWN module force-shutting on overheat (`overheated`)
 *  - the player scoring a kill on an enemy SHIP (`entityDestroyed`)
 */
export function hapticPatternFor(
  event: SimEvent,
  playerId: EntityId,
  settings: HapticsSettings,
): number[] | null {
  if (!settings.enabled) return null;
  if (event.type === "overheated" && event.entityId === playerId) {
    return settings.overheatPattern.length > 0 ? settings.overheatPattern : null;
  }
  if (
    event.type === "entityDestroyed" &&
    !event.isAsteroid &&
    event.killerId === playerId &&
    event.entityId !== playerId
  ) {
    return settings.killPattern.length > 0 ? settings.killPattern : null;
  }
  return null;
}

/** `navigator.vibrate` if the browser has it, else null (iOS Safari, desktop). */
export function defaultVibrate(): ((pattern: number[]) => void) | null {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { vibrate?: unknown });
  if (!nav || typeof nav.vibrate !== "function") return null;
  return (pattern) => {
    try {
      nav.vibrate?.(pattern);
    } catch {
      // Some engines throw when the document is not user-activated — never let
      // a haptics failure kill the frame's event drain.
    }
  };
}

/**
 * Haptic feedback for overheat shutdowns and kills (ROADMAP 5.4). Patterns and
 * the master on/off switch come from `theme.json` (`haptics` block) and are
 * re-read on hot-reload, so the Theme editor tunes the feel live.
 */
export class Haptics {
  private settings: HapticsSettings;

  constructor(
    private readonly configs: ConfigService,
    private readonly playerId: EntityId,
    private readonly vibrate: ((pattern: number[]) => void) | null = defaultVibrate(),
  ) {
    this.settings = hapticsSettingsOf(this.configs.get<ThemeConfig>("theme", THEME_ID));
  }

  /** Re-read the theme (config hot-reload). */
  refresh(): void {
    this.settings = hapticsSettingsOf(this.configs.get<ThemeConfig>("theme", THEME_ID));
  }

  consumeEvents(events: readonly SimEvent[]): void {
    if (!this.vibrate || !this.settings.enabled) return;
    for (let i = 0; i < events.length; i++) {
      const pattern = hapticPatternFor(events[i]!, this.playerId, this.settings);
      // One buzz per frame at most: stacked vibrate() calls just cancel each other.
      if (pattern) {
        this.vibrate(pattern);
        return;
      }
    }
  }
}
