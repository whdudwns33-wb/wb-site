-- 연락처와 짧은 PIN 검증정보는 generic staff sync에 절대 포함하지 않는다.
CREATE TABLE IF NOT EXISTS staff_private_profiles (
  app TEXT NOT NULL CHECK (app='task'),
  staff_id TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  login_enabled INTEGER NOT NULL DEFAULT 0 CHECK (login_enabled IN (0,1)),
  pin_salt TEXT NOT NULL DEFAULT '',
  pin_hash TEXT NOT NULL DEFAULT '',
  pin_iterations INTEGER NOT NULL DEFAULT 100000,
  credential_revision INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  attempt_revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(app,staff_id)
);
CREATE TABLE IF NOT EXISTS staff_work_sessions (
  app TEXT NOT NULL CHECK (app='task'),
  token_hash TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  work_date TEXT NOT NULL,
  credential_revision INTEGER NOT NULL,
  data_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  PRIMARY KEY(app,token_hash)
);
CREATE INDEX IF NOT EXISTS idx_staff_work_sessions_staff_day
  ON staff_work_sessions(app,staff_id,work_date,revoked);
