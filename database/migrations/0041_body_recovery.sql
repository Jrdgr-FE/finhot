ALTER TABLE articles ADD COLUMN body_fetch_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN body_checked_at timestamptz;
ALTER TABLE articles ADD COLUMN body_failure text;
