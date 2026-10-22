CREATE TABLE sync_incidents (
  id TEXT PRIMARY KEY,kind TEXT NOT NULL,message TEXT NOT NULL,
  opened_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,resolved_at TEXT
);
CREATE UNIQUE INDEX sync_incident_active ON sync_incidents(kind) WHERE resolved_at IS NULL;
