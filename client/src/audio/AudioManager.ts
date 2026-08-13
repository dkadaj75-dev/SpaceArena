import { createLogger } from "@space-arena/shared";
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./soundIds.js";
import { SOUND_SYNTHS, type SynthTarget } from "./synths.js";

const log = createLogger("Audio");

/**
 * Player volume settings live in localStorage under these keys. The 5.8
 * settings screen owns the UI; this manager owns the reading/writing so audio
 * behaves correctly before that screen exists.
 */
export const VOLUME_MASTER_KEY = "sa.volume.master";
export const VOLUME_SFX_KEY = "sa.volume.sfx";
export const VOLUME_MUSIC_KEY = "sa.volume.music";
/** Volume used when the player has never set one and the theme names no default. */
export const DEFAULT_VOLUME = 0.8;

/** Returns a fresh suspended/running AudioContext, or null when unavailable. */
export type AudioContextFactory = () => BaseAudioContext | null;

export interface AudioManagerOptions {
  /** Theme-derived settings (voice cap, retrigger gap, default volumes). */
  settings?: AudioSettings;
  /** Injected for tests; defaults to `new AudioContext()` when the browser has one. */
  contextFactory?: AudioContextFactory;
  /** `null` disables persistence (tests, privacy modes). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Monotonic ms clock for the per-id retrigger throttle. */
  now?: () => number;
}

interface Voice {
  id: string;
  endsAtMs: number;
}

/**
 * ROADMAP §10 5.7 — pooled Web Audio playback of synthesized placeholder SFX.
 *
 * Design rules this class exists to enforce:
 *  - **No sound ids in code.** `play()` takes an id resolved from content; the
 *    synth registry (`synths.ts`) is the only id→sound mapping and an unknown
 *    id warns exactly once, never throws.
 *  - **Autoplay policy.** No AudioContext is constructed until a real user
 *    gesture ({@link attachUnlock}); before that every `play()` is a no-op.
 *  - **Zero work at zero volume.** Muted (or `theme.audio.enabled: false`)
 *    means no context, no nodes, no timers — `play()` returns immediately.
 *  - **Pooled, not unbounded.** A voice budget (`theme.audio.maxVoices`) caps
 *    concurrent voices and a per-id gap (`retriggerGapMs`) stops a rapid-fire
 *    weapon from stacking dozens of copies of one zap into a wall of clipping.
 */
export class AudioManager {
  private settings: AudioSettings;
  private readonly contextFactory: AudioContextFactory;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly now: () => number;

  private ctx: BaseAudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private master: number;
  private sfx: number;
  private music: number;
  private gestureSeen = false;
  private detachUnlock: (() => void) | null = null;

  private readonly voices: Voice[] = [];
  private readonly lastPlayedMs = new Map<string, number>();
  private readonly warnedIds = new Set<string>();
  private readonly stateListeners = new Set<() => void>();

  constructor(options: AudioManagerOptions = {}) {
    this.settings = options.settings ?? DEFAULT_AUDIO_SETTINGS;
    this.contextFactory = options.contextFactory ?? defaultContextFactory;
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.now = options.now ?? (() => performance.now());
    this.master = this.readVolume(VOLUME_MASTER_KEY, this.settings.defaultMasterVolume);
    this.sfx = this.readVolume(VOLUME_SFX_KEY, this.settings.defaultSfxVolume);
    this.music = this.readVolume(VOLUME_MUSIC_KEY, this.settings.music.defaultVolume);
  }

  get masterVolume(): number {
    return this.master;
  }

  get sfxVolume(): number {
    return this.sfx;
  }

  get musicVolume(): number {
    return this.music;
  }

  /** Shared context and music bus used by MusicController; null before unlock. */
  get musicContext(): BaseAudioContext | null {
    return this.ctx;
  }

  get musicDestination(): GainNode | null {
    return this.musicGain;
  }

