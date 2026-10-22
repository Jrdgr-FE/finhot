ALTER TABLE items ADD COLUMN body_status TEXT NOT NULL DEFAULT 'not-fetched';
ALTER TABLE items ADD COLUMN body_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN body_checked_at TEXT;
ALTER TABLE items ADD COLUMN body_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN body_error TEXT;
ALTER TABLE items ADD COLUMN material_scope TEXT NOT NULL DEFAULT 'feed';
CREATE INDEX IF NOT EXISTS items_body_pending ON items(state,body_status,body_checked_at,discovered_at DESC);
