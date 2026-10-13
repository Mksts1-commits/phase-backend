-- 019: signup bonus pool — fixed pool, admin-adjustable.
--
-- New users receive BONUS_PER_SIGNUP (1000) PHASE on signup, drawn from a
-- fixed pool. The pool never mints beyond its configured total_supply;
-- admins raise the cap by inserting a new bonus_pool version row
-- (append-only, latest row wins — same pattern as fee_config).
-- When the pool is exhausted, signups simply get no bonus.

CREATE TABLE IF NOT EXISTS bonus_pool (
  version      INT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  total_supply BIGINT NOT NULL CHECK (total_supply >= 0),
  created_by   TEXT NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row counter of bonus PHASE paid out so far.
CREATE TABLE IF NOT EXISTS bonus_pool_distributed (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  distributed BIGINT NOT NULL DEFAULT 0 CHECK (distributed >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO bonus_pool_distributed (id, distributed)
VALUES (1, 0) ON CONFLICT DO NOTHING;

-- Seed: 10M PHASE bonus pool = 10,000 signup bonuses of 1,000.
INSERT INTO bonus_pool (total_supply, created_by, reason)
SELECT 10000000, 'system:seed', 'Launch: 10M PHASE signup bonus pool (10k bonuses of 1,000)'
WHERE NOT EXISTS (SELECT 1 FROM bonus_pool);

-- Per-user PHASE balance + idempotency flag so a user is never paid twice.
ALTER TABLE issuance_users ADD COLUMN IF NOT EXISTS phase_balance BIGINT NOT NULL DEFAULT 0;
ALTER TABLE issuance_users ADD COLUMN IF NOT EXISTS bonus_granted BOOLEAN NOT NULL DEFAULT FALSE;
