-- Space Arena — initial schema (Phase 3.1/3.2).
-- All timestamps are unix epoch milliseconds (INTEGER). Applied once, in order,
-- by the migrations runner (see db/index.ts). Never edit an applied migration —
-- add a new numbered file instead.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  pass_hash   TEXT,
  guest_token TEXT UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  level        INTEGER NOT NULL DEFAULT 1,
  xp           INTEGER NOT NULL DEFAULT 0,
  credits      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ship_upgrades (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ship_id    TEXT NOT NULL,
  hull_lvl   INTEGER NOT NULL DEFAULT 0,
  engine_lvl INTEGER NOT NULL DEFAULT 0,
  energy_lvl INTEGER NOT NULL DEFAULT 0,
  heat_lvl   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ship_id)
);

CREATE TABLE owned_modules (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, module_id)
);

CREATE TABLE fittings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ship_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  hardpoint_map TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_fittings_user ON fittings(user_id);

CREATE TABLE user_configs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  json       TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_user_configs_user ON user_configs(user_id);

CREATE TABLE match_results (
  id           TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,
  arena_id     TEXT NOT NULL,
  participants TEXT NOT NULL,
  winner_team  INTEGER,
  duration_s   REAL NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Refresh-token sessions (3.2). The refresh token itself is never stored — only
-- a hash — so a DB leak cannot mint new access tokens.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
