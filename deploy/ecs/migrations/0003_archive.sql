ALTER TABLE server_sync_versions ADD COLUMN feed_ids_json TEXT;
ALTER TABLE server_sync_versions ADD COLUMN feed_add_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE server_sync_versions ADD COLUMN feed_remove_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE server_sync_versions ADD COLUMN withdrawn_ids_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE server_sync_recent (id TEXT PRIMARY KEY);
CREATE INDEX server_sync_category ON server_sync_items(category,sort_at DESC,id DESC);
INSERT INTO server_sync_recent SELECT id FROM server_sync_items;
CREATE TABLE server_sync_reports (date TEXT PRIMARY KEY,created_at TEXT NOT NULL,data_json TEXT NOT NULL);
INSERT INTO server_sync_reports SELECT json_extract(value,'$.date'),json_extract(value,'$.created_at'),value
FROM server_sync_state,json_each(metadata_json,'$.reports') WHERE server_sync_state.key='active';
