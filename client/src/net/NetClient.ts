import { Client, type Room, type SeatReservation } from "colyseus.js";
import {
  MSG_FIRE_EVENT,
  MSG_ORDER_ACK,
  MSG_SIM_EVENT,
  MSG_MATCH_STATS,
  createLogger,
  type FireEventMessage,
  type OrderAckMessage,
  type SimEventMessage,
  type MatchStatsMessage,
} from "@space-arena/shared";
import { wsServerUrl } from "../core/serverConfig.js";

const log = createLogger("NetClient");

export interface ArenaJoinOptions {
  gamemode: string;
  arena?: string;
  shipId?: string;
  /**
   * Saved fitting id (`/api/fittings`) to spawn with. `ArenaRoom.resolveFitting`
   * (server/src/rooms/ArenaRoom.ts) loads it — ship + hardpointMap — when the
   * joining user owns it; falls back to `shipId`'s `defaultFitting` otherwise.
   * Additive client-side option: the server has accepted this since Phase 3
   * (see `ArenaRoom.test.ts`), the client just didn't send it yet (Hangar 4.5).
   */
  fittingId?: string;
  /**
   * Paint to fly in (`cosmetic.*`). Omitted ⇒ the server uses the account's
   * saved selection for the spawned hull. The room validates ownership and
   * target and quietly flies the base skin on anything else, so this is a
   * request, never an instruction.
   */
  cosmeticId?: string;
  /** Access token for authenticated join; omitted for DEV_ALLOW_ANON solo testing. */
  token?: string;
}

/** Thin Colyseus lifecycle wrapper; state decoding belongs to NetGameSession. */
export class NetClient {
  room: Room | null = null;
  connected = false;
  onOrderAck: ((message: OrderAckMessage) => void) | null = null;
  onFireEvent: ((message: FireEventMessage) => void) | null = null;
  onSimEvent: ((message: SimEventMessage) => void) | null = null;
  onMatchStats: ((message: MatchStatsMessage) => void) | null = null;
  onStateChange: ((connected: boolean, error?: unknown) => void) | null = null;

  async connect(options: ArenaJoinOptions, url = wsServerUrl(), reservation?: SeatReservation): Promise<Room> {
    const client = new Client(url);
    const room = reservation
      ? await client.consumeSeatReservation(reservation)
      : await client.joinOrCreate("arena", options);
    this.room = room;
    this.connected = true;
    room.onMessage(MSG_ORDER_ACK, (m: OrderAckMessage) => this.onOrderAck?.(m));
    room.onMessage(MSG_FIRE_EVENT, (m: FireEventMessage) => this.onFireEvent?.(m));
    room.onMessage(MSG_SIM_EVENT, (m: SimEventMessage) => this.onSimEvent?.(m));
    room.onMessage(MSG_MATCH_STATS, (m: MatchStatsMessage) => this.onMatchStats?.(m));
    room.onLeave((code) => {
      this.connected = false;
      this.onStateChange?.(false, code);
    });
    this.onStateChange?.(true);
    return room;
  }

  /**
   * Leave the room and make sure nothing this client owns can be called again.
   *
   * Order matters. The listeners come off FIRST: `leave()` is asynchronous, and
   * a patch or a message that lands in the window before the socket actually
   * closes would otherwise decode into a session the app has already thrown
   * away (schema callbacks included — `removeAllListeners` clears the decoder's
   * too). The local callbacks are nulled for the same reason, and because they
   * hold the dead session alive through this object.
   *
   * The leave is always CONSENTED: a user-initiated quit must not leave the
   * server holding a reconnection window with a ghost ship in the arena
   * (`ArenaRoom.onLeave` → `removePlayer`). The room itself keeps running for
   * everyone else. Idempotent, and never throws into a teardown sequence.
   */
  dispose(): void {
    const room = this.room;
    this.room = null;
    this.connected = false;
    this.onOrderAck = null;
    this.onFireEvent = null;
    this.onSimEvent = null;
    this.onMatchStats = null;
    this.onStateChange = null;
    if (room) {
      try {
        room.removeAllListeners();
        void room.leave(true).catch((err: unknown) => log.warn("room.leave failed", err));
      } catch (err) {
        log.warn("room teardown failed", err);
      }
    }
    log.debug("disposed");
  }
}
