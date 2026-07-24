import { Client, type Room } from "colyseus.js";
import {
  MSG_FIRE_EVENT,
  MSG_ORDER_ACK,
  MSG_SIM_EVENT,
  createLogger,
  type FireEventMessage,
  type OrderAckMessage,
  type SimEventMessage,
} from "@space-arena/shared";
import { wsServerUrl } from "../core/serverConfig.js";

const log = createLogger("NetClient");

export interface ArenaJoinOptions {
  gamemode: string;
  arena?: string;
  shipId?: string;
  practiceTarget?: boolean;
  minPlayers?: number;
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
  onStateChange: ((connected: boolean, error?: unknown) => void) | null = null;

  async connect(options: ArenaJoinOptions, url = wsServerUrl()): Promise<Room> {
    const client = new Client(url);
    const room = await client.joinOrCreate("arena", options);
    this.room = room;
    this.connected = true;
    room.onMessage(MSG_ORDER_ACK, (m: OrderAckMessage) => this.onOrderAck?.(m));
    room.onMessage(MSG_FIRE_EVENT, (m: FireEventMessage) => this.onFireEvent?.(m));
    room.onMessage(MSG_SIM_EVENT, (m: SimEventMessage) => this.onSimEvent?.(m));
    room.onLeave((code) => {
      this.connected = false;
      this.onStateChange?.(false, code);
    });
    this.onStateChange?.(true);
    return room;
  }

  dispose(): void {
    const room = this.room;
    this.room = null;
    this.connected = false;
    if (room) void room.leave();
    log.debug("disposed");
  }
}
