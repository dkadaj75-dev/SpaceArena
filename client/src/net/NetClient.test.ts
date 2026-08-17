import { describe, expect, it } from "vitest";
import { NetClient } from "./NetClient.js";

/**
 * The client half of match teardown. The page outlives the match (main.ts), so
 * a room that is still wired when the player is back on the menu keeps decoding
 * patches into a session nobody owns — the "match still running in the
 * background" report — and a non-consented exit leaves the SERVER holding a
 * reconnection window with a ghost ship in the arena.
 */

interface FakeRoom {
  removedAllListeners: number;
  leaveCalls: (boolean | undefined)[];
  removeAllListeners(): void;
  leave(consented?: boolean): Promise<number>;
}

function fakeRoom(overrides: Partial<FakeRoom> = {}): FakeRoom {
  const room: FakeRoom = {
    removedAllListeners: 0,
    leaveCalls: [],
    removeAllListeners() {
      room.removedAllListeners++;
    },
    leave(consented?: boolean) {
      room.leaveCalls.push(consented);
      return Promise.resolve(4000);
    },
    ...overrides,
  };
  return room;
}

function attach(client: NetClient, room: FakeRoom): void {
  (client as unknown as { room: unknown }).room = room;
  client.connected = true;
  client.onOrderAck = () => {};
  client.onFireEvent = () => {};
  client.onSimEvent = () => {};
  client.onMatchStats = () => {};
  client.onStateChange = () => {};
}

describe("NetClient.dispose", () => {
  it("detaches every listener and callback, then leaves the room CONSENTED", () => {
    const client = new NetClient();
    const room = fakeRoom();
    attach(client, room);

    client.dispose();

    expect(room.removedAllListeners).toBe(1);
    expect(room.leaveCalls).toEqual([true]); // consented — no server-side ghost ship
    expect(client.room).toBeNull();
    expect(client.connected).toBe(false);
    expect(client.onOrderAck).toBeNull();
    expect(client.onFireEvent).toBeNull();
    expect(client.onSimEvent).toBeNull();
    expect(client.onMatchStats).toBeNull();
    expect(client.onStateChange).toBeNull();
  });

  it("is idempotent — a second dispose leaves the room alone", () => {
    const client = new NetClient();
    const room = fakeRoom();
    attach(client, room);

    client.dispose();
    client.dispose();

    expect(room.leaveCalls).toEqual([true]);
  });

  it("never throws into the teardown sequence when the socket misbehaves", async () => {
    const client = new NetClient();
    const throwing = fakeRoom({
      removeAllListeners() {
        throw new Error("socket already gone");
      },
    });
    attach(client, throwing);
    expect(() => client.dispose()).not.toThrow();
    expect(client.room).toBeNull();

    const rejecting = fakeRoom({ leave: () => Promise.reject(new Error("closed")) });
    const second = new NetClient();
    attach(second, rejecting);
    expect(() => second.dispose()).not.toThrow();
    // A rejected leave must not surface as an unhandled rejection.
    await Promise.resolve();
    expect(second.connected).toBe(false);
  });

  it("does nothing when there was never a room (offline / failed join)", () => {
    const client = new NetClient();
    expect(() => client.dispose()).not.toThrow();
    expect(client.room).toBeNull();
  });
});
