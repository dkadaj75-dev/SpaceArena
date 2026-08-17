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
  distanceGain,
  soundRequestFromAction,
  soundSourceEntity,
  type AudioSettings,
} from "./soundIds.js";

const THEME_ID = "theme.default";

/** Any world-space point — a snapshot `pos` or a Babylon `Vector3` both fit. */
export interface AudioPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * How the feedback layer places sounds in the world. Both hooks are optional:
 * without them every sound plays at its authored volume, which is exactly what
 * the unit tests (and any non-match use) want.
 */
export interface AudioFeedbackOptions {
  /** The local player's ears — own ship position, or the camera when it is gone. */
  listenerPosition?: () => AudioPoint | null | undefined;
  /** A sim entity's current world position, or null/undefined when unplaceable. */
  entityPosition?: (id: EntityId) => AudioPoint | null | undefined;
}

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
 * id as a module action does not double up. Because that one voice may stand in
 * for several ships, ids are collected with their LOUDEST volume of the frame
 * and flushed at the end — the nearest of four lasers is the one you hear.
 *
 * Distance (requirement §1): a sound made by another ship is attenuated by how
 * far its ship is from the local player (see {@link distanceGain}) and dropped
 * entirely past the silence radius. The local player's own module sounds and
 * every theme cue — which are all about the local player by construction —
 * always play at their authored volume.
 */
export class AudioFeedback {
  private settings: AudioSettings;
  /** This frame's sound id → loudest volume requested for it (closest source). */
  private readonly frameVolumes = new Map<string, number>();
  /** Set by {@link dispose}; every further event is dropped. */
  private disposed = false;

  constructor(
    private readonly configs: ConfigService,
    private readonly playerId: EntityId,
    private readonly audio: AudioManager,
    private readonly options: AudioFeedbackOptions = {},
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

  /**
   * Match teardown (main.ts `MatchRuntime.dispose`). This layer holds no
   * subscriptions today — it is driven by `consumeEvents` from the render loop —
   * but the AudioManager it feeds outlives every match, so it neutralizes
   * itself: a late `consumeEvents` after teardown must not synthesize a voice
   * on the menu. Idempotent, and the hook is here so a future listener/timer
   * added to this class is torn down with the runtime rather than leaking.
   */
  dispose(): void {
    this.disposed = true;
    this.frameVolumes.clear();
  }

  consumeEvents(events: readonly SimEvent[]): void {
    // Torn down, muted, or not yet unlocked: skip the whole resolution pass,
    // not just playback.
    if (this.disposed || this.audio.effectiveVolume <= 0) return;
    this.frameVolumes.clear();
    // One listener lookup per frame, not per event: every source is measured
    // against the same ears. Null (no provider, or no ship and no camera yet)
    // means "unplaceable" and disables attenuation rather than muting the world.
    const listener = this.options.listenerPosition?.() ?? null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const actionIds = actionIdsForEvent(ev, (id) => this.configs.get<ModuleConfig>("module", id));
      if (actionIds.length > 0) {
        // Out of earshot: skip the action/config resolution too, not just the voice.
        const gain = this.gainFor(ev, listener);
        if (gain > 0) {
          for (let a = 0; a < actionIds.length; a++) {
            const request = soundRequestFromAction(this.configs.get<ActionConfig>("action", actionIds[a]!));
            if (request) this.requestSound(request.id, request.volume * gain);
          }
        }
      }
      // Cues are local-player feedback by definition — never attenuated.
      const cue = cueSoundFor(ev, this.playerId, this.settings.cues);
      if (cue) this.requestSound(cue, 1);
    }
    for (const [id, volume] of this.frameVolumes) this.audio.play(id, volume);
  }

  /**
   * Distance gain for one event's sounds. Always 1 for the local player's own
   * ship, for match-wide events that name no ship, and whenever either end of
   * the measurement is unplaceable this frame.
   */
  private gainFor(event: SimEvent, listener: AudioPoint | null): number {
    const sourceId = soundSourceEntity(event);
    if (sourceId === null || sourceId === this.playerId || !listener) return 1;
    const source = this.options.entityPosition?.(sourceId);
    if (!source) return 1;
    return distanceGain(
      Math.hypot(source.x - listener.x, source.y - listener.y, source.z - listener.z),
    );
  }

  /** Keep the loudest (nearest) request per id; the flush plays one voice each. */
  private requestSound(id: string, volume: number): void {
    if (volume <= 0) return;
    const previous = this.frameVolumes.get(id);
    if (previous === undefined || volume > previous) this.frameVolumes.set(id, volume);
  }
}
