CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  app TEXT NOT NULL CHECK (app IN ('wb-reading', 'naesin-tg')),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used TEXT
);
CREATE TABLE IF NOT EXISTS token_activity (
  id INTEGER PRIMARY KEY, token_id INTEGER NOT NULL REFERENCES api_tokens(id),
  app TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL,
  kind TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS api_tokens_limit BEFORE INSERT ON api_tokens
WHEN (SELECT COUNT(*) FROM api_tokens WHERE app=NEW.app AND owner=NEW.owner
      AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) >= 20
  OR EXISTS (SELECT 1 FROM api_tokens WHERE app=NEW.app AND owner=NEW.owner AND name=NEW.name
             AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'active_key_limit_or_name'); END;
CREATE TRIGGER IF NOT EXISTS api_tokens_created AFTER INSERT ON api_tokens
BEGIN
  INSERT INTO token_activity(token_id,app,owner,name,scope,kind)
  VALUES(NEW.id,NEW.app,NEW.owner,NEW.name,NEW.scope,'token_create');
END;
CREATE TRIGGER IF NOT EXISTS api_tokens_revoked AFTER UPDATE OF revoked_at ON api_tokens
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO token_activity(token_id,app,owner,name,scope,kind)
  VALUES(NEW.id,NEW.app,NEW.owner,NEW.name,NEW.scope,'token_revoke');
END;
