ALTER TABLE articles ADD COLUMN material_scope text NOT NULL DEFAULT '';
UPDATE articles SET material_scope = coalesce(raw->>'materialScope', '') WHERE raw->>'importedFrom' = 'finhot-free';
-- Feedback submitted by the static frontend keeps its existing 30-day retention and hourly limit.
CREATE TABLE edge_feedback_limits (
  key text PRIMARY KEY,
  used integer NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE feedback ADD COLUMN edge_submission boolean NOT NULL DEFAULT false;
