-- consult 관리 선생님별 로그인 계정. 원장 계정과 권한·기기 토큰을 분리한다.
CREATE TABLE IF NOT EXISTS consult_manager_accounts (
  account_id          TEXT    NOT NULL PRIMARY KEY,
  login_id            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT    NOT NULL,
  password_salt       TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_login_at       INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consult_manager_accounts_active
  ON consult_manager_accounts(active, display_name, login_id);
