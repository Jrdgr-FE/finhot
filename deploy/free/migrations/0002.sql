CREATE INDEX IF NOT EXISTS items_public_date ON items(state, selected, COALESCE(published_at, discovered_at) DESC, id DESC);
