ALTER TABLE source_health ADD COLUMN latest_published_at TEXT;
CREATE INDEX IF NOT EXISTS items_source_time ON items(source_id,discovered_at DESC);
