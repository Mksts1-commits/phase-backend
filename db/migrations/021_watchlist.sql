-- 021: user watchlist for the agent interface — coins a user wants an
-- agent (or the app) to keep an eye on. Written by
-- POST /api/v1/agent/watchlist; read by the agent dashboard/marketplace
-- payloads. Idempotent: safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS user_watchlist (
  user_id    TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  coin_id    TEXT NOT NULL REFERENCES issuance_coins(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, coin_id)
);

CREATE INDEX IF NOT EXISTS idx_user_watchlist_user
  ON user_watchlist (user_id, created_at DESC);
