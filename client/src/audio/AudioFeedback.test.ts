import { describe, expect, it, vi } from "vitest";
import type { ConfigService, EntityId, ShipSnapshot, SimEvent } from "@space-arena/shared";
import { AudioFeedback, type AudioPoint } from "./AudioFeedback.js";
import type { AudioManager } from "./AudioManager.js";

const PLAYER = 1;
const NEAR = 2;
const FAR = 3;

/** Every ship fires the same weapon, so one module → one action → one sound id. */
const CONFIGS: Record<string, Record<string, unknown>> = {
  theme: { "theme.default": { id: "theme.default", type: "theme", version: 1, name: "T", audio: {} } },
  module: {
    "module.laser": { id: "module.laser", type: "module", version: 1, onFire: ["action.zap"] },
    "module.beam": { id: "module.beam", type: "module", version: 1, onFire: ["action.beam"] },
  },
  action: {
    "action.zap": {
      id: "action.zap",
      type: "action",
      version: 1,
      kind: "play_sound",
      params: { sound: "laser_fire", volume: 0.8 },
    },
    "action.beam": {
      id: "action.beam",
      type: "action",
      version: 1,
      kind: "play_sound",
      params: { sound: "beam_fire", volume: 0.8 },
    },
  },
};

function configService(): ConfigService {
  return {
    get: (type: string, id: string) => CONFIGS[type]?.[id],
    getAll: () => [],
  } as unknown as ConfigService;
}

function fire(ownerId: EntityId): SimEvent {
  return { type: "projectileFired", ownerId, moduleId: "module.laser", kind: "beam", targetId: PLAYER };
}

/** Positions on the x axis: the player at the origin, everyone else out along it. */
const POSITIONS: Record<number, AudioPoint> = {
  [PLAYER]: { x: 0, y: 0, z: 0 },
  [NEAR]: { x: 400, y: 0, z: 0 },
  [FAR]: { x: 480, y: 0, z: 0 },
};

function build(positions: Record<number, AudioPoint> = POSITIONS): {
  feedback: AudioFeedback;
  play: ReturnType<typeof vi.fn>;
  playLoop: ReturnType<typeof vi.fn>;
  stopLoop: ReturnType<typeof vi.fn>;
} {
  const play = vi.fn(() => true);
  const playLoop = vi.fn(() => true);
  const stopLoop = vi.fn();
  const audio = {
    effectiveVolume: 1,
    play,
    playLoop,
    stopLoop,
    applySettings: vi.fn(),
  } as unknown as AudioManager;
  const feedback = new AudioFeedback(configService(), PLAYER, audio, {
    listenerPosition: () => positions[PLAYER] ?? null,
    entityPosition: (id) => positions[id] ?? null,
  });
  return { feedback, play, playLoop, stopLoop };
}

/** One ship with one weapon, channelling or not — the shape syncChannels reads. */
function channellingShip(id: EntityId, channeling: boolean, moduleId = "module.beam"): ShipSnapshot {
  return {
    id,
    modules: [{ moduleId, hardpointIndex: 0, channeling }],
  } as unknown as ShipSnapshot;
}

describe("AudioFeedback distance fade", () => {
  it("plays another ship's weapon at the authored volume scaled by distance", () => {
    const { feedback, play } = build();
    feedback.consumeEvents([fire(NEAR)]);
    // 400 units → half gain, on top of the action's authored 0.8.
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0]![0]).toBe("laser_fire");
    expect(play.mock.calls[0]![1] as number).toBeCloseTo(0.4, 6);
  });

  it("never attenuates the local player's own weapon", () => {
    const { feedback, play } = build({ ...POSITIONS, [PLAYER]: { x: 0, y: 0, z: 0 } });
    feedback.consumeEvents([fire(PLAYER)]);
    expect(play).toHaveBeenCalledWith("laser_fire", 0.8);
  });

  it("skips a source past the silence radius entirely", () => {
    const { feedback, play } = build({ ...POSITIONS, [FAR]: { x: 900, y: 0, z: 0 } });
    feedback.consumeEvents([fire(FAR)]);
    expect(play).not.toHaveBeenCalled();
  });

  it("plays a deduped sound at the volume of the CLOSEST source", () => {
    const { feedback, play } = build();
    // Far first: the frame's single voice must still take the near ship's gain.
    feedback.consumeEvents([fire(FAR), fire(NEAR)]);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0]![1] as number).toBeCloseTo(0.4, 6);
  });

  it("falls back to full volume when a source cannot be placed", () => {
    const { feedback, play } = build();
    feedback.consumeEvents([fire(99)]);
    expect(play).toHaveBeenCalledWith("laser_fire", 0.8);
  });
});