  /** Master × sfx, or 0 when the theme disables audio outright. */
  get effectiveVolume(): number {
    return this.settings.enabled ? this.master * this.sfx : 0;
  }

  get effectiveMusicVolume(): number {
    return this.settings.enabled && this.settings.music.enabled ? this.master * this.music : 0;
  }

  /** True once a context exists and is running — i.e. sounds can actually be heard. */
  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Live voice count (pool occupancy), for the dev probe and tests. */
  get activeVoices(): number {
    this.reapVoices(this.now());
    return this.voices.length;
  }

  /** Re-read theme settings (content hot-reload). Volumes stay player-owned. */
  applySettings(settings: AudioSettings): void {
    this.settings = settings;
    if (!settings.enabled) this.suspendAll();
    this.applyGains();
    this.emitStateChange();
  }

  setMasterVolume(value: number, options: { persist?: boolean } = {}): void {
    this.master = clamp01(value);
    if (options.persist !== false) this.writeVolume(VOLUME_MASTER_KEY, this.master);
    this.applyGains();
    this.emitStateChange();
  }

  setSfxVolume(value: number, options: { persist?: boolean } = {}): void {
    this.sfx = clamp01(value);
    if (options.persist !== false) this.writeVolume(VOLUME_SFX_KEY, this.sfx);
    this.applyGains();
  }

  setMusicVolume(value: number, options: { persist?: boolean } = {}): void {
    this.music = clamp01(value);
    if (options.persist !== false) this.writeVolume(VOLUME_MUSIC_KEY, this.music);
    this.applyGains();
    this.emitStateChange();
  }

  /** Music listens here for unlock, mute/unmute, and live theme changes. */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Lazily acquire the shared context while preserving autoplay/mute rules. */
  acquireContext(): BaseAudioContext | null {
    return this.ensureContext();
  }

  /**
   * Arm the browser-autoplay unlock: the first pointer/touch/key gesture on
   * `target` creates (or resumes) the AudioContext, then unhooks itself.
   * Idempotent — calling twice keeps a single set of listeners.
   */
  attachUnlock(target: EventTarget | null = typeof window === "undefined" ? null : window): void {
    if (!target || this.detachUnlock) return;
    const events = ["pointerdown", "touchend", "keydown"] as const;
    const onGesture = (): void => {
      this.gestureSeen = true;
      this.unlock();
      this.detachUnlock?.();
    };
    for (const type of events) target.addEventListener(type, onGesture);
    this.detachUnlock = () => {
      for (const type of events) target.removeEventListener(type, onGesture);
      this.detachUnlock = null;
    };
  }

  /**
   * Create/resume the context now. Safe to call before any gesture (it just
   * marks the manager unlocked); does nothing while muted, so a muted player
   * never pays for an AudioContext at all.
   */
  unlock(): void {
    this.gestureSeen = true;
    const ctx = this.ensureContext();
    if (ctx && ctx.state === "suspended" && "resume" in ctx) {
      void (ctx as AudioContext).resume().catch(() => {
        // A rejected resume just means we stay silent until the next gesture.
      });
    }
    this.emitStateChange();
  }

