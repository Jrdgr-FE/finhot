-- Domains: each item carries its domains as ',ai,finance,' (SQLite has no arrays). Adding a column with a
-- constant default does not rewrite the table, and everything synced before this is finance.
ALTER TABLE server_sync_stage ADD COLUMN domains TEXT NOT NULL DEFAULT ',finance,';
ALTER TABLE server_sync_items ADD COLUMN domains TEXT NOT NULL DEFAULT ',finance,';
-- A smaller domain is read through its own partial indexes, so a page stops at its boundary instead of
-- walking the busy domain's rows. Queries must repeat the WHERE expression literally to use them.
CREATE INDEX server_sync_ai_date ON server_sync_items(sort_at DESC,id DESC) WHERE domains LIKE '%,ai,%';
CREATE INDEX server_sync_ai_selected ON server_sync_items(selected,sort_at DESC,id DESC) WHERE domains LIKE '%,ai,%';
-- Daily reports per domain: SQLite cannot change a primary key, so the table is rebuilt.
CREATE TABLE server_sync_reports_domains (domain TEXT NOT NULL,date TEXT NOT NULL,created_at TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(domain,date));
INSERT INTO server_sync_reports_domains SELECT 'finance',date,created_at,data_json FROM server_sync_reports;
DROP TABLE server_sync_reports;
ALTER TABLE server_sync_reports_domains RENAME TO server_sync_reports;
