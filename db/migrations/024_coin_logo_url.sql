-- 024_coin_logo_url.sql — a logo URL for issuance drafts and coins so the
-- Legitimacy Score's logo item (legitimacy.ts, 4 pts) has a real field to
-- read. Set on the draft before minting (flows to the coin at mint, like
-- website_url) or afterwards via PATCH /api/v1/coins/:id { logoUrl }.
-- Existing rows stay NULL and earn nothing until the issuer sets a logo.
-- Additive and idempotent, like every migration here.

ALTER TABLE issuance_drafts
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE issuance_coins
  ADD COLUMN IF NOT EXISTS logo_url TEXT;