  /**
   * Play one sound by registry id at `volume` (0..1, multiplied by the player's
   * master/sfx levels). Returns true when a voice was actually started.
   *
   * Every rejection path is cheap and silent: muted, not yet unlocked, unknown
   * id (warned once), retriggered too soon, or the voice pool is full.
   */
  play(id: string, volume = 1): boolean {
    if (volume <= 0 || this.effectiveVolume <= 0) return false;
    const synth = SOUND_SYNTHS[id];
    if (!synth) {
      if (!this.warnedIds.has(id)) {
        this.warnedIds.add(id);
        log.warn(`unknown sound id "${id}" — ignoring (add it to synths.ts or fix the config)`);
      }
      return false;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.sfxGain || !this.noiseBuffer) return false;

    const nowMs = this.now();
    const last = this.lastPlayedMs.get(id);
    if (last !== undefined && nowMs - last < this.settings.retriggerGapMs) return false;
    this.reapVoices(nowMs);
    if (this.voices.length >= this.settings.maxVoices) return false;

    // One gain per voice so the per-source volume never touches the shared bus.
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = clamp01(volume);
    voiceGain.connect(this.sfxGain);
    const target: SynthTarget = {
      ctx,
      destination: voiceGain,
      noise: this.noiseBuffer,
      now: ctx.currentTime,
    };
    let durationSec: number;
    try {
      durationSec = synth(target);
    } catch (err) {
      log.warn(`sound "${id}" failed to build: ${String(err)}`);
      return false;
    }
    this.lastPlayedMs.set(id, nowMs);
    this.voices.push({ id, endsAtMs: nowMs + Math.max(0, durationSec) * 1000 + 60 });
    // Nodes disconnect themselves when the whole graph goes idle; the voice
    // record is bookkeeping for the pool budget only (reaped lazily, no timers).
    return true;
  }

  /** Number of distinct unknown ids warned about so far (dev probe/tests). */
  get unknownIdCount(): number {
    return this.warnedIds.size;
  }

  dispose(): void {
    this.detachUnlock?.();
    this.voices.length = 0;
    this.lastPlayedMs.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.noiseBuffer = null;
    if (ctx && "close" in ctx) {
      void (ctx as AudioContext).close().catch(() => {
        // Closing a context that never started can reject; nothing to do.
      });
    }
  }

  /** Build the context + gain bus on first real need. Null while muted/locked. */
  private ensureContext(): BaseAudioContext | null {
    if (this.ctx) return this.ctx;
    if (!this.gestureSeen || !this.settings.enabled || !this.hasAudibleBus) return null;
    const ctx = this.contextFactory();
    if (!ctx) return null;
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.sfxGain = ctx.createGain();
    this.musicGain = ctx.createGain();
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);
    this.noiseBuffer = buildNoiseBuffer(ctx);
    this.applyGains();
    log.info("audio context created", { master: this.master, sfx: this.sfx, music: this.music });
    return ctx;
  }

  private applyGains(): void {
    if (this.masterGain) this.masterGain.gain.value = this.settings.enabled ? this.master : 0;
    if (this.sfxGain) this.sfxGain.gain.value = this.sfx;
    if (this.musicGain) this.musicGain.gain.value = this.settings.music.enabled ? this.music : 0;
  }

  private get hasAudibleBus(): boolean {
    return this.master > 0 && (this.sfx > 0 || (this.settings.music.enabled && this.music > 0));
  }

  private emitStateChange(): void {
    for (const listener of this.stateListeners) listener();
  }

  private suspendAll(): void {
    this.voices.length = 0;
    if (this.ctx && this.ctx.state === "running" && "suspend" in this.ctx) {
      void (this.ctx as AudioContext).suspend().catch(() => {});
    }
  }

  /** Drop voices whose scheduled tail has passed — keeps the pool budget honest. */
  private reapVoices(nowMs: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i]!.endsAtMs <= nowMs) this.voices.splice(i, 1);
    }
  }

  private readVolume(key: string, fallback: number): number {
    const raw = this.storage?.getItem(key);
    if (raw === null || raw === undefined) return clamp01(fallback);
    const value = Number(raw);
    return Number.isFinite(value) ? clamp01(value) : clamp01(fallback);
  }

  private writeVolume(key: string, value: number): void {
    try {
      this.storage?.setItem(key, String(value));
    } catch {
      // Private mode / quota — the level still applies for this session.
    }
  }
}

/** One second of mono white noise, reused by every noise-based synth. */
function buildNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sampleRate = ctx.sampleRate || 44100;
  const buffer = ctx.createBuffer(1, Math.floor(sampleRate), sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function defaultContextFactory(): BaseAudioContext | null {
  const Ctor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
