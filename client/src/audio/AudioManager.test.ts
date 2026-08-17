import { beforeEach, describe, expect, it } from "vitest";
import { AudioManager, VOLUME_MASTER_KEY, VOLUME_MUSIC_KEY, VOLUME_SFX_KEY } from "./AudioManager.js";
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
    return this.node("bufferSource", {
      buffer: null,
      start: (t: number) => this.started.push(`buf@${t}`),
      stop: () => {},
    });
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
  advance(ms: number): void;
}

function makeAudio(overrides: Partial<AudioSettings> = {}, storage = new FakeStorage()): Harness {
  const ctx = new FakeContext();
  let nowMs = 1000;
  const audio = new AudioManager({
    settings: { ...DEFAULT_AUDIO_SETTINGS, ...overrides },
    contextFactory: () => ctx as unknown as BaseAudioContext,
    storage,
    now: () => nowMs,
  });
  return { audio, ctx, storage, advance: (ms) => (nowMs += ms) };
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
