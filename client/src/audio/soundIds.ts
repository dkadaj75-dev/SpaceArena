import type {
  ActionConfig,
  AudioConfig,
  EntityId,
  ModuleConfig,
  SimEvent,
  ThemeConfig,
} from "@space-arena/shared";

/**
 * ROADMAP §10 5.7 — the pure sound-id layer. Everything here is a function of
 * content configs and sim events, with no Web Audio and no DOM, so the whole
 * "which sound does this event make?" policy is unit-testable.
 *
 * The iron rule for audio: **nothing here knows what a sound is**. Ids are
 * strings resolved from configs and handed to the synth registry
 * (`synths.ts`); a module's own sounds come from its action hooks, an
 * explosion's from its effect config, and only the handful of player-feedback
 * cues with no other home come from `theme.audio.cues`.
 */

/** `[SOUND: laser_fire]` — the unbuilt-asset placeholder form used across content. */
const SOUND_PLACEHOLDER = /^\[\s*SOUND\s*:\s*([^\]]+)\]$/i;

/** One resolved play request: a registry sound id plus a per-source volume 0..1. */
export interface SoundRequest {
  id: string;
  volume: number;
}

/**
 * A content sound reference → a bare sound id. Accepts both the plain id
 * (`laser_fire`) and the tagged placeholder (`[SOUND: laser_fire]`) so content
 * can keep the placeholder until a real sample exists. Returns null for
 * anything that isn't a non-empty string.
 */
export function resolveSoundId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const placeholder = SOUND_PLACEHOLDER.exec(trimmed);
  const id = (placeholder ? placeholder[1]! : trimmed).trim();
  return id === "" ? null : id;
}

/** A `play_sound` action config → its request, or null for any other action kind. */
export function soundRequestFromAction(action: ActionConfig | undefined): SoundRequest | null {
  if (!action || action.kind !== "play_sound") return null;
  const id = resolveSoundId(action.params?.["sound"]);
  if (!id) return null;
  const rawVolume = action.params?.["volume"];
  const volume = typeof rawVolume === "number" && Number.isFinite(rawVolume) ? clamp01(rawVolume) : 1;
  return { id, volume };
}

/** The module hook whose action ids an event carries (or would carry). */
export type ModuleHook = "onFire" | "onOverheat" | "onActivate" | "onDeactivate";

/**
 * Which module action hook a sim event corresponds to, or null when the event
 * isn't module-driven. `moduleStateChanged` splits on direction: entering
 * `deploying`/`active` is an activation, everything else a deactivation.
 */
export function moduleHookFor(event: SimEvent): ModuleHook | null {
  switch (event.type) {
    case "projectileFired":
      return "onFire";
    case "overheated":
      return "onOverheat";
    case "moduleStateChanged":
      return event.to === "deploying" || event.to === "active" ? "onActivate" : "onDeactivate";
    default:
      return null;
  }
}

/**
 * The action ids a module-driven event should dispatch.
 *
 * Offline the sim stamps them straight onto the event (`ev.actions`). Online
 * they are absent — `FireEventMessage` carries only `moduleId` — so they are
 * re-derived from the module config's hook here, which is why audio behaves
 * identically in practice and in a netgame.
 */
export function actionIdsForEvent(
  event: SimEvent,
  lookupModule: (moduleId: string) => ModuleConfig | undefined,
): readonly string[] {
  const hook = moduleHookFor(event);
  if (!hook) return EMPTY;
  const withActions = event as { actions?: string[]; moduleId?: string };
  if (withActions.actions && withActions.actions.length > 0) return withActions.actions;
  if (!withActions.moduleId) return EMPTY;
  return lookupModule(withActions.moduleId)?.[hook] ?? EMPTY;
}

const EMPTY: readonly string[] = [];

