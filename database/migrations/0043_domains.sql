-- Domains (industry/domains.ts): an item belongs to one or more domains, ranked; the first is its primary
-- domain, whose score standard, threshold, categories and tag vocabulary it is judged by. Everything
-- before this migration is finance (the defaults), so no row is rewritten.
ALTER TABLE analyses
  ADD COLUMN domains text[] NOT NULL DEFAULT '{finance}',
  ADD COLUMN primary_domain text NOT NULL DEFAULT 'finance';

ALTER TABLE publications
  ADD COLUMN domains text[] NOT NULL DEFAULT '{finance}',
  ADD COLUMN primary_domain text NOT NULL DEFAULT 'finance';
CREATE INDEX publications_domains_idx ON publications USING gin (domains);

-- Reports of other domains are kinds of their own (ai-daily, ai-weekly, ai-monthly); finance keeps
-- daily/weekly/monthly, so every existing report and query stays as it is.
ALTER TABLE reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_kind_check CHECK (kind ~ '^([a-z]+-)?(daily|weekly|monthly)$');
