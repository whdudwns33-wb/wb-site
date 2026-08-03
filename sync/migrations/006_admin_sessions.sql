-- 직원 개인 토큰과 분리된 원장용 1회 코드 및 짧은 세션.
CREATE TABLE IF NOT EXISTS admin_bootstrap_codes (
  app         TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_admin_bootstrap_active
  ON admin_bootstrap_codes(app, revoked, expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  app         TEXT    NOT NULL,
  token_hash  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
  ON admin_sessions(app, revoked, expires_at);
