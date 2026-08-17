-- 기존 보호자 공개 이력은 학생에게 자동 공개하지 않는다. 교사가 새로 체크한 revision만 학생에게 보인다.
ALTER TABLE guardian_lesson_publications
  ADD COLUMN student_visible INTEGER NOT NULL DEFAULT 0 CHECK (student_visible IN (0,1));
ALTER TABLE guardian_lesson_publication_events
  ADD COLUMN student_visible INTEGER NOT NULL DEFAULT 0 CHECK (student_visible IN (0,1));

-- 학생 웹앱은 보호자 세션과 완전히 분리한다. 원본 코드·토큰과 연락처는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS student_portal_access (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  student_id            TEXT    NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  student_identity_hash TEXT CHECK (
    student_identity_hash IS NULL OR (
      length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  guardian_identity_hash TEXT CHECK (
    guardian_identity_hash IS NULL OR (
      length(guardian_identity_hash) = 64 AND guardian_identity_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  scope_version         INTEGER NOT NULL DEFAULT 1 CHECK (scope_version = 1),
  accepted_at           INTEGER,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT    NOT NULL,
  CHECK (enabled = 0 OR (
    student_identity_hash IS NOT NULL AND guardian_identity_hash IS NOT NULL
    AND scope_version = 1 AND accepted_at IS NOT NULL
  )),
  PRIMARY KEY (app, student_id)
);

CREATE TABLE IF NOT EXISTS student_portal_codes (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  code_hash             TEXT    NOT NULL CHECK (length(code_hash) = 71 AND code_hash LIKE 'sha256:%'),
  student_id            TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  guardian_identity_hash TEXT   NOT NULL CHECK (length(guardian_identity_hash) = 64),
  scope_version         INTEGER NOT NULL CHECK (scope_version = 1),
  access_updated_at     INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  revoked               INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  issued_by             TEXT    NOT NULL,
  claim_id              TEXT CHECK (claim_id IS NULL OR length(claim_id) = 48),
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_student_portal_codes_student
  ON student_portal_codes(app, student_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS student_portal_sessions (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  token_hash            TEXT    NOT NULL CHECK (length(token_hash) = 71 AND token_hash LIKE 'sha256:%'),
  student_id            TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  guardian_identity_hash TEXT   NOT NULL CHECK (length(guardian_identity_hash) = 64),
  scope_version         INTEGER NOT NULL CHECK (scope_version = 1),
  access_updated_at     INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  revoked               INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_student_portal_sessions_student
  ON student_portal_sessions(app, student_id, revoked, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_revoke
AFTER UPDATE OF enabled, student_identity_hash, guardian_identity_hash, scope_version ON student_portal_access
WHEN NEW.enabled=0
  OR OLD.student_identity_hash IS NOT NEW.student_identity_hash
  OR OLD.guardian_identity_hash IS NOT NEW.guardian_identity_hash
  OR OLD.scope_version IS NOT NEW.scope_version
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

-- 명단에서 학생이 사라지거나 이름·재원기간이 바뀌면 기존 학생 링크를 즉시 폐기한다.
CREATE TRIGGER IF NOT EXISTS trg_student_portal_roster_identity_update
AFTER UPDATE OF data ON private_rosters
WHEN NEW.app='task'
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND revoked=0 AND NOT EXISTS (
    SELECT 1
    FROM json_each(OLD.data, '$.roster.students') old_student
    JOIN json_each(NEW.data, '$.roster.students') new_student
      ON json_extract(new_student.value, '$.id')=student_portal_codes.student_id
    WHERE json_extract(old_student.value, '$.id')=student_portal_codes.student_id
      AND json_extract(new_student.value, '$.name') IS json_extract(old_student.value, '$.name')
      AND json_extract(new_student.value, '$.start') IS json_extract(old_student.value, '$.start')
      AND json_extract(new_student.value, '$.end') IS json_extract(old_student.value, '$.end')
  );
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND revoked=0 AND NOT EXISTS (
    SELECT 1
    FROM json_each(OLD.data, '$.roster.students') old_student
    JOIN json_each(NEW.data, '$.roster.students') new_student
      ON json_extract(new_student.value, '$.id')=student_portal_sessions.student_id
    WHERE json_extract(old_student.value, '$.id')=student_portal_sessions.student_id
      AND json_extract(new_student.value, '$.name') IS json_extract(old_student.value, '$.name')
      AND json_extract(new_student.value, '$.start') IS json_extract(old_student.value, '$.start')
      AND json_extract(new_student.value, '$.end') IS json_extract(old_student.value, '$.end')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_roster_delete
AFTER DELETE ON private_rosters
WHEN OLD.app='task'
BEGIN
  UPDATE student_portal_codes SET revoked=1 WHERE app=OLD.app AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1 WHERE app=OLD.app AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_guardian_identity_update
AFTER UPDATE OF student_name, phone ON guardian_contacts_by_student
WHEN NEW.app='task' AND (OLD.student_name IS NOT NEW.student_name OR OLD.phone IS NOT NEW.phone)
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_guardian_identity_delete
AFTER DELETE ON guardian_contacts_by_student
WHEN OLD.app='task'
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=OLD.app AND student_id=OLD.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=OLD.app AND student_id=OLD.student_id AND revoked=0;
END;
