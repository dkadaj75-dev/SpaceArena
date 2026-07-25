import type {
  ActionConfig,
  ConfigService,
  EntityId,
  ModuleConfig,
  SimEvent,
  ThemeConfig,
} from "@space-arena/shared";
import type { AudioManager } from "./AudioManager.js";
import {
  actionIdsForEvent,
  audioSettingsOf,
  cueSoundFor,
  soundRequestFromAction,
  type AudioSettings,
} from "./soundIds.js";

const THEME_ID = "theme.default";

/**
 * ROADMAP §10 5.7 — the sim-event → sound consumer, same shape as
 * {@link import("../game/hud/Haptics.js").Haptics}: drained events in, config-resolved
 * sound ids out. It holds no sound knowledge of its own.
 *
 * Two data paths, in this order:
 *  1. **Module action hooks** — `module.onFire/onOverheat/onActivate/onDeactivate`
 *     name `action` configs; every `kind: "play_sound"` action contributes its
 *     `params.sound` id and `params.volume`. Works offline (the sim stamps the
 *     action ids onto the event) and online (re-derived from `moduleId`).
 *  2. **Theme cues** — `theme.audio.cues`, the handful of local-player feedback
 *     sounds no module or effect owns (own damage taken, shield absorb, kill).
 *
 * Explosions are deliberately absent: the view layer already picks an explosion
 * effect per ship class and plays that effect config's own `sound`.
 *
 * Each distinct sound id fires at most once per drained frame, so four lasers
 * cycling on the same tick is one zap, and a cue that happens to name the same
 * id as a module action does not double up.
 */
export class AudioFeedback {
  private settings: AudioSettings;
  private readonly frameIds = new Set<string>();

  constructor(
    private readonly configs: ConfigService,
    private readonly playerId: EntityId,
    private readonly audio: AudioManager,
  ) {
    this.settings = audioSettingsOf(this.configs.get<ThemeConfig>("theme", THEME_ID));
  }

  /** Re-read the theme's audio block (config hot-reload) and push it at the manager. */
  refresh(): void {
    this.settings = audioSettingsOf(this.configs.get<ThemeConfig>("theme", THEME_ID));
    this.audio.applySettings(this.settings);
  }

  /** The theme-resolved audio settings currently in force. */
  get audioSettings(): AudioSettings {
    return this.settings;
  }

  consumeEvents(events: readonly SimEvent[]): void {
    // Muted / not yet unlocked: skip the whole resolution pass, not just playback.
    if (this.audio.effectiveVolume <= 0) return;
    this.frameIds.clear();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const actionIds = actionIdsForEvent(ev, (id) => this.configs.get<ModuleConfig>("module", id));
      for (let a = 0; a < actionIds.length; a++) {
        const request = soundRequestFromAction(this.configs.get<ActionConfig>("action", actionIds[a]!));
        if (request) this.playOnce(request.id, request.volume);
      }
      const cue = cueSoundFor(ev, this.playerId, this.settings.cues);
      if (cue) this.playOnce(cue, 1);
    }
  }

  private playOnce(id: string, volume: number): void {
    if (this.frameIds.has(id)) return;
    this.frameIds.add(id);
    this.audio.play(id, volume);
  }
}
