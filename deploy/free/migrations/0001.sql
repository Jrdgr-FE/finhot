CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
  tier TEXT NOT NULL, original_title TEXT NOT NULL, title TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', score REAL,
  selected INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending',
  published_at TEXT, discovered_at TEXT NOT NULL, ready_at TEXT
);
CREATE INDEX IF NOT EXISTS items_public ON items(state, selected, discovered_at DESC);
CREATE INDEX IF NOT EXISTS items_category ON items(state, category, discovered_at DESC);
CREATE INDEX IF NOT EXISTS items_daily ON items(selected, ready_at);
CREATE TABLE IF NOT EXISTS source_health (id TEXT PRIMARY KEY, name TEXT NOT NULL, checked_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS ai_receipts (id TEXT PRIMARY KEY, day TEXT NOT NULL, state TEXT NOT NULL, response TEXT, error TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_day ON ai_receipts(day);
CREATE TABLE IF NOT EXISTS reports (date TEXT PRIMARY KEY, item_ids TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, message TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