describe("AudioFeedback channel loops", () => {
  it("keeps one loop alive per channelling weapon and stops it when the beam stops", () => {
    const { feedback, playLoop, stopLoop } = build();

    // Frame 1: the beam opens.
    feedback.syncChannels([channellingShip(PLAYER, true)]);
    expect(playLoop).toHaveBeenCalledTimes(1);
    const [key, id, volume] = playLoop.mock.calls[0] as [string, string, number];
    expect(id).toBe("beam_fire");
    expect(volume).toBe(0.8); // the local player's own beam is never attenuated
    expect(key).toContain("beam_fire");
    expect(stopLoop).not.toHaveBeenCalled();

    // Frames 2-3: still burning. The manager is re-asserted with the SAME key,
    // which is what makes it a no-op rather than a second copy or a restart.
    feedback.syncChannels([channellingShip(PLAYER, true)]);
    feedback.syncChannels([channellingShip(PLAYER, true)]);
    expect(playLoop).toHaveBeenCalledTimes(3);
    expect(new Set(playLoop.mock.calls.map((c) => c[0])).size).toBe(1);
    expect(stopLoop).not.toHaveBeenCalled();

    // Frame 4: trigger released — the sim clears `channeling` and the loop ends.
    feedback.syncChannels([channellingShip(PLAYER, false)]);
    expect(stopLoop).toHaveBeenCalledWith(key);
    // ...and stays stopped without being told again every frame.
    feedback.syncChannels([channellingShip(PLAYER, false)]);
    expect(stopLoop).toHaveBeenCalledTimes(1);
  });

  it("gives each firing source its own loop and fades them by distance", () => {
    const { feedback, playLoop } = build();
    feedback.syncChannels([channellingShip(PLAYER, true), channellingShip(NEAR, true)]);
    expect(playLoop).toHaveBeenCalledTimes(2);
    const keys = playLoop.mock.calls.map((c) => c[0] as string);
    expect(new Set(keys).size).toBe(2);
    // NEAR sits at 400 units — half gain on top of the authored 0.8.
    expect(playLoop.mock.calls[1]![2] as number).toBeCloseTo(0.4, 6);
  });

  it("stops a beam that has faded out of earshot instead of looping it silently", () => {
    const { feedback, playLoop, stopLoop } = build({ ...POSITIONS, [FAR]: { x: 900, y: 0, z: 0 } });
    feedback.syncChannels([channellingShip(FAR, true)]);
    expect(playLoop).not.toHaveBeenCalled();
    expect(stopLoop).not.toHaveBeenCalled(); // never started, nothing to stop
  });

  it("ends every channel loop on teardown", () => {
    const { feedback, playLoop, stopLoop } = build();
    feedback.syncChannels([channellingShip(PLAYER, true), channellingShip(NEAR, true)]);
    feedback.dispose();
    expect(stopLoop).toHaveBeenCalledTimes(2);
    // A late frame after teardown must not restart anything.
    playLoop.mockClear();
    feedback.syncChannels([channellingShip(PLAYER, true)]);
    expect(playLoop).not.toHaveBeenCalled();
  });

  it("ignores a module with no play_sound hook", () => {
    const { feedback, playLoop } = build();
    feedback.syncChannels([channellingShip(PLAYER, true, "module.missing")]);
    expect(playLoop).not.toHaveBeenCalled();
  });
});
