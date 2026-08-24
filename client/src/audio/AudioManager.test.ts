import { beforeEach, describe, expect, it } from "vitest";
import { AudioManager, VOLUME_MASTER_KEY, VOLUME_MUSIC_KEY, VOLUME_SFX_KEY } from "./AudioManager.js";
import { SAMPLED_SOUND_IDS, SOUND_SAMPLES } from "./samples.js";
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./soundIds.js";
import { SOUND_IDS, SOUND_SYNTHS } from "./synths.js";

/* --- A minimal Web Audio double: records the node graph each synth builds. --- */

interface FakeParam {
  value: number;
  calls: string[];
}

function param(initial = 0): FakeParam {
  const p: FakeParam = { value: initial, calls: [] };
  return Object.assign(p, {
    setValueAtTime: (v: number) => p.calls.push(`set:${v}`),
    linearRampToValueAtTime: (v: number) => p.calls.push(`lin:${v}`),
    exponentialRampToValueAtTime: (v: number) => {
      if (v <= 0) throw new Error("exponentialRampToValueAtTime requires a positive target");
      p.calls.push(`exp:${v}`);
    },
  });
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  state: "running" | "suspended" = "running";
  destination = { kind: "destination", connect: () => {} };
  nodes: { kind: string; connectedTo: unknown[]; disconnected: boolean }[] = [];
  started: string[] = [];
  stopped: string[] = [];

  private node(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const record = { kind, connectedTo: [] as unknown[], disconnected: false };
    this.nodes.push(record);
    return {
      ...extra,
      connect: (target: unknown) => record.connectedTo.push(target),
      disconnect: () => (record.disconnected = true),
    };
  }

  createGain(): Record<string, unknown> {
    return this.node("gain", { gain: param(1) });
  }

  createOscillator(): Record<string, unknown> {
    return this.node("oscillator", {
      type: "sine",
      frequency: param(440),
      start: (t: number) => this.started.push(`osc@${t}`),
      stop: () => {},
    });
  }

  createBufferSource(): Record<string, unknown> {
    const source = this.node("bufferSource", {
      buffer: null,
      start: (t: number) => this.started.push(`buf@${t}`),
      stop: (t?: number) => this.stopped.push(`buf@${t ?? 0}`),
    });
    this.bufferSources.push(source);
    return source;
  }

  /** Every buffer source handed out, so a test can see which buffer it got. */
  bufferSources: Record<string, unknown>[] = [];

  /** Sample decoding double: any bytes become a 2.25s buffer. */
  decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> {
    return Promise.resolve({ duration: 2.25, kind: "decoded" } as unknown as AudioBuffer);
  }

  createBiquadFilter(): Record<string, unknown> {
    return this.node("biquad", { type: "lowpass", frequency: param(1000), Q: param(1) });
  }

  createBuffer(_channels: number, length: number, _rate: number): { getChannelData: () => Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }

  count(kind: string): number {
    return this.nodes.filter((n) => n.kind === kind).length;
  }

  countDisconnected(kind: string): number {
    return this.nodes.filter((n) => n.kind === kind && n.disconnected).length;
  }
}

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface Harness {
  audio: AudioManager;
  ctx: FakeContext;
  storage: FakeStorage;
  /** Sample paths the manager asked for, in request order. */
  requested: string[];
  advance(ms: number): void;
}

/**
 * By default no authored sample ever finishes loading, so every test below sees
 * the synth path — the state the game is in for the first shot of a match, and
 * the one the pre-sample tests were written against. Pass a resolving loader to
 * exercise the sample path.
 */
function makeAudio(
  overrides: Partial<AudioSettings> = {},
  storage = new FakeStorage(),
  loader: (src: string) => Promise<ArrayBuffer> = () => new Promise<ArrayBuffer>(() => {}),
): Harness {
  const ctx = new FakeContext();
  const requested: string[] = [];
  let nowMs = 1000;
  const audio = new AudioManager({
    settings: { ...DEFAULT_AUDIO_SETTINGS, ...overrides },
    contextFactory: () => ctx as unknown as BaseAudioContext,
    storage,
    now: () => nowMs,
    sampleLoader: (src) => {
      requested.push(src);
      return loader(src);
    },
  });
  return { audio, ctx, storage, requested, advance: (ms) => (nowMs += ms) };
}

/** A loader that resolves immediately; the FakeContext decodes it to 2.25s. */
const loadsInstantly = (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(8));

