PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '未分组',
  cover_object_key TEXT,
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  current_version_id TEXT,
  next_version_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'trashed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL UNIQUE,
  version_number INTEGER NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  original_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  sha256 TEXT NOT NULL,
  restored_from_version_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id, version_number),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(restored_from_version_id) REFERENCES versions(id)
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_projects_public ON projects(is_public, status, updated_at DESC);
CREATE INDEX idx_versions_project ON versions(project_id, version_number DESC);
CREATE INDEX idx_sessions_expiry ON admin_sessions(expires_at);
