CREATE TABLE server_sync_versions (
  generation TEXT PRIMARY KEY, base_generation TEXT NOT NULL, captured_at TEXT NOT NULL,
  expected_changes INTEGER NOT NULL, ids_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE server_sync_stage (
  generation TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, category TEXT NOT NULL,
  selected INTEGER NOT NULL, sort_at TEXT NOT NULL, search_text TEXT NOT NULL, data_json TEXT NOT NULL,
  PRIMARY KEY(generation,id)
);
CREATE TABLE server_sync_items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, category TEXT NOT NULL, selected INTEGER NOT NULL,
  sort_at TEXT NOT NULL, search_text TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE INDEX server_sync_date ON server_sync_items(sort_at DESC,id DESC);
CREATE INDEX server_sync_source ON server_sync_items(source_id,sort_at DESC,id DESC);
CREATE INDEX server_sync_selected ON server_sync_items(selected,sort_at DESC,id DESC);
CREATE TABLE server_sync_state (key TEXT PRIMARY KEY,generation TEXT NOT NULL,captured_at TEXT NOT NULL,contact_at TEXT NOT NULL,metadata_json TEXT NOT NULL);
CREATE TABLE feedback(id TEXT PRIMARY KEY,message TEXT NOT NULL,contact TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
