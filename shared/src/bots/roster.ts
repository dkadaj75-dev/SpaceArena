import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { GamemodeConfig } from "../schemas/gamemode.js";

/** Default ship a bot flies when neither the slot nor the gamemode names one. */
export const DEFAULT_BOT_SHIP = "ship.interceptor";

/** One concrete bot to spawn: resolved profile config + ship id + team. */
export interface ResolvedBotSlot {
  profile: BotprofileConfig;
  shipId: string;
  team: number;
  fitting?: readonly (string | null)[];
}

/**
 * Flatten a gamemode's `bots.roster` (count-expanded) into concrete spawn slots,
 * resolving profile ids against the config registry. Unknown profile/ship ids are
 * skipped (content validation already reports them as dangling references, and a
 * bad bot must never take a match down). Deterministic order.
 */
export function resolveBotRoster(gamemode: GamemodeConfig, configs: ConfigService): ResolvedBotSlot[] {
  const bots = gamemode.bots;
  const out: ResolvedBotSlot[] = [];
  if (!bots?.roster) return out;
  for (const slot of bots.roster) {
    const profile = configs.get<BotprofileConfig>("botprofile", slot.profile);
    if (!profile) continue;
    const shipId = slot.ship ?? bots.defaultShip ?? DEFAULT_BOT_SHIP;
    if (!configs.get("ship", shipId)) continue;
    for (let i = 0; i < (slot.count ?? 1); i++) {
      out.push({ profile, shipId, team: slot.team, fitting: slot.fitting });
    }
  }
  return out;
}

/**
 * The backfill profile+ship for a gamemode: its `bots.defaultProfile`, falling
 * back to `fallbackProfileId` (a room option). Returns null when the gamemode
 * declares no bots and no fallback resolves — i.e. backfill is off.
 */
export function resolveBackfillBot(
  gamemode: GamemodeConfig,
  configs: ConfigService,
  fallbackProfileId?: string,
): { profile: BotprofileConfig; shipId: string } | null {
  const id = fallbackProfileId ?? gamemode.bots?.defaultProfile;
  if (!id) return null;
  const profile = configs.get<BotprofileConfig>("botprofile", id);
  if (!profile) return null;
  const shipId = gamemode.bots?.defaultShip ?? DEFAULT_BOT_SHIP;
  if (!configs.get("ship", shipId)) return null;
  return { profile, shipId };
}

/** Ships per team implied by a gamemode's `teams` string. */
export function teamSizeOf(gamemode: GamemodeConfig): number {
  return gamemode.teams === "2v2" ? 2 : 1;
}
