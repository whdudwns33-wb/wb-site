-- 학생 앱 v3: 기존 v2 봉인은 그대로 두고 자기 체크 동의 비트만 합성한다.
ALTER TABLE student_portal_access
  ADD COLUMN self_check_enabled INTEGER NOT NULL DEFAULT 0 CHECK (self_check_enabled IN (0,1));
ALTER TABLE student_portal_access
  ADD COLUMN self_check_confirmed_at INTEGER CHECK (self_check_confirmed_at IS NULL OR self_check_confirmed_at>0);
ALTER TABLE student_portal_codes
  ADD COLUMN self_check_enabled INTEGER NOT NULL DEFAULT 0 CHECK (self_check_enabled IN (0,1));
ALTER TABLE student_portal_sessions
  ADD COLUMN self_check_enabled INTEGER NOT NULL DEFAULT 0 CHECK (self_check_enabled IN (0,1));

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_access_revoke
AFTER UPDATE OF self_check_enabled, self_check_confirmed_at ON student_portal_access
WHEN OLD.self_check_enabled IS NOT NEW.self_check_enabled
  OR OLD.self_check_confirmed_at IS NOT NEW.self_check_confirmed_at
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_code_scope_insert
BEFORE INSERT ON student_portal_codes
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.updated_at=NEW.access_updated_at
    AND access.effective_scope_version=NEW.effective_scope_version
    AND access.self_check_enabled=NEW.self_check_enabled
    AND (access.self_check_enabled=0 OR (
      access.effective_scope_version=2
      AND access.scope_confirmed_at=access.updated_at
      AND access.self_check_confirmed_at=access.updated_at
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_CODE_SELF_CHECK_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_session_scope_insert
BEFORE INSERT ON student_portal_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.updated_at=NEW.access_updated_at
    AND access.effective_scope_version=NEW.effective_scope_version
    AND access.self_check_enabled=NEW.self_check_enabled
    AND (access.self_check_enabled=0 OR (
      access.effective_scope_version=2
      AND access.scope_confirmed_at=access.updated_at
      AND access.self_check_confirmed_at=access.updated_at
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_SESSION_SELF_CHECK_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_disable_scope
AFTER UPDATE OF enabled ON student_portal_access
WHEN NEW.enabled=0 AND (NEW.self_check_enabled<>0 OR NEW.self_check_confirmed_at IS NOT NULL)
BEGIN
  UPDATE student_portal_access SET self_check_enabled=0,self_check_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_scope_mismatch
AFTER UPDATE OF updated_at ON student_portal_access
WHEN NEW.enabled=1 AND NEW.self_check_enabled=1
  AND (NEW.effective_scope_version<>2
    OR NEW.scope_confirmed_at IS NOT NEW.updated_at
    OR NEW.self_check_confirmed_at IS NOT NEW.updated_at)
BEGIN
  UPDATE student_portal_access SET self_check_enabled=0,self_check_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id AND self_check_enabled=1;
END;

CREATE TABLE IF NOT EXISTS student_lesson_self_checks (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  publication_id        TEXT    NOT NULL CHECK (length(publication_id) BETWEEN 1 AND 128),
  publication_revision  INTEGER NOT NULL CHECK (publication_revision >= 1),
  student_id            TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  student_identity_hash TEXT    NOT NULL CHECK (
    length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  response              TEXT    NOT NULL CHECK (response IN ('completed','help_needed')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  responded_at          INTEGER NOT NULL CHECK (responded_at > 0),
  confirmed_at          INTEGER CHECK (confirmed_at IS NULL OR confirmed_at > 0),
  confirmed_by          TEXT CHECK (confirmed_by IS NULL OR length(confirmed_by) BETWEEN 1 AND 128),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK ((confirmed_at IS NULL AND confirmed_by IS NULL)
    OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  PRIMARY KEY (app, publication_id),
  FOREIGN KEY (app, publication_id) REFERENCES guardian_lesson_publications(app, publication_id)
);
CREATE INDEX IF NOT EXISTS idx_student_lesson_self_checks_student
  ON student_lesson_self_checks(app, student_id, updated_at);

CREATE TABLE IF NOT EXISTS student_lesson_self_check_events (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  event_id              TEXT    NOT NULL CHECK (length(event_id)=52 AND event_id LIKE 'sce_%'),
  publication_id        TEXT    NOT NULL CHECK (length(publication_id) BETWEEN 1 AND 128),
  publication_revision  INTEGER NOT NULL CHECK (publication_revision >= 1),
  student_id            TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  student_identity_hash TEXT    NOT NULL CHECK (
    length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  event_type            TEXT    NOT NULL CHECK (event_type IN ('student_set','teacher_confirmed')),
  response              TEXT    NOT NULL CHECK (response IN ('completed','help_needed')),
  actor_type            TEXT    NOT NULL CHECK (actor_type IN ('student','staff')),
  actor_id              TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, event_id),
  UNIQUE (app, publication_id, publication_revision, revision),
  FOREIGN KEY (app, publication_id) REFERENCES guardian_lesson_publications(app, publication_id)
);
CREATE INDEX IF NOT EXISTS idx_student_lesson_self_check_events_rate
  ON student_lesson_self_check_events(app, student_id, event_type, created_at);

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_rate_insert
BEFORE INSERT ON student_lesson_self_checks
WHEN (SELECT COUNT(*) FROM student_lesson_self_check_events event
  WHERE event.app=NEW.app AND event.student_id=NEW.student_id
    AND event.event_type='student_set' AND event.created_at>NEW.updated_at-86400000) >= 30
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_RATE_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_update_guard
BEFORE UPDATE ON student_lesson_self_checks
WHEN OLD.app IS NOT NEW.app
  OR OLD.publication_id IS NOT NEW.publication_id
  OR OLD.student_id IS NOT NEW.student_id
  OR OLD.student_identity_hash IS NOT NEW.student_identity_hash
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.revision<>OLD.revision+1
  OR NEW.updated_at<=OLD.updated_at
  OR NEW.publication_revision<OLD.publication_revision
  OR NOT (
    (NEW.confirmed_at IS NULL AND NEW.confirmed_by IS NULL
      AND NEW.responded_at=NEW.updated_at
      AND NOT (OLD.response='completed' AND OLD.confirmed_at IS NOT NULL
        AND NEW.publication_revision=OLD.publication_revision)
      AND (NEW.response IS NOT OLD.response OR NEW.publication_revision>OLD.publication_revision))
    OR
    (OLD.confirmed_at IS NULL AND OLD.confirmed_by IS NULL
      AND NEW.confirmed_at IS NOT NULL AND NEW.confirmed_by IS NOT NULL
      AND NEW.publication_revision=OLD.publication_revision
      AND NEW.response=OLD.response AND NEW.responded_at=OLD.responded_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_INVALID_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_rate_update
BEFORE UPDATE OF response, publication_revision ON student_lesson_self_checks
WHEN (OLD.response IS NOT NEW.response OR OLD.publication_revision IS NOT NEW.publication_revision)
  AND (SELECT COUNT(*) FROM student_lesson_self_check_events event
    WHERE event.app=NEW.app AND event.student_id=NEW.student_id
      AND event.event_type='student_set' AND event.created_at>NEW.updated_at-86400000) >= 30
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_RATE_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_no_delete
BEFORE DELETE ON student_lesson_self_checks
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_HISTORY_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_check_events_no_update
BEFORE UPDATE ON student_lesson_self_check_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_check_events_no_delete
BEFORE DELETE ON student_lesson_self_check_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_EVENT_APPEND_ONLY');
END;
