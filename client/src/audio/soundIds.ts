import type {
  ActionConfig,
  AudioConfig,
  EntityId,
  MusicScreen,
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

/** Distance (world units) inside which another ship's sound plays unattenuated. */
export const SOUND_FULL_VOLUME_DISTANCE = 300;
/** Distance beyond which another ship's sound is inaudible and never played. */
export const SOUND_SILENCE_DISTANCE = 500;

/**
 * Distance attenuation for a sound made by SOMEONE ELSE'S ship: full volume out
 * to {@link SOUND_FULL_VOLUME_DISTANCE}, a straight line down to zero at
 * {@link SOUND_SILENCE_DISTANCE}, and zero past it (the caller skips playback
 * entirely rather than starting a silent voice).
 *
 * A non-finite distance means the source could not be placed this frame; that
 * reads as "right here" — full volume — so a missing position can never mute a
 * sound that used to be audible.
 */
export function distanceGain(distance: number): number {
  if (!Number.isFinite(distance) || distance <= SOUND_FULL_VOLUME_DISTANCE) return 1;
  if (distance >= SOUND_SILENCE_DISTANCE) return 0;
  return (SOUND_SILENCE_DISTANCE - distance) / (SOUND_SILENCE_DISTANCE - SOUND_FULL_VOLUME_DISTANCE);
}

/**
 * The entity whose position a module/effect sound should be heard FROM, or null
 * when the event names no ship (match-wide beats such as the countdown). Sim
 * events carry ids only, so the listener side resolves the actual position.
 */
export function soundSourceEntity(event: SimEvent): EntityId | null {
  switch (event.type) {
    case "projectileFired":
      return event.ownerId;
    case "moduleStateChanged":
    case "countermeasureJettisoned":
      return event.entityId;
    default:
      return null;
  }
}

/** The module hook whose action ids an event carries (or would carry). */
export type ModuleHook = "onFire" | "onActivate" | "onDeactivate";

/**
 * Which module action hook a sim event corresponds to, or null when the event
 * isn't module-driven. `moduleStateChanged` splits on direction: entering
 * `deploying`/`active` is an activation, everything else a deactivation.
 */
export function moduleHookFor(event: SimEvent): ModuleHook | null {
  switch (event.type) {
    case "projectileFired":
      return "onFire";
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

/**
 * The hangar launch sequence's cues.
 *
 * These are the one family that is NOT content-driven, and deliberately so: the
 * sequence is a sim mechanic (`ShipSnapshot.launchLocked` / `launchHold`), not
 * a module hook, an effect or a theme-authored player cue — there is no config
 * object that owns it. Naming them here keeps the ids in the same file as every
 * other id policy, so a real sample replaces a synth stub by editing
 * `synths.ts` alone.
 */
export const HANGAR_LAUNCH_SOUNDS = {
  /** One per whole second of the pad hold (3 / 2 / 1). */
  countdownTick: "hangar_countdown_tick",
  /** The hold reaching zero — control handed to the pilot. */
  countdownGo: "hangar_countdown_go",
  /** Engine ramp, fired once when the sim-flown run starts. */
  thrust: "launch_thrust",
} as const;

/** Player-feedback cue ids, already placeholder-resolved (null = silent). */
export interface AudioCueMap {
  playerDamaged: string | null;
  shieldAbsorb: string | null;
  playerKill: string | null;
  playerDeath: string | null;
  boundaryWarning: string | null;
  /** Sensors completing a lock on the local player's candidate (FLIGHT.md §2/§4). */
  lockAcquired: string | null;
  /** A completed lock breaking (progress drained to 0, or the target died). */
  lockLost: string | null;
  /** A local trigger pull rejected because no lock is held. */
  fireBlocked: string | null;
  /** Each whole second of the match-start countdown (3 / 2 / 1). */
  countdownTick: string | null;
  /** The countdown reaching zero — the "GO" stinger. */
  countdownGo: string | null;
}

/** The theme's `audio` block, fully defaulted. */
export interface AudioSettings {
  enabled: boolean;
  defaultMasterVolume: number;
  defaultSfxVolume: number;
  maxVoices: number;
  retriggerGapMs: number;
  cues: AudioCueMap;
  music: MusicSettings;
}

export interface MusicTrackSettings {
  src: string;
  volume: number;
  loop: boolean;
  license?: string;
}

export interface MusicSettings {
  enabled: boolean;
  defaultVolume: number;
  fadeInSec: number;
  fadeOutSec: number;
  tracks: Record<string, MusicTrackSettings>;
  screens: Record<MusicScreen, string | null>;
}

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  enabled: true,
  defaultVolume: 0.5,
  fadeInSec: 1,
  fadeOutSec: 1,
  tracks: {},
  screens: { boot: null, menu: null, hangar: null, shop: null, match: null },
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true,
  defaultMasterVolume: 0.8,
  defaultSfxVolume: 0.8,
  maxVoices: 16,
  retriggerGapMs: 45,
  music: DEFAULT_MUSIC_SETTINGS,
  cues: {
    playerDamaged: null,
    shieldAbsorb: null,
    playerKill: null,
    playerDeath: null,
    boundaryWarning: null,
    lockAcquired: null,
    lockLost: null,
    fireBlocked: null,
    countdownTick: null,
    countdownGo: null,
  },
};

/** Resolve `theme.audio` into fully-defaulted settings with bare cue ids. */
export function audioSettingsOf(theme: ThemeConfig | undefined): AudioSettings {
  const a: AudioConfig | undefined = theme?.audio;
  const cues = a?.cues;
  const music = a?.music;
  const tracks: Record<string, MusicTrackSettings> = {};
  for (const [id, track] of Object.entries(music?.tracks ?? {})) {
    tracks[id] = {
      src: track.src,
      volume: track.volume ?? 1,
      loop: track.loop ?? true,
      ...(track.license === undefined ? {} : { license: track.license }),
    };
  }
  return {
    enabled: a?.enabled ?? DEFAULT_AUDIO_SETTINGS.enabled,
    defaultMasterVolume: a?.defaultMasterVolume ?? DEFAULT_AUDIO_SETTINGS.defaultMasterVolume,
    defaultSfxVolume: a?.defaultSfxVolume ?? DEFAULT_AUDIO_SETTINGS.defaultSfxVolume,
    maxVoices: a?.maxVoices ?? DEFAULT_AUDIO_SETTINGS.maxVoices,
    retriggerGapMs: a?.retriggerGapMs ?? DEFAULT_AUDIO_SETTINGS.retriggerGapMs,
    music: {
      enabled: music?.enabled ?? DEFAULT_MUSIC_SETTINGS.enabled,
      defaultVolume: music?.defaultVolume ?? DEFAULT_MUSIC_SETTINGS.defaultVolume,
      fadeInSec: music?.fadeInSec ?? DEFAULT_MUSIC_SETTINGS.fadeInSec,
      fadeOutSec: music?.fadeOutSec ?? DEFAULT_MUSIC_SETTINGS.fadeOutSec,
      tracks,
      screens: {
        boot: music?.screens?.boot ?? null,
        menu: music?.screens?.menu ?? null,
        hangar: music?.screens?.hangar ?? null,
        shop: music?.screens?.shop ?? null,
        match: music?.screens?.match ?? null,
      },
    },
    cues: {
      playerDamaged: resolveSoundId(cues?.playerDamaged),
      shieldAbsorb: resolveSoundId(cues?.shieldAbsorb),
      playerKill: resolveSoundId(cues?.playerKill),
      playerDeath: resolveSoundId(cues?.playerDeath),
      boundaryWarning: resolveSoundId(cues?.boundaryWarning),
      lockAcquired: resolveSoundId(cues?.lockAcquired),
      lockLost: resolveSoundId(cues?.lockLost),
      fireBlocked: resolveSoundId(cues?.fireBlocked),
      countdownTick: resolveSoundId(cues?.countdownTick),
      countdownGo: resolveSoundId(cues?.countdownGo),
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
    case "boundaryHit":
      return event.entityId === playerId && event.rule !== "bounce" ? cues.boundaryWarning : null;
    // Lock flips (FLIGHT.md §4). Both directions get a cue: unlike the haptic,
    // a short audio tick for losing the lock is the cheapest way to tell a
    // player their guns just went cold without them reading the reticle.
    case "lockAcquired":
      return event.entityId === playerId ? cues.lockAcquired : null;
    case "lockLost":
      return event.entityId === playerId ? cues.lockLost : null;
    // Match-start countdown. The only cues here that are NOT about one ship:
    // the sim's countdown is a property of the MATCH, so every client in it
    // plays the same beat, and no `playerId` comparison applies.
    case "countdownTick":
      return cues.countdownTick;
    case "matchStarted":
      return cues.countdownGo;
    default:
      return null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
