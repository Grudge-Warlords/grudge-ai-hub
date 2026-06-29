-- Dev portal: cloud pod registry + orchestrator metadata

CREATE TABLE IF NOT EXISTS dev_pods (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  project_id  TEXT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'node',
  url         TEXT,
  status      TEXT NOT NULL DEFAULT 'stopped',
  meta_json   TEXT DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dev_pods_user ON dev_pods(user_id);