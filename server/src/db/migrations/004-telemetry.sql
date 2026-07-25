-- Minimal telemetry (ROADMAP §11 6.8): match results, client FPS bucket +
-- device class, and a periodic server tick/room rollup. Feeds balance & perf.
--
-- Privacy: `client_metrics` holds NO user id and NO account link. Its only
-- correlation handle is a random per-page-load session hash that the client
-- keeps in memory and never persists. `match_results` already stores the
-- authenticated participants (it drives progression) and is untouched here
-- except for three counts.

-- --- match_results: the shape 6.8 asks for on top of the 3.x columns --------
-- `mode` already carries the gamemode id, `duration_s` the duration and
-- `winner_team` the winner, so only the room identity and the human/bot split
-- are new. Existing rows keep NULL room_id (they predate telemetry) and 0
-- counts; the report tool treats 0 as "not recorded" rather than "no players".
ALTER TABLE match_results ADD COLUMN room_id TEXT;
ALTER TABLE match_results ADD COLUMN player_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_results ADD COLUMN bot_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_match_results_created ON match_results(created_at);

-- --- client_metrics: one anonymous row per finished match -------------------
-- session_hash: 32-64 hex chars, minted per page load, in-memory only. It is
-- NOT a user id and must never be joined against users/profiles — there is
-- deliberately no foreign key here to make that impossible by construction.
CREATE TABLE client_metrics (
  id           TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  fps_bucket   TEXT NOT NULL,
  device_class TEXT NOT NULL,
  quality_tier TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_client_metrics_created ON client_metrics(created_at);

-- --- server_metrics: periodic rollup while rooms are live -------------------
-- Written by the telemetry sampler (server/src/telemetry/sampler.ts) only while
-- at least one room exists, so an idle server writes nothing. Tick figures are
-- milliseconds spent inside ArenaRoom's fixed simulation step, aggregated over
-- every live room since the previous sample.
CREATE TABLE server_metrics (
  id           TEXT PRIMARY KEY,
  sampled_at   INTEGER NOT NULL,
  room_count   INTEGER NOT NULL,
  client_count INTEGER NOT NULL,
  tick_avg_ms  REAL NOT NULL,
  tick_p95_ms  REAL NOT NULL,
  tick_max_ms  REAL NOT NULL,
  tick_samples INTEGER NOT NULL,
  rss_bytes    INTEGER NOT NULL,
  heap_used_bytes INTEGER NOT NULL
);
CREATE INDEX idx_server_metrics_sampled ON server_metrics(sampled_at);
