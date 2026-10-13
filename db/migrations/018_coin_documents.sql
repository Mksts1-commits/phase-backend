-- 018: issuer-uploaded documents per coin (Documentation & Compliance).
-- Files are stored as BYTEA (small scale: 10 MB max per file, 10 max per
-- coin). If volume ever grows, move to object storage.
CREATE TABLE IF NOT EXISTS coin_documents (
  id TEXT PRIMARY KEY,
  coin_id TEXT NOT NULL REFERENCES issuance_coins(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coin_documents_coin ON coin_documents (coin_id);
