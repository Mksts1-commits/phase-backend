-- 023_coin_document_type.sql — a document TYPE for coin_documents so the
-- Legitimacy Score can recognize a business license / registration on
-- file (legitimacy.ts, item business_license). Until now uploads carried
-- only a filename, so no document could be told apart as a license.
-- Existing rows default to 'other' and earn nothing — only a document the
-- issuer uploads declared as docType='business_license' counts.
-- Additive and idempotent, like every migration here.

ALTER TABLE coin_documents
  ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'other';

CREATE INDEX IF NOT EXISTS idx_coin_documents_coin_type
  ON coin_documents (coin_id, doc_type);
