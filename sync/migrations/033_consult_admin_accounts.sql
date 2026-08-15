-- consult 원장 계정 로그인. 기존 데이터와 task 인증은 변경하지 않는다.
CREATE TABLE IF NOT EXISTS admin_accounts (
  app                 TEXT    NOT NULL PRIMARY KEY CHECK (app = 'consult'),
  login_id            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_salt       TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);
