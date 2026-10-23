-- 026_email_domain_status.sql — persisted email-domain deliverability
-- verdict for the Legitimacy Score's red flags (email-domain-check.ts).
-- Phase accounts are not email-verified, so the verdict records
-- whether the issuer's email domain can receive mail at all:
--   'ok'      MX records (or an A/AAAA host record) exist
--   'bad'     definitively no MX and no host record — the domain
--             cannot receive mail; raises the bad_email_domain flag
--   'unknown' the check was inconclusive (DNS timeout/SERVFAIL) —
--             never flags
-- Written once, lazily, on the first scored read; never re-checked.
-- Additive and idempotent, like every migration here.

ALTER TABLE issuance_users
  ADD COLUMN IF NOT EXISTS email_domain_status TEXT;

ALTER TABLE issuance_users
  ADD COLUMN IF NOT EXISTS email_domain_checked_at TIMESTAMPTZ;
