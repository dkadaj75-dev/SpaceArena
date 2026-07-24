-- Roles: 'player' (default) | 'admin'. Admin unlocks dev/admin endpoints
-- (config import, monitor) in later phases; created via tools/create-admin.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'player';
