-- 075_manager_inspection_sessions.sql
-- 선생님 개인 링크 화면에서 관리 담당자가 점검할 때 쓰는 단기 세션이다.
-- 연락처·PIN·원문 토큰은 저장하지 않고, 기존 운영 데이터는 변경하지 않는다.
CREATE TABLE IF NOT EXISTS manager_inspection_sessions (
  app TEXT NOT NULL CHECK (app='task'),
  token_hash TEXT NOT NULL,
  manager_staff_id TEXT NOT NULL,
  source_staff_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  PRIMARY KEY(app,token_hash)
);
CREATE INDEX IF NOT EXISTS idx_manager_inspection_sessions_device
  ON manager_inspection_sessions(app,device_hash,revoked,expires_at);
CREATE TABLE IF NOT EXISTS manager_inspection_attempts (
  app TEXT NOT NULL CHECK (app='task'),
  device_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  attempt_revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(app,device_hash)
);
