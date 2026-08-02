-- WB 개인 링크 인증 저장 형식 및 1회 bootstrap 강화
-- 구형 접두사 없는 SHA-256은 접두 형식으로 옮기고, 신규 링크용 code 저장소를 추가한다.

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

-- 동일 digest의 접두 행이 이미 있으면 모호한 bare 중복 행을 먼저 제거한다.
DELETE FROM tokens
WHERE rowid IN (
  SELECT legacy.rowid
  FROM tokens AS legacy
  JOIN tokens AS canonical
    ON canonical.app = legacy.app
   AND canonical.token = 'sha256:' || lower(legacy.token)
  WHERE length(legacy.token) = 64
    AND legacy.token NOT GLOB '*[^0-9A-Fa-f]*'
);

UPDATE tokens
SET token = 'sha256:' || lower(token)
WHERE length(token) = 64
  AND token NOT GLOB '*[^0-9A-Fa-f]*'
  AND token NOT LIKE 'sha256:%';

INSERT OR IGNORE INTO lp_schema_migrations(version, name, applied_at)
VALUES (3, 'token_bootstrap_hardening', unixepoch('now') * 1000);

UPDATE lp_schema_migrations
SET applied_at = unixepoch('now') * 1000
WHERE version = 3 AND applied_at = 0;
