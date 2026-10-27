-- 027_oauth.sql — OAuth 2.0 authorization-server storage (oauth.ts).
--
-- RFC 6749 authorization code flow with PKCE (RFC 7636), dynamic client
-- registration (RFC 7591), token revocation (RFC 7009). Secrets, codes,
-- and tokens are stored only as SHA-256 hashes (same pattern as
-- password_reset_tokens): a database read must never yield a usable
-- credential. Client secrets issued at registration are high-entropy
-- random values, so SHA-256 storage is appropriate.
--
-- Additive and idempotent, like every migration here. user_id references
-- issuance_users(id) with ON DELETE CASCADE, matching auth_sessions.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id         TEXT PRIMARY KEY,
  client_secret_hash TEXT,               -- NULL for public clients (auth_method none)
  client_name       TEXT NOT NULL,
  redirect_uris     TEXT[] NOT NULL,
  allowed_scopes    TEXT[] NOT NULL,
  is_public         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT[] NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_client_idx
  ON oauth_authorization_codes (client_id);

-- One row per granted token pair. Refresh rotation replaces the stored
-- hashes in place, so a rotated-out refresh token no longer matches
-- anything and reuse is rejected. Revocation sets revoked_at.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  TEXT PRIMARY KEY,
  client_id           TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  scope               TEXT[] NOT NULL,
  access_token_hash   TEXT NOT NULL,
  refresh_token_hash  TEXT NOT NULL,
  access_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_tokens_access_idx ON oauth_tokens (access_token_hash);
CREATE INDEX IF NOT EXISTS oauth_tokens_refresh_idx ON oauth_tokens (refresh_token_hash);
