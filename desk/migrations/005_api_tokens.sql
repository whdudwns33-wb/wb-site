-- 기존 원장 표에는 최초 변경 이력이 없다. 이 판에서 실제로 다른 암호로 바꾼 뒤 발급할 수 있다.
CREATE TABLE IF NOT EXISTS desk_admin_mcp_ready (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          TEXT    PRIMARY KEY,
  token_hash  TEXT    UNIQUE NOT NULL CHECK (length(token_hash) = 64),
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scope       TEXT    NOT NULL CHECK (scope IN ('read', 'write')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL CHECK (expires_at > created_at),
  last_used   INTEGER,
  revoked_at  INTEGER,
  request_times TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS desk_token_events (
  token_id    TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('token_create', 'token_revoke')),
  name        TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  via         TEXT    NOT NULL CHECK (via = 'cli'),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (token_id, kind)
);

-- 발급·폐기와 감사가 한 D1 쓰기에 같이 성공하거나 실패한다.
CREATE TRIGGER IF NOT EXISTS trg_api_token_create
AFTER INSERT ON api_tokens
BEGIN
  INSERT INTO desk_token_events VALUES (NEW.id, 'token_create', NEW.name, NEW.scope, 'cli', NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_api_token_revoke
AFTER UPDATE OF revoked_at ON api_tokens
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
  INSERT INTO desk_token_events VALUES (NEW.id, 'token_revoke', NEW.name, NEW.scope, 'cli', NEW.revoked_at);
END;
