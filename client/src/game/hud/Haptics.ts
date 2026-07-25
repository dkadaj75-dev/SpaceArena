import type { ConfigService, EntityId, SimEvent, ThemeConfig } from "@space-arena/shared";

/** The theme's `haptics` block, already defaulted. */
export interface HapticsSettings {
  enabled: boolean;
  overheatPattern: number[];
  killPattern: number[];
  /** Sensors completing a lock (FLIGHT.md §4) — the "weapons live" tick. */
  lockPattern: number[];
}

const THEME_ID = "theme.default";

export function hapticsSettingsOf(theme: ThemeConfig | undefined): HapticsSettings {
  const h = theme?.haptics;
  return {
    enabled: h?.enabled ?? false,
    overheatPattern: h?.overheatPattern ?? [],
    killPattern: h?.killPattern ?? [],
    lockPattern: h?.lockPattern ?? [],
  };
}

/**
 * The vibration pattern one sim event should produce for `playerId`, or null.
 * Pure — the whole event→pattern policy is testable without a navigator.
 *
 * Three cues (ROADMAP 5.4 + FLIGHT.md §4):
 *  - the player's OWN module force-shutting on overheat (`overheated`)
 *  - the player scoring a kill on an enemy SHIP (`entityDestroyed`)
 *  - the player's OWN sensors completing a lock (`lockAcquired`) — the instant
 *    weapons come live, which is the one flight-model state change a player
 *    otherwise has to read off the HUD mid-turn
 *
 * `lockLost` deliberately has no buzz: locks drain and re-acquire constantly in
 * a dogfight, and a vibration for each would be a rattle, not a signal.
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
  if (event.type === "lockAcquired" && event.entityId === playerId) {
    return settings.lockPattern.length > 0 ? settings.lockPattern : null;
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
  /**
   * Player-level opt-out (5.8 settings, `sa.haptics=off`). Layered ON TOP of the
   * theme switch: content can silence haptics for everyone, a player can
   * silence them for themselves, and neither can re-enable the other's off.
   */
  private userEnabled = true;

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

  /** Apply the player's local on/off choice (5.8 settings screen). */
  setUserEnabled(enabled: boolean): void {
    this.userEnabled = enabled;
  }

  consumeEvents(events: readonly SimEvent[]): void {
    if (!this.vibrate || !this.userEnabled || !this.settings.enabled) return;
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
