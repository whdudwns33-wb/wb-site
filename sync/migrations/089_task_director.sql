CREATE TABLE IF NOT EXISTS task_director_account (
  id INTEGER PRIMARY KEY CHECK(id=1), login_id TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_director_sessions (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('session','api')),
  label TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
