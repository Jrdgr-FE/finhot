-- Feed folding (packages/backend/src/events/fold.ts): reports of one occurrence show once in the public
-- feed. feed_cluster is the first report of the occurrence (null: the report is its own first);
-- feed_folded_at marks a report as compared, so later reports compare against it.
ALTER TABLE articles
  ADD COLUMN feed_cluster text,
  ADD COLUMN feed_folded_at timestamptz;
CREATE INDEX articles_feed_cluster_idx ON articles (feed_cluster) WHERE feed_cluster IS NOT NULL;
