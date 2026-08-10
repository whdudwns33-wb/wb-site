-- Additive and idempotent: 기존 staff/tasks/checks/tokens 데이터는 변경하지 않는다.
CREATE TABLE IF NOT EXISTS bootstrap_codes (
  app         TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  staff_id    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_staff
  ON bootstrap_codes(app, staff_id, revoked, expires_at);
