import type { HardpointMap, UpgradeTrackName } from "@space-arena/shared";
import { getDb } from "./index.js";

/**
 * Typed repository layer over the SQLite schema. Every function uses the shared
 * {@link getDb} singleton and better-sqlite3's synchronous API, so callers never
 * await. Row shapes mirror the migration columns 1:1.
 */

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** `users.role` values (migration 003). */
export type UserRole = "player" | "admin";

export interface UserRow {
  id: string;
  email: string | null;
  pass_hash: string | null;
  guest_token: string | null;
  created_at: number;
  /** 'player' by default; 'admin' unlocks the operator endpoints (§11 6.7). */
  role: UserRole;
}

export interface ProfileRow {
  user_id: string;
  display_name: string;
  level: number;
  xp: number;
  credits: number;
}

export interface ShipUpgradeRow {
  user_id: string;
  ship_id: string;
  hull_lvl: number;
  engine_lvl: number;
  energy_lvl: number;
  heat_lvl: number;
}

export interface OwnedModuleRow {
  user_id: string;
  module_id: string;
  qty: number;
}

export interface FittingRow {
  id: string;
  user_id: string;
  ship_id: string;
  name: string;
  hardpointMap: HardpointMap;
  created_at: number;
}

export interface UserConfigRow {
  id: string;
  user_id: string;
  type: string;
  json: string;
  visibility: string;
  updated_at: number;
}

export interface MatchResultRow {
  id: string;
  mode: string;
  arena_id: string;
  participants: string;
  winner_team: number | null;
  duration_s: number;
  rewards_eligible: number;
  created_at: number;
  /** Colyseus room id (telemetry, 6.8). NULL on rows written before migration 004. */
  room_id: string | null;
  /** Humans who joined at any point. 0 on pre-004 rows — "not recorded", not "nobody". */
  player_count: number;
  /** Bots spawned by backfill. 0 on pre-004 rows. */
  bot_count: number;
}

/** One anonymous client report (telemetry, 6.8). Carries no user id by design. */
export interface ClientMetricRow {
  id: string;
  session_hash: string;
  fps_bucket: string;
  device_class: string;
  quality_tier: string;
  created_at: number;
}

/** One periodic server rollup (telemetry, 6.8). */
export interface ServerMetricRow {
  id: string;
  sampled_at: number;
  room_count: number;
  client_count: number;
  tick_avg_ms: number;
  tick_p95_ms: number;
  tick_max_ms: number;
  tick_samples: number;
  rss_bytes: number;
  heap_used_bytes: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_hash: string;
  expires_at: number;
  created_at: number;
}

const TRACK_COLUMN: Record<UpgradeTrackName, keyof ShipUpgradeRow> = {
  hull: "hull_lvl",
  engine: "engine_lvl",
  energy: "energy_lvl",
  heat: "heat_lvl",
};

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const usersRepo = {
  create(row: Omit<UserRow, "created_at" | "role"> & { created_at?: number }): UserRow {
    const created_at = row.created_at ?? Date.now();
    getDb()
      .prepare(
        "INSERT INTO users (id, email, pass_hash, guest_token, created_at) VALUES (@id, @email, @pass_hash, @guest_token, @created_at)",
      )
      .run({ ...row, email: row.email ?? null, pass_hash: row.pass_hash ?? null, guest_token: row.guest_token ?? null, created_at });
    // `role` is not in the INSERT: the column defaults to 'player' (migration 003),
    // so a new account can never be created as an admin by accident.
    return {
      ...row,
      email: row.email ?? null,
      pass_hash: row.pass_hash ?? null,
      guest_token: row.guest_token ?? null,
      created_at,
      role: "player",
    };
  },
  byId(id: string): UserRow | undefined {
    return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  },
  byEmail(email: string): UserRow | undefined {
    return getDb().prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  },
  byGuestToken(token: string): UserRow | undefined {
    return getDb().prepare("SELECT * FROM users WHERE guest_token = ?").get(token) as UserRow | undefined;
  },
  /** Promote a guest to a full account in place, keeping the same id + progress. */
  upgradeGuest(id: string, email: string, passHash: string): void {
    getDb()
      .prepare("UPDATE users SET email = ?, pass_hash = ?, guest_token = NULL WHERE id = ?")
      .run(email, passHash, id);
  },
  /**
   * Role of a user, or undefined when the id is unknown. Read on every admin
   * request rather than baked into the JWT, so revoking an admin takes effect on
   * the next call instead of on the next token expiry.
   */
  roleOf(id: string): UserRole | undefined {
    const row = getDb().prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: UserRole } | undefined;
    return row?.role;
  },
  /** Set a user's role (used by tools/create-admin.ts and the dev-login route). */
  setRole(id: string, role: UserRole): void {
    getDb().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  },
};

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