/** Player-feedback cue ids, already placeholder-resolved (null = silent). */
export interface AudioCueMap {
  playerDamaged: string | null;
  shieldAbsorb: string | null;
  playerKill: string | null;
  playerDeath: string | null;
  overheat: string | null;
  boundaryWarning: string | null;
  /** Sensors completing a lock on the local player's candidate (FLIGHT.md §2/§4). */
  lockAcquired: string | null;
  /** A completed lock breaking (progress drained to 0, or the target died). */
  lockLost: string | null;
}

/** The theme's `audio` block, fully defaulted. */
export interface AudioSettings {
  enabled: boolean;
  defaultMasterVolume: number;
  defaultSfxVolume: number;
  maxVoices: number;
  retriggerGapMs: number;
  cues: AudioCueMap;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true,
  defaultMasterVolume: 0.8,
  defaultSfxVolume: 0.8,
  maxVoices: 16,
  retriggerGapMs: 45,
  cues: {
    playerDamaged: null,
    shieldAbsorb: null,
    playerKill: null,
    playerDeath: null,
    overheat: null,
    boundaryWarning: null,
    lockAcquired: null,
    lockLost: null,
  },
};

/** Resolve `theme.audio` into fully-defaulted settings with bare cue ids. */
export function audioSettingsOf(theme: ThemeConfig | undefined): AudioSettings {
  const a: AudioConfig | undefined = theme?.audio;
  const cues = a?.cues;
  return {
    enabled: a?.enabled ?? DEFAULT_AUDIO_SETTINGS.enabled,
    defaultMasterVolume: a?.defaultMasterVolume ?? DEFAULT_AUDIO_SETTINGS.defaultMasterVolume,
    defaultSfxVolume: a?.defaultSfxVolume ?? DEFAULT_AUDIO_SETTINGS.defaultSfxVolume,
    maxVoices: a?.maxVoices ?? DEFAULT_AUDIO_SETTINGS.maxVoices,
    retriggerGapMs: a?.retriggerGapMs ?? DEFAULT_AUDIO_SETTINGS.retriggerGapMs,
    cues: {
      playerDamaged: resolveSoundId(cues?.playerDamaged),
      shieldAbsorb: resolveSoundId(cues?.shieldAbsorb),
      playerKill: resolveSoundId(cues?.playerKill),
      playerDeath: resolveSoundId(cues?.playerDeath),
      overheat: resolveSoundId(cues?.overheat),
      boundaryWarning: resolveSoundId(cues?.boundaryWarning),
      lockAcquired: resolveSoundId(cues?.lockAcquired),
      lockLost: resolveSoundId(cues?.lockLost),
    },
  };
}

/**
 * The player-feedback cue one sim event produces, or null.
 *
 * Deliberately narrow: these are the cues about *the local player* that no
 * module or effect config owns. Ship explosions are NOT here — they come from
 * the explosion effect config the view layer already picks per ship class.
 */
export function cueSoundFor(event: SimEvent, playerId: EntityId, cues: AudioCueMap): string | null {
  switch (event.type) {
    case "damage":
      return event.targetId === playerId && !event.isAsteroid ? cues.playerDamaged : null;
    case "shieldAbsorb":
      return event.targetId === playerId ? cues.shieldAbsorb : null;
    case "entityDestroyed": {
      if (event.isAsteroid) return null;
      if (event.entityId === playerId) return cues.playerDeath;
      return event.killerId === playerId ? cues.playerKill : null;
    }
    case "overheated":
      return event.entityId === playerId ? cues.overheat : null;
    case "boundaryHit":
      return event.entityId === playerId && event.rule !== "bounce" ? cues.boundaryWarning : null;
    // Lock flips (FLIGHT.md §4). Both directions get a cue: unlike the haptic,
    // a short audio tick for losing the lock is the cheapest way to tell a
    // player their guns just went cold without them reading the reticle.
    case "lockAcquired":
      return event.entityId === playerId ? cues.lockAcquired : null;
    case "lockLost":
      return event.entityId === playerId ? cues.lockLost : null;
    default:
      return null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