/** Let the fetch → decode → cache promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("AudioManager", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeAudio();
  });

  it("builds no AudioContext until a user gesture unlocks it (autoplay policy)", () => {
    expect(h.audio.play("laser_fire")).toBe(false);
    expect(h.ctx.nodes).toHaveLength(0);

    h.audio.unlock();
    expect(h.audio.play("laser_fire")).toBe(true);
    expect(h.ctx.count("oscillator")).toBeGreaterThan(0);
  });

  it("wires every voice through a per-voice gain into the sfx→master→destination bus", () => {
    h.audio.unlock();
    // Unlock alone builds the master, SFX, and music bus gains; the voice adds its own.
    const busGains = h.ctx.count("gain");
    expect(busGains).toBe(3);
    expect(h.audio.play("kinetic_fire")).toBe(true);
    expect(h.ctx.count("gain")).toBeGreaterThan(busGains);
    expect(h.ctx.count("bufferSource")).toBe(1); // noise burst
    expect(h.ctx.started.length).toBeGreaterThan(0);
  });

  it("owns an independently adjustable music bus under the shared master", () => {
    h.audio.unlock();
    const bus = h.audio.musicDestination as unknown as { gain: FakeParam };
    expect(bus).not.toBeNull();
    expect(bus.gain.value).toBe(0.5);
    h.audio.setMusicVolume(0.2, { persist: false });
    expect(bus.gain.value).toBe(0.2);
    expect(h.audio.effectiveVolume).toBeCloseTo(0.64); // SFX remains unchanged.
  });

  it("does zero work at zero volume — no context, no nodes", () => {
    h.audio.unlock();
    h.audio.setMasterVolume(0);
    const before = h.ctx.nodes.length;
    expect(h.audio.play("laser_fire")).toBe(false);
    expect(h.ctx.nodes.length).toBe(before);
    expect(h.audio.effectiveVolume).toBe(0);

    const muted = makeAudio();
    muted.audio.setMasterVolume(0);
    muted.audio.unlock();
    expect(muted.ctx.nodes).toHaveLength(0);
  });

  it("stays silent when the theme disables audio", () => {
    const off = makeAudio({ enabled: false });
    off.audio.unlock();
    expect(off.audio.play("laser_fire")).toBe(false);
    expect(off.ctx.nodes).toHaveLength(0);
  });

  it("warns once for an unknown sound id and never throws", () => {
    h.audio.unlock();
    expect(() => h.audio.play("no_such_sound")).not.toThrow();
    h.audio.play("no_such_sound");
    h.audio.play("also_missing");
    expect(h.audio.unknownIdCount).toBe(2);
  });

  it("throttles retriggers of the same id and caps concurrent voices", () => {
    const pooled = makeAudio({ maxVoices: 2, retriggerGapMs: 50 });
    pooled.audio.unlock();
    expect(pooled.audio.play("laser_fire")).toBe(true);
    expect(pooled.audio.play("laser_fire")).toBe(false); // inside the retrigger gap
    pooled.advance(60);
    expect(pooled.audio.play("laser_fire")).toBe(true);
    // Two voices are live; a third distinct sound is dropped by the budget.
    expect(pooled.audio.play("kinetic_fire")).toBe(false);
    // ...until the earlier voices' tails have passed.
    pooled.advance(5000);
    expect(pooled.audio.play("kinetic_fire")).toBe(true);
  });

  it("stopAll() cuts every in-flight voice so a match's SFX cannot ring out over the menu", () => {
    const pooled = makeAudio({ maxVoices: 4, retriggerGapMs: 50 });
    pooled.audio.unlock();
    expect(pooled.audio.play("laser_fire")).toBe(true);
    expect(pooled.audio.play("kinetic_fire")).toBe(true);
    expect(pooled.audio.activeVoices).toBe(2);

    pooled.audio.stopAll();

    expect(pooled.audio.activeVoices).toBe(0);
    // Exactly the two per-voice gains are unhooked from the bus. The three bus
    // gains (master/sfx/music) stay wired — those belong to the settings
    // screen, not to match teardown — and so does the master volume.
    expect(pooled.ctx.countDisconnected("gain")).toBe(2);
    expect(pooled.audio.effectiveVolume).toBeGreaterThan(0);
    // The retrigger throttle is reset too, so the next match starts clean.
    expect(pooled.audio.play("laser_fire")).toBe(true);
  });

  it("stopAll() is safe with nothing playing and before any unlock", () => {
    expect(() => h.audio.stopAll()).not.toThrow();
    h.audio.unlock();
    expect(() => h.audio.stopAll()).not.toThrow();
    expect(h.audio.activeVoices).toBe(0);
  });

  it("reads volumes from storage and persists changes", () => {
    const storage = new FakeStorage();
    storage.setItem(VOLUME_MASTER_KEY, "0.25");
    const restored = makeAudio({}, storage);
    expect(restored.audio.masterVolume).toBe(0.25);
    expect(restored.audio.sfxVolume).toBe(0.8); // theme default, nothing stored

    restored.audio.setSfxVolume(0.5);
    expect(storage.getItem(VOLUME_SFX_KEY)).toBe("0.5");
    expect(restored.audio.effectiveVolume).toBeCloseTo(0.125);

    restored.audio.setMusicVolume(0.35);
    expect(storage.getItem(VOLUME_MUSIC_KEY)).toBe("0.35");
    expect(restored.audio.musicVolume).toBe(0.35);
    expect(restored.audio.effectiveMusicVolume).toBeCloseTo(0.0875);
  });

  it("falls back to the synth while an authored sample has not decoded yet", () => {
    h.audio.unlock();
    // kinetic_fire is sampled, but the default loader never resolves.
    expect(h.audio.play("kinetic_fire")).toBe(true);
    expect(h.requested).toEqual([SOUND_SAMPLES["kinetic_fire"]!.src]);
    expect(h.audio.isSampleLoaded("kinetic_fire")).toBe(false);
    // The synth's own oscillator + noise burst, not a decoded buffer.
    expect(h.ctx.count("oscillator")).toBeGreaterThan(0);
    expect(h.ctx.bufferSources.some((s) => (s["buffer"] as { kind?: string })?.kind === "decoded")).toBe(false);
    // ...and the file is only ever asked for once, however often we fire.
    h.advance(1000);
    expect(h.audio.play("kinetic_fire")).toBe(true);
    expect(h.requested).toHaveLength(1);
  });

  it("stays on the synth forever when the sample fails to load", async () => {
    const broken = makeAudio({}, new FakeStorage(), () => Promise.reject(new Error("404")));
    broken.audio.unlock();
    expect(broken.audio.play("kinetic_fire")).toBe(true);
    await settle();
    expect(broken.audio.isSampleLoaded("kinetic_fire")).toBe(false);
    broken.advance(1000);
    expect(broken.audio.play("kinetic_fire")).toBe(true); // audible, just synthesized
    expect(broken.requested).toHaveLength(1); // a dead file is not re-fetched every shot
  });

  it("plays the decoded sample through the same per-voice gain once it is ready", async () => {
    const sampled = makeAudio({}, new FakeStorage(), loadsInstantly);
    sampled.audio.unlock();
    sampled.audio.play("kinetic_fire"); // kicks the load off (synth this time)
    await settle();
    expect(sampled.audio.isSampleLoaded("kinetic_fire")).toBe(true);

    sampled.advance(1000);
    const oscillatorsBefore = sampled.ctx.count("oscillator");
    expect(sampled.audio.play("kinetic_fire", 0.5)).toBe(true);
    // No synth ran; a buffer source carrying the decoded buffer did.
    expect(sampled.ctx.count("oscillator")).toBe(oscillatorsBefore);
    const voice = sampled.ctx.bufferSources.at(-1)!;
    expect((voice["buffer"] as { kind?: string }).kind).toBe("decoded");
    // Per-request volume still scales the voice's own gain, exactly as for synths.
    const voiceGain = sampled.ctx.nodes.filter((n) => n.kind === "gain").at(-1);
    expect(voiceGain).toBeDefined();
  });

  it("loops a channel sample for one firing source without ever stacking a second copy", async () => {
    const sampled = makeAudio({ maxVoices: 8 }, new FakeStorage(), loadsInstantly);
    sampled.audio.unlock();
    expect(sampled.audio.playLoop("ship7:0:beam_fire", "beam_fire")).toBe(false); // still decoding
    await settle();

    expect(sampled.audio.playLoop("ship7:0:beam_fire", "beam_fire", 0.8)).toBe(true);
    expect(sampled.audio.activeLoops).toBe(1);
    expect(sampled.audio.isLooping("beam_fire")).toBe(true);
    const source = sampled.ctx.bufferSources.at(-1)!;
    expect(source["loop"]).toBe(true);
    expect((source["buffer"] as { kind?: string }).kind).toBe("decoded");

    // Every later frame of the same channel re-asserts the loop: no new source,
    // no restart — only the (distance-scaled) volume moves.
    const sourcesAfterStart = sampled.ctx.bufferSources.length;
    expect(sampled.audio.playLoop("ship7:0:beam_fire", "beam_fire", 0.4)).toBe(true);
    expect(sampled.audio.playLoop("ship7:0:beam_fire", "beam_fire", 0.4)).toBe(true);
    expect(sampled.ctx.bufferSources.length).toBe(sourcesAfterStart);
    expect(sampled.audio.activeLoops).toBe(1);

    // A second ship beaming is its own firing source, and so its own loop.
    expect(sampled.audio.playLoop("ship9:0:beam_fire", "beam_fire")).toBe(true);
    expect(sampled.audio.activeLoops).toBe(2);

    // Release: the loop stops (on a ramp, not a hard cut).
    const loopGain = sampled.ctx.nodes.filter((n) => n.kind === "gain").at(-2)!;
    sampled.audio.stopLoop("ship7:0:beam_fire");
    expect(sampled.audio.activeLoops).toBe(1);
    // Stopped a ramp-length after now, never at `now` — that fade is what keeps
    // the end of a beam from clicking.
    expect(sampled.ctx.stopped.at(-1)).toBe(`buf@${sampled.ctx.currentTime + 0.05}`);
    expect(loopGain.disconnected).toBe(false); // unhooked by `onended`, not up front
    // Stopping an already-stopped source is a no-op, not a throw.
    expect(() => sampled.audio.stopLoop("ship7:0:beam_fire")).not.toThrow();

    // Teardown ends what is left, or a beam would burn on over the main menu.
    sampled.audio.stopAll();
    expect(sampled.audio.activeLoops).toBe(0);
  });

  it("leaves the one-shot path to the synth for a looping id, and silent once it can loop", async () => {
    const sampled = makeAudio({}, new FakeStorage(), loadsInstantly);
    sampled.audio.unlock();
    // Undecoded: the fire event's stand-in is the synth, so the beam is audible
    // from its very first frame.
    expect(sampled.audio.play("beam_fire")).toBe(true);
    expect(sampled.ctx.count("oscillator")).toBeGreaterThan(0);
    await settle();

    // Decoded: the loop owns this sound, so the one-shot path stands down
    // rather than firing a second, non-looping copy alongside it.
    sampled.advance(5000);
    expect(sampled.audio.play("beam_fire")).toBe(false);

    // The synth stand-in does not stack on a re-announced channel either.
    const undecoded = makeAudio();
    undecoded.audio.unlock();
    expect(undecoded.audio.play("beam_fire")).toBe(true);
    undecoded.advance(500);
    expect(undecoded.audio.play("beam_fire")).toBe(false);
  });

  it("keeps the discrete autocannon sample overlapping freely (it is not a channel)", async () => {
    const sampled = makeAudio({ maxVoices: 8, retriggerGapMs: 45 }, new FakeStorage(), loadsInstantly);
    sampled.audio.unlock();
    sampled.audio.play("kinetic_fire");
    await settle();
    sampled.advance(1000);
    expect(sampled.audio.play("kinetic_fire")).toBe(true);
    sampled.advance(100);
    expect(sampled.audio.play("kinetic_fire")).toBe(true);
    expect(sampled.audio.activeVoices).toBe(2);
    // ...and it is never eligible for looping.
    expect(sampled.audio.playLoop("ship7:1:kinetic_fire", "kinetic_fire")).toBe(false);
  });

  it("keeps a synth fallback registered for every sampled id", () => {
    expect(SAMPLED_SOUND_IDS.length).toBeGreaterThan(0);
    for (const id of SAMPLED_SOUND_IDS) {
      expect(SOUND_SYNTHS[id], `sampled id ${id} needs a synth fallback`).toBeTypeOf("function");
      expect(SOUND_SAMPLES[id]!.src).toMatch(/^content\/sounds\/.+\.(wav|mp3)$/);
    }
  });

  it("builds a working node graph for every registered sound id", () => {
    h.audio.unlock();
    for (const id of SOUND_IDS) {
      h.ctx.currentTime += 1; // fresh schedule window per sound
      h.advance(1000); // clear the retrigger gap and the voice pool
      expect(h.audio.play(id), `sound ${id} should play`).toBe(true);
    }
    expect(SOUND_IDS.length).toBe(Object.keys(SOUND_SYNTHS).length);
  });
});