export const profilesRepo = {
  create(row: { user_id: string; display_name: string; level?: number; xp?: number; credits?: number }): ProfileRow {
    const full: ProfileRow = {
      user_id: row.user_id,
      display_name: row.display_name,
      level: row.level ?? 1,
      xp: row.xp ?? 0,
      credits: row.credits ?? 0,
    };
    getDb()
      .prepare(
        "INSERT INTO profiles (user_id, display_name, level, xp, credits) VALUES (@user_id, @display_name, @level, @xp, @credits)",
      )
      .run(full);
    return full;
  },
  byUser(userId: string): ProfileRow | undefined {
    return getDb().prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId) as ProfileRow | undefined;
  },
  displayNameExists(displayName: string): boolean {
    return getDb().prepare("SELECT 1 FROM profiles WHERE display_name = ? LIMIT 1").get(displayName) !== undefined;
  },
  setDisplayName(userId: string, name: string): void {
    getDb().prepare("UPDATE profiles SET display_name = ? WHERE user_id = ?").run(name, userId);
  },
  /** Add credits (may be negative to spend). Returns the new balance. */
  addCredits(userId: string, delta: number): number {
    getDb().prepare("UPDATE profiles SET credits = credits + ? WHERE user_id = ?").run(delta, userId);
    return profilesRepo.byUser(userId)!.credits;
  },
  /**
   * Atomically debit `amount` credits iff the balance covers it. Returns true on
   * success (exactly one row updated), false on insufficient funds — the guard
   * lives in the WHERE clause so concurrent debits cannot overspend.
   */
  tryDebit(userId: string, amount: number): boolean {
    const info = getDb()
      .prepare("UPDATE profiles SET credits = credits - ? WHERE user_id = ? AND credits >= ?")
      .run(amount, userId, amount);
    return info.changes === 1;
  },
  /** Set level + xp + credits atomically (used by the progression service). */
  setProgress(userId: string, level: number, xp: number, credits: number): void {
    getDb()
      .prepare("UPDATE profiles SET level = ?, xp = ?, credits = ? WHERE user_id = ?")
      .run(level, xp, credits, userId);
  },
};

// ---------------------------------------------------------------------------
// ship_upgrades
// ---------------------------------------------------------------------------

export const shipUpgradesRepo = {
  byUser(userId: string): ShipUpgradeRow[] {
    return getDb().prepare("SELECT * FROM ship_upgrades WHERE user_id = ?").all(userId) as ShipUpgradeRow[];
  },
  get(userId: string, shipId: string): ShipUpgradeRow | undefined {
    return getDb()
      .prepare("SELECT * FROM ship_upgrades WHERE user_id = ? AND ship_id = ?")
      .get(userId, shipId) as ShipUpgradeRow | undefined;
  },
  /** Ensure a row exists (all levels default 0). */
  ensure(userId: string, shipId: string): ShipUpgradeRow {
    const existing = shipUpgradesRepo.get(userId, shipId);
    if (existing) return existing;
    getDb()
      .prepare("INSERT INTO ship_upgrades (user_id, ship_id) VALUES (?, ?)")
      .run(userId, shipId);
    return shipUpgradesRepo.get(userId, shipId)!;
  },
  /** Set one track's level. Column chosen from a whitelist (never string-built). */
  setTrackLevel(userId: string, shipId: string, track: UpgradeTrackName, level: number): void {
    shipUpgradesRepo.ensure(userId, shipId);
    const col = TRACK_COLUMN[track];
    getDb()
      .prepare(`UPDATE ship_upgrades SET ${col} = ? WHERE user_id = ? AND ship_id = ?`)
      .run(level, userId, shipId);
  },
};

