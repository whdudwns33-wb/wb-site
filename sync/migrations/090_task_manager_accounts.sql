CREATE TABLE IF NOT EXISTS task_manager_accounts (
  staff_id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE task_director_sessions ADD COLUMN manager_id TEXT;
