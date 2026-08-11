-- 보호자 웹앱 초대·세션·정형 응답.
-- 원본 초대코드/세션토큰/전화번호는 저장하지 않는다. 한 세션은 한 stable studentId만 본다.
CREATE TABLE IF NOT EXISTS guardian_portal_access (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  student_id  TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  guardian_identity_hash TEXT CHECK (
    guardian_identity_hash IS NULL OR (
      length(guardian_identity_hash) = 64 AND guardian_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  accepted_at INTEGER,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT    NOT NULL,
  CHECK (enabled = 0 OR guardian_identity_hash IS NOT NULL),
  PRIMARY KEY (app, student_id)
);

CREATE TABLE IF NOT EXISTS guardian_portal_codes (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  code_hash    TEXT    NOT NULL CHECK (length(code_hash) = 71 AND code_hash LIKE 'sha256:%'),
  student_id   TEXT    NOT NULL,
  guardian_identity_hash TEXT NOT NULL CHECK (length(guardian_identity_hash) = 64),
  access_updated_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  issued_by    TEXT    NOT NULL,
  claim_id     TEXT CHECK (claim_id IS NULL OR length(claim_id) = 48),
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_guardian_portal_codes_student
  ON guardian_portal_codes(app, student_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS guardian_portal_sessions (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  token_hash   TEXT    NOT NULL CHECK (length(token_hash) = 71 AND token_hash LIKE 'sha256:%'),
  student_id   TEXT    NOT NULL,
  guardian_identity_hash TEXT NOT NULL CHECK (length(guardian_identity_hash) = 64),
  access_updated_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_guardian_portal_sessions_student
  ON guardian_portal_sessions(app, student_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS guardian_portal_responses (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  response_id  TEXT    NOT NULL,
  student_id   TEXT    NOT NULL,
  object_type  TEXT    NOT NULL CHECK (object_type = 'makeup'),
  object_id    TEXT    NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  response     TEXT    NOT NULL CHECK (response IN ('accept', 'decline')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (app, response_id),
  UNIQUE (app, object_type, object_id, student_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_guardian_portal_responses_object
  ON guardian_portal_responses(app, object_type, object_id, created_at);

-- 철회 또는 동의 대상 보호자 identity 변경은 기존 초대·세션을 같은 DB
-- 쓰기 안에서 막는다. 휴대폰 번호가 바뀌면 새 보호자에게 기존 동의를 승계하지 않는다.
CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_access_revoke
AFTER UPDATE OF enabled, guardian_identity_hash ON guardian_portal_access
WHEN NEW.enabled = 0 OR OLD.guardian_identity_hash IS NOT NEW.guardian_identity_hash
BEGIN
  UPDATE guardian_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE guardian_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

-- 보호자 응답의 사전 SELECT와 INSERT 사이에 관리자가 일정을 바꾸는 경합도 DB가 막는다.
CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_response_current
BEFORE INSERT ON guardian_portal_responses
WHEN NOT EXISTS (
  SELECT 1 FROM makeup_cases item
  WHERE item.app=NEW.app AND item.case_id=NEW.object_id AND item.student_id=NEW.student_id
    AND item.status='awaiting_parent' AND item.revision=NEW.revision
)
BEGIN
  SELECT RAISE(ABORT, 'PARENT_RESPONSE_STALE');
END;

-- decline이 먼저 저장됐으면 관리자 confirm이 같은 revision을 확정하지 못한다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_parent_decline_confirm
BEFORE UPDATE OF status ON makeup_cases
WHEN OLD.status='awaiting_parent' AND NEW.status='confirmed' AND EXISTS (
  SELECT 1 FROM guardian_portal_responses response
  WHERE response.app=OLD.app AND response.object_type='makeup' AND response.object_id=OLD.case_id
    AND response.student_id=OLD.student_id AND response.revision=OLD.revision AND response.response='decline'
)
BEGIN
  SELECT RAISE(ABORT, 'PARENT_DECLINED');
END;
