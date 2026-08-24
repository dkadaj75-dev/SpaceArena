import { createLogger } from "@space-arena/shared";
import { SampleLibrary, SOUND_SAMPLES, type SampleLoader } from "./samples.js";
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
  /** Binary loader for authored samples; injected by tests, else `fetch`. */
  sampleLoader?: SampleLoader;
}

/** Seconds of fade on {@link AudioManager.stopLoop} — long enough to kill the click. */
const LOOP_STOP_RAMP_SEC = 0.05;

/** One continuously looping voice, keyed by its firing source. */
interface Loop {
  id: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface Voice {
  id: string;
  endsAtMs: number;
  /** The voice's own gain node — the one handle that can silence it early. */
  gain: GainNode;
  /** Present only for sample voices: the buffer source to stop on teardown. */
  source?: AudioBufferSourceNode;
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
 *  - **Samples beat synths, but never at the cost of silence.** An id listed in
 *    `samples.ts` plays its authored recording once that file is decoded, and
 *    its synth until then (or forever, if the file fails to load).
 *  - **A channel is a loop, not a shot.** A `loop` sample is driven by
 *    {@link playLoop}/{@link stopLoop} from the weapon's own firing lifecycle
 *    rather than by `play()`, so it lasts exactly as long as the trigger is held.
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

  private readonly samples: SampleLibrary;
  private readonly voices: Voice[] = [];
  /** Firing-source key → its looping voice. One entry per channelling weapon. */
  private readonly loops = new Map<string, Loop>();
  private readonly lastPlayedMs = new Map<string, number>();
  private readonly warnedIds = new Set<string>();
  private readonly stateListeners = new Set<() => void>();

  constructor(options: AudioManagerOptions = {}) {
    this.settings = options.settings ?? DEFAULT_AUDIO_SETTINGS;
    this.contextFactory = options.contextFactory ?? defaultContextFactory;
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.now = options.now ?? (() => performance.now());
    this.samples = new SampleLibrary(options.sampleLoader ? { load: options.sampleLoader } : {});
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
   * id (warned once), retriggered too soon, the voice pool is full, or a
   * sustained sample of this id is already running (see below).
   *
   * An id with an authored sample (`samples.ts`) plays that recording once it
   * has decoded and its synth until then, so the two paths below are the same
   * sound at different fidelities — never a different sound and never silence.
   */
  play(id: string, volume = 1): boolean {
    if (volume <= 0 || this.effectiveVolume <= 0) return false;
    const synth = SOUND_SYNTHS[id];
    const sample = SOUND_SAMPLES[id];
    if (!synth && !sample) {
      if (!this.warnedIds.has(id)) {
        this.warnedIds.add(id);
        log.warn(`unknown sound id "${id}" — ignoring (add it to synths.ts or fix the config)`);
      }
      return false;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.sfxGain || !this.noiseBuffer) return false;

    // Asking for the buffer is what starts the lazy fetch/decode; null means
    // "not ready (or never will be)", which falls through to the synth.
    let buffer = sample ? this.samples.bufferFor(id, ctx) : null;
    if (sample?.loop) {
      // A LOOPING id is owned by {@link playLoop}, which starts it when the
      // weapon starts firing and stops it when the weapon stops. The one-shot
      // path exists for it only as the stand-in while the file is still
      // decoding, so it plays the synth and never the sample, and goes quiet
      // altogether once the real recording is available to loop.
      if (buffer) return false;
      buffer = null;
    }
    // A sample-only id with no synth fallback simply waits for its file.
    if (!buffer && !synth) return false;

    const nowMs = this.now();
    const last = this.lastPlayedMs.get(id);
    if (last !== undefined && nowMs - last < this.settings.retriggerGapMs) return false;
    this.reapVoices(nowMs);
    // The synth stand-in for a channel does not stack either: the sim
    // re-announces a channel on every trigger pull AND every target switch (the
    // beam walking to a new enemy), which lands well inside the stand-in's own
    // length. One beam is one beam, however often the pilot re-acquires.
    // Discrete sounds are unaffected and overlap freely.
    if (sample?.loop && this.hasLiveVoice(id)) return false;
    if (this.voices.length >= this.settings.maxVoices) return false;

    // One gain per voice so the per-source volume never touches the shared bus.
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = clamp01(volume);
    voiceGain.connect(this.sfxGain);

    let durationSec: number;
    let source: AudioBufferSourceNode | undefined;
    if (buffer) {
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(voiceGain);
      source.start(ctx.currentTime);
      durationSec = buffer.duration;
    } else {
      const target: SynthTarget = {
        ctx,
        destination: voiceGain,
        noise: this.noiseBuffer,
        now: ctx.currentTime,
      };
      try {
        durationSec = synth!(target);
      } catch (err) {
        log.warn(`sound "${id}" failed to build: ${String(err)}`);
        return false;
      }
    }
    this.lastPlayedMs.set(id, nowMs);
    this.voices.push({
      id,
      endsAtMs: nowMs + Math.max(0, durationSec) * 1000 + 60,
      gain: voiceGain,
      ...(source ? { source } : {}),
    });
    // Nodes disconnect themselves when the whole graph goes idle; the voice
    // record is bookkeeping for the pool budget only (reaped lazily, no timers).
    return true;
  }

  /**
   * Keep a looping voice alive for one firing source (`key`), starting it on the
   * first call and only adjusting its volume on every call after that.
   *
   * This is how a `fire.mode: "continuous"` weapon sounds: the caller
   * ({@link import("./AudioFeedback.js").AudioFeedback.syncChannels}) drives it
   * from the sim's `channeling` flag every frame, so the recording runs for
   * exactly as long as the beam does. Re-calling it is deliberately a NO-OP for
   * playback — a second start request never layers a second copy and never
   * restarts the file mid-beam (which would stutter the attack each time the
   * beam walks to a new target) — and `volume` is applied live so the loop
   * still fades with the source ship's distance as it moves.
   *
   * Returns true while the loop is running. False means "not looping": muted,
   * not yet unlocked, the id has no `loop` sample, or its file has not decoded
   * yet — in that last case the caller's one-shot synth stand-in is what the
   * player hears, and the loop takes over on a later frame.
   *
   * Loops sit OUTSIDE the voice pool on purpose: they are bounded by the number
   * of weapons actually channelling in view, and a reaper that expired one
   * would silence a beam that is still firing.
   */
  playLoop(key: string, id: string, volume = 1): boolean {
    const existing = this.loops.get(key);
    if (volume <= 0 || this.effectiveVolume <= 0) {
      if (existing) this.stopLoop(key);
      return false;
    }
    if (existing) {
      if (existing.id === id) {
        existing.gain.gain.value = clamp01(volume);
        return true;
      }
      this.stopLoop(key); // same hardpoint, different sound: swap it out
    }
    if (!SOUND_SAMPLES[id]?.loop) return false;
    const ctx = this.ensureContext();
    if (!ctx || !this.sfxGain) return false;
    const buffer = this.samples.bufferFor(id, ctx);
    if (!buffer) return false;

    const gain = ctx.createGain();
    gain.gain.value = clamp01(volume);
    gain.connect(this.sfxGain);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start(ctx.currentTime);
    this.loops.set(key, { id, source, gain });
    return true;
  }

  /** Stop one firing source's loop on a short fade, so the cut is not a click. */
  stopLoop(key: string): void {
    const loop = this.loops.get(key);
    if (!loop) return;
    this.loops.delete(key);
    fadeOutLoop(loop, this.ctx?.currentTime ?? 0);
  }

  /** Live looping voices (dev probe/tests). */
  get activeLoops(): number {
    return this.loops.size;
  }

  /** True while any firing source is looping `id` (dev probe/tests). */
  isLooping(id: string): boolean {
    for (const loop of this.loops.values()) if (loop.id === id) return true;
    return false;
  }

  /** True while a voice for `id` is still scheduled. Call after {@link reapVoices}. */
  private hasLiveVoice(id: string): boolean {
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i]!.id === id) return true;
    return false;
  }

