-- Shop ownership (2026-08-08): hulls and cosmetics a user has BOUGHT, plus the
-- paint equipped per hull. Purchases only — the starter grants (the light hull,
-- the free modules, the standard paint) are derived at READ time from content,
-- never written here, so re-authoring the starter set repairs every existing
-- account instead of leaving seeded rows behind.

CREATE TABLE owned_ships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ship_id     TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ship_id)
);

CREATE TABLE owned_cosmetics (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cosmetic_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, cosmetic_id)
);

-- One equipped paint per (user, hull). Unequipping DELETEs the row rather than
-- storing the standard id: absent and "standard" are the same look, and one
-- representation cannot drift from the other.
CREATE TABLE selected_cosmetics (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ship_id     TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL,
  PRIMARY KEY (user_id, ship_id)
);
