-- GRUDA Legion — user-linked projects (private by default, GitHub-like)

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  owner_id      TEXT NOT NULL,
  owner_grudge_id TEXT,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'private',
  description   TEXT,
  template      TEXT DEFAULT 'blank',
  storage_path  TEXT,
  github_repo   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  invited_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_files (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  content     TEXT,
  content_hash TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, path),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id  TEXT,
  user_id     TEXT NOT NULL,
  task        TEXT NOT NULL,
  role        TEXT DEFAULT 'dev',
  status      TEXT NOT NULL DEFAULT 'running',
  steps_json  TEXT DEFAULT '[]',
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, created_at);