// ---------------------------------------------------------------------------
// owned_modules
// ---------------------------------------------------------------------------

export const ownedModulesRepo = {
  byUser(userId: string): OwnedModuleRow[] {
    return getDb().prepare("SELECT * FROM owned_modules WHERE user_id = ?").all(userId) as OwnedModuleRow[];
  },
  owns(userId: string, moduleId: string): boolean {
    const row = getDb()
      .prepare("SELECT qty FROM owned_modules WHERE user_id = ? AND module_id = ?")
      .get(userId, moduleId) as { qty: number } | undefined;
    return !!row && row.qty > 0;
  },
  /** Grant `qty` of a module (upserts, accumulating quantity). */
  grant(userId: string, moduleId: string, qty = 1): void {
    getDb()
      .prepare(
        "INSERT INTO owned_modules (user_id, module_id, qty) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id, module_id) DO UPDATE SET qty = qty + excluded.qty",
      )
      .run(userId, moduleId, qty);
  },
};

// ---------------------------------------------------------------------------
// owned_ships / owned_cosmetics / selected_cosmetics (shop, migration 005)
// ---------------------------------------------------------------------------

export interface OwnedShipRow {
  user_id: string;
  ship_id: string;
  acquired_at: number;
}

export interface OwnedCosmeticRow {
  user_id: string;
  cosmetic_id: string;
  acquired_at: number;
}

export interface SelectedCosmeticRow {
  user_id: string;
  ship_id: string;
  cosmetic_id: string;
}

