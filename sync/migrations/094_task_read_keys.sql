-- 앱 표준 읽기 키: 이름 · 만료 · 개별 폐기. 원문은 저장하지 않고 SHA-256만 둔다.
-- 기존 TASK_MCP_READ_SECRET·원장 API 키(task_director_sessions)와 별개다.
CREATE TABLE IF NOT EXISTS task_read_keys (
  id INTEGER PRIMARY KEY,
  app TEXT NOT NULL CHECK (app = 'task-sheet'),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope = 'read'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used TEXT
);
CREATE TABLE IF NOT EXISTS task_read_key_activity (
  id INTEGER PRIMARY KEY, token_id INTEGER NOT NULL REFERENCES task_read_keys(id),
  app TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL,
  kind TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS task_read_keys_limit BEFORE INSERT ON task_read_keys
WHEN (SELECT COUNT(*) FROM task_read_keys WHERE owner=NEW.owner
      AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) >= 20
  OR EXISTS (SELECT 1 FROM task_read_keys WHERE owner=NEW.owner AND name=NEW.name
             AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'active_key_limit_or_name'); END;
CREATE TRIGGER IF NOT EXISTS task_read_keys_created AFTER INSERT ON task_read_keys
BEGIN
  INSERT INTO task_read_key_activity(token_id,app,owner,name,scope,kind)
  VALUES(NEW.id,NEW.app,NEW.owner,NEW.name,NEW.scope,'token_create');
END;
CREATE TRIGGER IF NOT EXISTS task_read_keys_revoked AFTER UPDATE OF revoked_at ON task_read_keys
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO task_read_key_activity(token_id,app,owner,name,scope,kind)
  VALUES(NEW.id,NEW.app,NEW.owner,NEW.name,NEW.scope,'token_revoke');
END;
