CREATE TABLE IF NOT EXISTS wb_mcp_keys (
  id          TEXT    PRIMARY KEY,
  owner       TEXT    NOT NULL,
  token_hash  TEXT    UNIQUE NOT NULL CHECK (length(token_hash) = 64),
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scope       TEXT    NOT NULL CHECK (scope IN ('read', 'write')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL CHECK (expires_at > created_at),
  last_used   INTEGER,
  revoked_at  INTEGER,
  request_times TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS wb_mcp_key_events (
  token_id    TEXT    NOT NULL,
  owner       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('token_create', 'token_revoke')),
  name        TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  via         TEXT    NOT NULL CHECK (via = 'cli'),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (token_id, kind)
);

-- 발급·폐기와 감사가 한 D1 쓰기에 같이 성공하거나 실패한다.
CREATE TRIGGER IF NOT EXISTS trg_wb_mcp_key_create
AFTER INSERT ON wb_mcp_keys
BEGIN
  INSERT INTO wb_mcp_key_events VALUES (NEW.id, NEW.owner, 'token_create', NEW.name, NEW.scope, 'cli', NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_wb_mcp_key_revoke
AFTER UPDATE OF revoked_at ON wb_mcp_keys
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
  INSERT INTO wb_mcp_key_events VALUES (NEW.id, NEW.owner, 'token_revoke', NEW.name, NEW.scope, 'cli', NEW.revoked_at);
END;
