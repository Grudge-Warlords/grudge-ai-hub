-- GRUDA AI Hub — fleet economy ledger (GBUX rewards, swaps, transfers)

CREATE TABLE IF NOT EXISTS gbux_ledger (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  grudge_id     TEXT NOT NULL,
  wallet_address TEXT,
  type          TEXT NOT NULL,
  amount        REAL NOT NULL,
  direction     TEXT NOT NULL,
  source_game   TEXT,
  reward_id     TEXT,
  tx_signature  TEXT,
  memo          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS economy_rewards (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  grudge_id     TEXT NOT NULL,
  reward_type   TEXT NOT NULL,
  amount        REAL NOT NULL,
  source_game   TEXT NOT NULL,
  source_ref    TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  item_id       TEXT,
  nft_mint      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at    TEXT
);

CREATE TABLE IF NOT EXISTS economy_swaps (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  grudge_id     TEXT NOT NULL,
  pair_id       TEXT NOT NULL,
  from_mint     TEXT NOT NULL,
  to_mint       TEXT NOT NULL,
  from_amount   REAL NOT NULL,
  to_amount     REAL,
  quote_id      TEXT,
  fee_gbux      REAL DEFAULT 0,
  tx_signature  TEXT,
  status        TEXT NOT NULL DEFAULT 'quoted',
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_grudge ON gbux_ledger(grudge_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rewards_grudge ON economy_rewards(grudge_id, status);
CREATE INDEX IF NOT EXISTS idx_swaps_grudge ON economy_swaps(grudge_id, created_at DESC);