-- 020: bridge vaults + bridge events (chain-agnostic bridge infrastructure).
--
-- Design note: one vault per Phase chain (the lock memo names the destination,
-- so vaults are NOT per-destination). Wrapped mints are per (chain,
-- destination) in bridge_mints. All cross-chain steps are idempotent via
-- bridge_events.idempotency_key (UNIQUE) — a replayed lock/mint/burn/unlock
-- is rejected, never double-counted.

-- Deterministic vault registry: vault_address is derived, not secret —
-- ph1 + base58(sha256("phase-bridge-vault/v1/" + chain_id)).
-- (Devnet: the matching keypair is re-derivable; mainnet MUST use KMS.)
CREATE TABLE IF NOT EXISTS bridge_vaults (
  chain_id      TEXT PRIMARY KEY,
  vault_address TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wrapped mints, one per (chain, destination chain), e.g. ('ch_...', 'solana').
CREATE TABLE IF NOT EXISTS bridge_mints (
  chain_id          TEXT NOT NULL,
  destination_chain TEXT NOT NULL,
  mint_address      TEXT NOT NULL,
  decimals          INT NOT NULL DEFAULT 6,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, destination_chain)
);

-- Every cross-chain step, exactly-once via idempotency_key.
-- kind: 'lock' (Phase tx into vault) | 'mint' (wrapped minted on dest) |
--       'burn' (wrapped burned on dest) | 'unlock' (Phase vault -> user).
-- status: 'seen' | 'verified' | 'submitted' | 'confirmed' | 'failed'.
CREATE TABLE IF NOT EXISTS bridge_events (
  id              BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  chain_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('lock', 'mint', 'burn', 'unlock')),
  phase_tx_id     TEXT,
  dest_tx_sig     TEXT,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'seen'
                  CHECK (status IN ('seen', 'verified', 'submitted', 'confirmed', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bridge_events_chain_kind_idx
  ON bridge_events (chain_id, kind);

-- Circuit-breaker / admin audit log (append-only): pauses, resumes, cap changes.
CREATE TABLE IF NOT EXISTS bridge_admin_log (
  id         BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
