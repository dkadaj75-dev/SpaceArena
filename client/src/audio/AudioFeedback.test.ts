import { describe, expect, it, vi } from "vitest";
import type { ConfigService, EntityId, SimEvent } from "@space-arena/shared";
import { AudioFeedback, type AudioPoint } from "./AudioFeedback.js";
import type { AudioManager } from "./AudioManager.js";

const PLAYER = 1;
const NEAR = 2;
const FAR = 3;

/** Every ship fires the same weapon, so one module → one action → one sound id. */
const CONFIGS: Record<string, Record<string, unknown>> = {
  theme: { "theme.default": { id: "theme.default", type: "theme", version: 1, name: "T", audio: {} } },
  module: { "module.laser": { id: "module.laser", type: "module", version: 1, onFire: ["action.zap"] } },
  action: {
    "action.zap": {
      id: "action.zap",
      type: "action",
      version: 1,
      kind: "play_sound",
      params: { sound: "laser_fire", volume: 0.8 },
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
} {
  const play = vi.fn(() => true);
  const audio = { effectiveVolume: 1, play, applySettings: vi.fn() } as unknown as AudioManager;
  const feedback = new AudioFeedback(configService(), PLAYER, audio, {
    listenerPosition: () => positions[PLAYER] ?? null,
    entityPosition: (id) => positions[id] ?? null,
  });
  return { feedback, play };
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
