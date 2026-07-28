import type { ConfigService, ThemeConfig } from "@space-arena/shared";
import { resolveSoundId } from "../../audio/soundIds.js";

const THEME_ID = "theme.default";

interface NotificationSink {
  showConfig(configs: ConfigService, notificationId: string): void;
}

interface HapticSink {
  fireBlocked(): void;
}

/**
 * Coordinates the non-reticle pieces of a blocked trigger pull. The HUD creates
 * one per match, so the authored toast is first-pull-only while haptic/audio
 * remain immediate on every distinct pull.
 */
export class BlockedPullFeedback {
  private notificationShown = false;

  constructor(
    private readonly configs: ConfigService,
    private readonly notifications: NotificationSink,
    private readonly haptics: HapticSink,
    private readonly playSound: ((id: string) => void) | null,
  ) {}

  trigger(notificationId?: string): void {
    this.haptics.fireBlocked();
    if (notificationId && !this.notificationShown) {
      this.notificationShown = true;
      this.notifications.showConfig(this.configs, notificationId);
    }
    const theme = this.configs.get<ThemeConfig>("theme", THEME_ID);
    const soundId = resolveSoundId(theme?.audio?.cues?.fireBlocked);
    if (soundId) this.playSound?.(soundId);
  }
}
