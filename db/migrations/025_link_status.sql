-- 025_link_status.sql — persisted link-liveness verdicts for issuer
-- URLs (link-check.ts). A JSON object keyed by URL:
--   { "https://example.com": { "verdict": "ok", "checkedAt": "<iso>" } }
-- Verdicts are written once (at draft creation / coin PATCH / mint, or
-- lazily on the first scored read for legacy rows) and never re-checked
-- on read, so a coin's Legitimacy Score is stable between writes.
-- Drafts carry the map into the coin at mint, like the URLs themselves.
-- Additive and idempotent, like every migration here.

ALTER TABLE issuance_drafts
  ADD COLUMN IF NOT EXISTS link_status JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE issuance_coins
  ADD COLUMN IF NOT EXISTS link_status JSONB NOT NULL DEFAULT '{}'::jsonb;
