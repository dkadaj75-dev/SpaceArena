import { createLogger, type MusicScreen } from "@space-arena/shared";
import type { AudioManager } from "./AudioManager.js";
import { DEFAULT_MUSIC_SETTINGS, type MusicSettings, type MusicTrackSettings } from "./soundIds.js";

const log = createLogger("Music");

export interface MusicControllerOptions {
  /** Binary loader seam for tests; production fetches the authored content path. */
  load?: (src: string) => Promise<ArrayBuffer>;
  logger?: Pick<typeof log, "warn">;
}

interface Playback {
  id: string;
  src: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * Screen-routed, theme-authored background music on AudioManager's shared bus.
 * It deliberately owns no AudioContext: autoplay, master volume, persistence,
 * and zero-work-at-zero-volume remain centralized in AudioManager.
 */
export class MusicController {
  private settings: MusicSettings;
  private desiredScreen: MusicScreen | null = null;
  private current: Playback | null = null;
  private revision = 0;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly warnedFailures = new Set<string>();
  private readonly load: (src: string) => Promise<ArrayBuffer>;
  private readonly logger: Pick<typeof log, "warn">;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly audio: AudioManager,
    settings: MusicSettings = DEFAULT_MUSIC_SETTINGS,
    options: MusicControllerOptions = {},
  ) {
    this.settings = settings;
    this.load = options.load ?? loadBinary;
    this.logger = options.logger ?? log;
    this.unsubscribe = audio.onStateChange(() => {
      // Invalidate an in-flight decode/start before reacting to a mute, unmute,
      // unlock, or theme-level audio switch.
      this.revision++;
      void this.reconcile();
    });
  }

  /** Route the app to a music screen. Same-track routes preserve playback time. */
  setScreen(screen: MusicScreen): void {
    this.desiredScreen = screen;
    this.revision++;
    void this.reconcile();
  }

  /** Apply a hot-reloaded theme block without losing the desired screen. */
  applySettings(settings: MusicSettings): void {
    this.settings = settings;
    this.revision++;
    void this.reconcile();
  }

  get currentTrackId(): string | null {
    return this.current?.id ?? null;
  }

  dispose(): void {
    this.unsubscribe();
    this.revision++;
    this.stopImmediately();
    this.buffers.clear();
  }

  private async reconcile(): Promise<void> {
    const revision = this.revision;
    if (!this.settings.enabled || this.audio.effectiveMusicVolume <= 0) {
      this.stopImmediately();
      return;
    }

    const screen = this.desiredScreen;
    const trackId = screen === null ? null : this.settings.screens[screen];
    const track = trackId === null || trackId === undefined ? null : this.settings.tracks[trackId];
    if (!trackId || !track) {
      this.fadeToSilence(this.settings.fadeOutSec);
      return;
    }

    if (this.current?.id === trackId && this.current.src === track.src) {
      this.current.source.loop = track.loop;
      setGain(this.current.gain.gain, track.volume, this.audio.musicContext?.currentTime ?? 0);
      return;
    }

    const ctx = this.audio.acquireContext();
    const destination = this.audio.musicDestination;
    if (!ctx || !destination) return; // desired screen is retained until unlock/unmute

    let buffer: AudioBuffer;
    try {
      buffer = await this.bufferFor(trackId, track, ctx);
    } catch {
      if (revision === this.revision) this.fadeToSilence(this.settings.fadeOutSec);
      return;
    }
    if (revision !== this.revision || this.desiredTrackId() !== trackId) return;
    if (!this.settings.enabled || this.audio.effectiveMusicVolume <= 0) return;

    const freshTrack = this.settings.tracks[trackId];
    if (!freshTrack || freshTrack.src !== track.src) return;
    this.start(trackId, freshTrack, buffer, ctx, destination);
  }

  private desiredTrackId(): string | null {
    return this.desiredScreen === null ? null : (this.settings.screens[this.desiredScreen] ?? null);
  }

  private async bufferFor(id: string, track: MusicTrackSettings, ctx: BaseAudioContext): Promise<AudioBuffer> {
    let pending = this.buffers.get(track.src);
    if (!pending) {
      pending = this.load(track.src).then((bytes) => ctx.decodeAudioData(bytes.slice(0)));
      this.buffers.set(track.src, pending);
    }
    try {
      return await pending;
    } catch (error) {
      // Failed entries are never cached: the next screen request retries, which
      // lets a designer drop in a missing file without reloading the page.
      if (this.buffers.get(track.src) === pending) this.buffers.delete(track.src);
      const warningKey = `${id}\0${track.src}`;
      if (!this.warnedFailures.has(warningKey)) {
        this.warnedFailures.add(warningKey);
        this.logger.warn(`music track "${id}" failed to load from "${track.src}"; staying silent`, { error });
      }
      throw error;
    }
  }

  private start(
    id: string,
    track: MusicTrackSettings,
    buffer: AudioBuffer,
    ctx: BaseAudioContext,
    destination: GainNode,
  ): void {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = track.loop;
    source.connect(gain);
    gain.connect(destination);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      if (this.current?.source === source) this.current = null;
    };
    gain.gain.setValueAtTime(0, now);
    if (this.settings.fadeInSec > 0) gain.gain.linearRampToValueAtTime(track.volume, now + this.settings.fadeInSec);
    else gain.gain.setValueAtTime(track.volume, now);

    const previous = this.current;
    this.current = { id, src: track.src, source, gain };
    source.start(now);
    if (previous) this.fadeOut(previous, this.settings.fadeOutSec, now);
  }

  private fadeToSilence(seconds: number): void {
    const previous = this.current;
    if (!previous) return;
    this.current = null;
    this.fadeOut(previous, seconds, this.audio.musicContext?.currentTime ?? 0);
  }

  private fadeOut(playback: Playback, seconds: number, now: number): void {
    const param = playback.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (seconds > 0) param.linearRampToValueAtTime(0, now + seconds);
    else param.setValueAtTime(0, now);
    try {
      playback.source.stop(now + seconds);
    } catch {
      // A source can already have ended when a non-looping designer track is replaced.
    }
  }

  private stopImmediately(): void {
    const previous = this.current;
    this.current = null;
    if (!previous) return;
    try {
      previous.source.stop();
    } catch {
      // Already-ended non-looping sources need no further teardown.
    }
    previous.source.disconnect();
    previous.gain.disconnect();
  }
}

function setGain(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
}

async function loadBinary(src: string): Promise<ArrayBuffer> {
  const response = await fetch(src, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}
