-- 028_float.sql — cumulative released float + float-increase idempotency.
--
-- A float increase moves the issuer's retained shares to the public
-- float address (PUBLIC_FLOAT_ADDRESS) without changing total supply.
-- The sold math needs the cumulative released amount: after an
-- increase, sold = (initialFloat + float_released_shares) - live
-- float balance, so the release must be tracked on the coin row even
-- though the ledger balance itself only moves at block confirmation.
--
-- Additive and idempotent, like every migration here. issuance_coins.id
-- is TEXT (migration 003), so the request table's coin_id is TEXT too.

ALTER TABLE issuance_coins
  ADD COLUMN IF NOT EXISTS float_released_shares BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS float_increase_requests (
  coin_id         TEXT NOT NULL REFERENCES issuance_coins(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  tx_id           TEXT NOT NULL,
  shares          BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (coin_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS float_increase_requests_coin_idx
  ON float_increase_requests (coin_id);
