import { matchMaker } from "@colyseus/core";
import type { ReservedPair, SeatReservationPayload, WaitingEntry } from "./MatchmakingQueue.js";

const GAMEMODE_BY_QUEUE_MODE: Readonly<Record<string, string>> = {
  "duel-1v1": "gamemode.duel-1v1",
};

function payload(
  reservation: Awaited<ReturnType<typeof matchMaker.reserveSeatFor>>,
): SeatReservationPayload {
  return reservation as SeatReservationPayload;
}

/** Create one private room and reserve its only two seats for the paired identities. */
export async function reserveArenaPair(first: WaitingEntry, second: WaitingEntry): Promise<ReservedPair> {
  const gamemode = GAMEMODE_BY_QUEUE_MODE[first.mode];
  if (!gamemode || second.mode !== first.mode) throw new Error(`unsupported matchmaking mode: ${first.mode}`);

  const room = await matchMaker.createRoom("arena", { gamemode, minPlayers: 2, matchmaking: true });
  // Remove it from public matchmaking before the first seat is reserved. Direct
  // reservations still work on a locked room, while join/joinOrCreate cannot
  // admit a third party during the small gap between the two calls.
  await matchMaker.remoteRoomCall(room.roomId, "lock");

  const [firstSeat, secondSeat] = await Promise.all([
    matchMaker.reserveSeatFor(room, first.joinOptions ?? {}, { userId: first.playerKey }),
    matchMaker.reserveSeatFor(room, second.joinOptions ?? {}, { userId: second.playerKey }),
  ]);
  return { first: payload(firstSeat), second: payload(secondSeat) };
}