  /** True once `id`'s authored sample is decoded and in use (dev probe/tests). */
  isSampleLoaded(id: string): boolean {
    return this.samples.isLoaded(id);
  }

  /** Number of distinct unknown ids warned about so far (dev probe/tests). */
  get unknownIdCount(): number {
    return this.warnedIds.size;
  }

  /**
   * Cut every in-flight SFX voice right now. Match teardown (`endMatch()` in
   * main.ts) calls this: the page survives the match, so a barrage that was
   * still ringing when the player quit used to play its scheduled tails out
   * over the main menu — the audible half of "the match is still running".
   *
   * Voices are silenced at their OWN gain and unhooked from the bus, never by
   * touching the shared sfx/master gains (those belong to the 5.8 settings
   * screen). Pool bookkeeping is emptied so the next match starts with a full
   * voice budget and no stale retrigger throttle.
   */
  stopAll(): void {
    for (const voice of this.voices) silenceVoice(voice);
    this.voices.length = 0;
    // Channel loops run until told otherwise, so teardown MUST end them or a
    // beam that was firing when the player quit keeps burning over the menu.
    for (const key of [...this.loops.keys()]) this.stopLoop(key);
    this.lastPlayedMs.clear();
  }

  dispose(): void {
    this.detachUnlock?.();
    this.stopAll();
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.noiseBuffer = null;
    // Decoded sample buffers belong to the context that decoded them.
    this.samples.clear();
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
    this.stopAll();
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

/** Ramp one loop down over {@link LOOP_STOP_RAMP_SEC} and stop it at the bottom. */
function fadeOutLoop(loop: Loop, now: number): void {
  const end = now + LOOP_STOP_RAMP_SEC;
  try {
    const param = loop.gain.gain;
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, end);
    loop.source.stop(end);
    loop.source.onended = () => {
      loop.source.disconnect();
      loop.gain.disconnect();
    };
  } catch {
    // A closed context (or a source the browser already reclaimed) needs nothing.
  }
}

/** Silence one voice at its own gain and unhook it from the shared bus. */
function silenceVoice(voice: Voice): void {
  try {
    voice.gain.gain.value = 0;
    voice.gain.disconnect();
    // A sample can be seconds long: stop it outright rather than leaving a
    // muted source running out the rest of the file after teardown.
    voice.source?.stop();
  } catch {
    // A closed context (or a node the browser already reclaimed) needs nothing.
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
