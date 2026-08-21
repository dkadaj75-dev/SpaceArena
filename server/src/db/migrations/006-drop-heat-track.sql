-- Heat system deleted (2026-08-20). Ships no longer have a heat/cooling stat, so
-- the fourth upgrade track goes with it. The column is dropped rather than left
-- dead: `ship_upgrades` is written through a whitelist keyed by the shared
-- `UpgradeTrackName` union, and a column with no name to reach it by is only a
-- trap for the next person reading the schema.
--
-- Any levels a player bought in this track are gone. They were never spendable
-- currency — the track's upgrade config is deleted too — and the shop grants no
-- refund for a stat that no longer exists.
ALTER TABLE ship_upgrades DROP COLUMN heat_lvl;
