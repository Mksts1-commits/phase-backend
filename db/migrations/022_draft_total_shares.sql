-- 022: drafts carry the coin supply. The total share count used to be
-- chosen at mint time — AFTER the issuer agreement was rendered and
-- signed — so the agreement's Share Split section printed a hardcoded
-- 1,000,000 regardless of the real supply. The supply is now fixed on
-- the draft (explicit, or derived from the $100k default market cap /
-- price), the agreement prints the draft's real number, and mint must
-- match it. NULL on pre-existing drafts = legacy: those keep the old
-- mint-time supply behavior. Idempotent: safe to re-run.

ALTER TABLE issuance_drafts ADD COLUMN IF NOT EXISTS total_shares NUMERIC(30,6);
