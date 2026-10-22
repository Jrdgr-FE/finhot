-- Cached English public copy; exact input matching prevents stale translations after an edit.
CREATE TABLE public_copy_en (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  source_title text NOT NULL,
  source_summary text NOT NULL,
  title_en text NOT NULL DEFAULT '',
  summary_en text NOT NULL DEFAULT '',
  receipt_id bigint REFERENCES receipts(id),
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
