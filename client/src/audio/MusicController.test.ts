import { describe, expect, it, vi } from "vitest";
import { AudioManager } from "./AudioManager.js";
import { MusicController } from "./MusicController.js";
import { DEFAULT_AUDIO_SETTINGS, type MusicSettings } from "./soundIds.js";

class FakeParam {
  value = 1;
  calls: string[] = [];
  setValueAtTime(value: number, time: number): void { this.value = value; this.calls.push(`set:${value}@${time}`); }
  linearRampToValueAtTime(value: number, time: number): void { this.value = value; this.calls.push(`ramp:${value}@${time}`); }
  cancelScheduledValues(time: number): void { this.calls.push(`cancel@${time}`); }
}

class FakeGain {
  gain = new FakeParam();
  connections: unknown[] = [];
  connect(target: unknown): void { this.connections.push(target); }
  disconnect(): void { this.connections.length = 0; }
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  starts: number[] = [];
  stops: (number | undefined)[] = [];
  connections: unknown[] = [];
  connect(target: unknown): void { this.connections.push(target); }
  disconnect(): void { this.connections.length = 0; }
  start(time?: number): void { this.starts.push(time ?? 0); }
  stop(time?: number): void { this.stops.push(time); }
}

class FakeContext {
  currentTime = 10;
  sampleRate = 48000;
  state: "running" | "suspended" = "running";
  destination = {};
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  createGain(): GainNode { const gain = new FakeGain(); this.gains.push(gain); return gain as unknown as GainNode; }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource(); this.sources.push(source); return source as unknown as AudioBufferSourceNode;
  }
  createBuffer(_channels: number, length: number): AudioBuffer {
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
  }
  decodeAudioData(): Promise<AudioBuffer> { return Promise.resolve({ duration: 60 } as AudioBuffer); }
}

const SETTINGS: MusicSettings = {
  enabled: true,
  defaultVolume: 0.5,
  fadeInSec: 1,
  fadeOutSec: 2,
  tracks: {
    menu: { src: "theme/menu.mp3", volume: 0.8, loop: true },
    combat: { src: "theme/combat.ogg", volume: 0.6, loop: true },
  },
  screens: { boot: "menu", menu: "menu", hangar: "menu", shop: null, match: "combat" },
};

function harness(load: (src: string) => Promise<ArrayBuffer> = async () => new ArrayBuffer(4)) {
  const ctx = new FakeContext();
  const audio = new AudioManager({
    settings: { ...DEFAULT_AUDIO_SETTINGS, music: SETTINGS },
    contextFactory: () => ctx as unknown as BaseAudioContext,
    storage: null,
  });
  const logger = { warn: vi.fn() };
  const music = new MusicController(audio, SETTINGS, { load, logger });
  return { ctx, audio, music, logger };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("MusicController", () => {
  it("keeps one source running across screens mapped to the same track", async () => {
    const h = harness();
    h.audio.unlock();
    h.music.setScreen("menu");
    await settle();
    expect(h.music.currentTrackId).toBe("menu");
    expect(h.ctx.sources).toHaveLength(1);

    h.music.setScreen("hangar");
    await settle();
    expect(h.ctx.sources).toHaveLength(1);
    expect(h.ctx.sources[0]!.stops).toHaveLength(0);
  });

  it("crossfades when the mapped track changes", async () => {
    const h = harness();
    h.audio.unlock();
    h.music.setScreen("menu");
    await settle();
    h.music.setScreen("match");
    await settle();

    expect(h.ctx.sources).toHaveLength(2);
    expect(h.ctx.sources[0]!.stops).toEqual([12]);
    expect(h.ctx.gains.at(-1)!.gain.calls).toContain("ramp:0.6@11");
    expect(h.music.currentTrackId).toBe("combat");
  });

  it("remembers a pre-unlock screen and starts after unlock", async () => {
    const load = vi.fn(async () => new ArrayBuffer(4));
    const h = harness(load);
    h.music.setScreen("boot");
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(h.ctx.sources).toHaveLength(0);

    h.audio.unlock();
    await settle();
    expect(load).toHaveBeenCalledWith("theme/menu.mp3");
    expect(h.music.currentTrackId).toBe("menu");
  });

  it("warns once for a missing file and retries on the next request", async () => {
    const load = vi.fn(async () => { throw new Error("missing"); });
    const h = harness(load);
    h.audio.unlock();
    h.music.setScreen("menu");
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);

    h.music.setScreen("menu");
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.ctx.sources).toHaveLength(0);
  });

  it("does no music loading or source work at zero volume", async () => {
    const load = vi.fn(async () => new ArrayBuffer(4));
    const h = harness(load);
    h.audio.setMusicVolume(0);
    h.audio.unlock();
    h.music.setScreen("menu");
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(h.ctx.sources).toHaveLength(0);
  });

  it("resolves explicit null mappings to silence", async () => {
    const h = harness();
    h.audio.unlock();
    h.music.setScreen("menu");
    await settle();
    h.music.setScreen("shop");
    expect(h.music.currentTrackId).toBeNull();
    expect(h.ctx.sources[0]!.stops).toEqual([12]);
  });
});