export const ownedShipsRepo = {
  byUser(userId: string): OwnedShipRow[] {
    return getDb().prepare("SELECT * FROM owned_ships WHERE user_id = ?").all(userId) as OwnedShipRow[];
  },
  owns(userId: string, shipId: string): boolean {
    return (
      getDb().prepare("SELECT 1 FROM owned_ships WHERE user_id = ? AND ship_id = ?").get(userId, shipId) !== undefined
    );
  },
  /** Record a purchase. Idempotent — a repeat buy keeps the original timestamp. */
  grant(userId: string, shipId: string, acquiredAt = Date.now()): void {
    getDb()
      .prepare("INSERT INTO owned_ships (user_id, ship_id, acquired_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(userId, shipId, acquiredAt);
  },
};

export const ownedCosmeticsRepo = {
  byUser(userId: string): OwnedCosmeticRow[] {
    return getDb().prepare("SELECT * FROM owned_cosmetics WHERE user_id = ?").all(userId) as OwnedCosmeticRow[];
  },
  owns(userId: string, cosmeticId: string): boolean {
    return (
      getDb()
        .prepare("SELECT 1 FROM owned_cosmetics WHERE user_id = ? AND cosmetic_id = ?")
        .get(userId, cosmeticId) !== undefined
    );
  },
  /** Record a purchase. Idempotent. */
  grant(userId: string, cosmeticId: string, acquiredAt = Date.now()): void {
    getDb()
      .prepare(
        "INSERT INTO owned_cosmetics (user_id, cosmetic_id, acquired_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(userId, cosmeticId, acquiredAt);
  },
};

export const selectedCosmeticsRepo = {
  byUser(userId: string): SelectedCosmeticRow[] {
    return getDb().prepare("SELECT * FROM selected_cosmetics WHERE user_id = ?").all(userId) as SelectedCosmeticRow[];
  },
  get(userId: string, shipId: string): string | undefined {
    const row = getDb()
      .prepare("SELECT cosmetic_id FROM selected_cosmetics WHERE user_id = ? AND ship_id = ?")
      .get(userId, shipId) as { cosmetic_id: string } | undefined;
    return row?.cosmetic_id;
  },
  set(userId: string, shipId: string, cosmeticId: string): void {
    getDb()
      .prepare(
        "INSERT INTO selected_cosmetics (user_id, ship_id, cosmetic_id) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id, ship_id) DO UPDATE SET cosmetic_id = excluded.cosmetic_id",
      )
      .run(userId, shipId, cosmeticId);
  },
  /** Back to the authored look: the standard paint is an absent row, not a stored id. */
  clear(userId: string, shipId: string): void {
    getDb().prepare("DELETE FROM selected_cosmetics WHERE user_id = ? AND ship_id = ?").run(userId, shipId);
  },
};

// ---------------------------------------------------------------------------
// fittings
// ---------------------------------------------------------------------------

function toFittingRow(raw: Omit<FittingRow, "hardpointMap"> & { hardpoint_map: string }): FittingRow {
  const { hardpoint_map, ...rest } = raw;
  return { ...rest, hardpointMap: JSON.parse(hardpoint_map) as HardpointMap };
}

export const fittingsRepo = {
  byUser(userId: string): FittingRow[] {
    const rows = getDb()
      .prepare("SELECT * FROM fittings WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId) as Array<Omit<FittingRow, "hardpointMap"> & { hardpoint_map: string }>;
    return rows.map(toFittingRow);
  },
  byId(id: string): FittingRow | undefined {
    const raw = getDb().prepare("SELECT * FROM fittings WHERE id = ?").get(id) as
      | (Omit<FittingRow, "hardpointMap"> & { hardpoint_map: string })
      | undefined;
    return raw ? toFittingRow(raw) : undefined;
  },
  create(row: { id: string; user_id: string; ship_id: string; name: string; hardpointMap: HardpointMap; created_at?: number }): FittingRow {
    const created_at = row.created_at ?? Date.now();
    getDb()
      .prepare(
        "INSERT INTO fittings (id, user_id, ship_id, name, hardpoint_map, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.user_id, row.ship_id, row.name, JSON.stringify(row.hardpointMap), created_at);
    return { ...row, created_at };
  },
  update(id: string, patch: { name?: string; hardpointMap?: HardpointMap }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      args.push(patch.name);
    }
    if (patch.hardpointMap !== undefined) {
      sets.push("hardpoint_map = ?");
      args.push(JSON.stringify(patch.hardpointMap));
    }
    if (sets.length === 0) return;
    args.push(id);
    getDb().prepare(`UPDATE fittings SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  },
  delete(id: string): void {
    getDb().prepare("DELETE FROM fittings WHERE id = ?").run(id);
  },
};

// ---------------------------------------------------------------------------
// user_configs
// ---------------------------------------------------------------------------

export const userConfigsRepo = {
  byUser(userId: string): UserConfigRow[] {
    return getDb()
      .prepare("SELECT * FROM user_configs WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as UserConfigRow[];
  },
  byId(id: string): UserConfigRow | undefined {
    return getDb().prepare("SELECT * FROM user_configs WHERE id = ?").get(id) as UserConfigRow | undefined;
  },
  /** Upsert a config by id (create or replace its json/visibility). */
  upsert(row: { id: string; user_id: string; type: string; json: string; visibility?: string }): UserConfigRow {
    const updated_at = Date.now();
    const visibility = row.visibility ?? "private";
    getDb()
      .prepare(
        "INSERT INTO user_configs (id, user_id, type, json, visibility, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET json = excluded.json, type = excluded.type, visibility = excluded.visibility, updated_at = excluded.updated_at",
      )
      .run(row.id, row.user_id, row.type, row.json, visibility, updated_at);
    return { ...row, visibility, updated_at };
  },
  delete(id: string): void {
    getDb().prepare("DELETE FROM user_configs WHERE id = ?").run(id);
  },
};

// ---------------------------------------------------------------------------
// match_results
// ---------------------------------------------------------------------------

export const matchResultsRepo = {
  create(row: {
    id: string;
    mode: string;
    arena_id: string;
    participants: unknown;
    winner_team: number | null;
    duration_s: number;
    rewards_eligible?: boolean;
    room_id?: string | null;
    player_count?: number;
    bot_count?: number;
    created_at?: number;
  }): void {
    getDb()
      .prepare(
        "INSERT INTO match_results (id, mode, arena_id, participants, winner_team, duration_s, rewards_eligible, room_id, player_count, bot_count, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.mode,
        row.arena_id,
        JSON.stringify(row.participants),
        row.winner_team,
        row.duration_s,
        row.rewards_eligible === false ? 0 : 1,
        row.room_id ?? null,
        row.player_count ?? 0,
        row.bot_count ?? 0,
        row.created_at ?? Date.now(),
      );
  },
  byId(id: string): MatchResultRow | undefined {
    return getDb().prepare("SELECT * FROM match_results WHERE id = ?").get(id) as MatchResultRow | undefined;
  },
  /** Matches created at or after `since` (epoch ms), oldest first. Report tool. */
  since(since: number): MatchResultRow[] {
    return getDb()
      .prepare("SELECT * FROM match_results WHERE created_at >= ? ORDER BY created_at ASC")
      .all(since) as MatchResultRow[];
  },
};

// ---------------------------------------------------------------------------
// client_metrics (telemetry 6.8)
// ---------------------------------------------------------------------------

export const clientMetricsRepo = {
  create(row: {
    id: string;
    session_hash: string;
    fps_bucket: string;
    device_class: string;
    quality_tier: string;
    created_at?: number;
  }): void {
    getDb()
      .prepare(
        "INSERT INTO client_metrics (id, session_hash, fps_bucket, device_class, quality_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.session_hash, row.fps_bucket, row.device_class, row.quality_tier, row.created_at ?? Date.now());
  },
  since(since: number): ClientMetricRow[] {
    return getDb()
      .prepare("SELECT * FROM client_metrics WHERE created_at >= ? ORDER BY created_at ASC")
      .all(since) as ClientMetricRow[];
  },
  /**
   * How many reports this session hash has already filed since `since`. The
   * telemetry endpoint uses it as a per-session cap so one looping client cannot
   * flood a bucket — the IP rate limiter alone would let a slow trickle through.
   */
  countForSession(sessionHash: string, since: number): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM client_metrics WHERE session_hash = ? AND created_at >= ?")
      .get(sessionHash, since) as { n: number };
    return row.n;
  },
};

// ---------------------------------------------------------------------------
// server_metrics (telemetry 6.8)
// ---------------------------------------------------------------------------

export const serverMetricsRepo = {
  create(row: Omit<ServerMetricRow, "sampled_at"> & { sampled_at?: number }): void {
    getDb()
      .prepare(
        "INSERT INTO server_metrics (id, sampled_at, room_count, client_count, tick_avg_ms, tick_p95_ms, tick_max_ms, tick_samples, rss_bytes, heap_used_bytes) " +
          "VALUES (@id, @sampled_at, @room_count, @client_count, @tick_avg_ms, @tick_p95_ms, @tick_max_ms, @tick_samples, @rss_bytes, @heap_used_bytes)",
      )
      .run({ ...row, sampled_at: row.sampled_at ?? Date.now() });
  },
  since(since: number): ServerMetricRow[] {
    return getDb()
      .prepare("SELECT * FROM server_metrics WHERE sampled_at >= ? ORDER BY sampled_at ASC")
      .all(since) as ServerMetricRow[];
  },
};

// ---------------------------------------------------------------------------
// sessions (refresh tokens)
// ---------------------------------------------------------------------------

export const sessionsRepo = {
  create(row: { id: string; user_id: string; refresh_hash: string; expires_at: number; created_at?: number }): void {
    getDb()
      .prepare(
        "INSERT INTO sessions (id, user_id, refresh_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.user_id, row.refresh_hash, row.expires_at, row.created_at ?? Date.now());
  },
  byId(id: string): SessionRow | undefined {
    return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  },
  delete(id: string): void {
    getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  },
  deleteForUser(userId: string): void {
    getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  },
};
