-- 관리자가 여러 선생님에게 전달하는 공통 요청을 버전별로 보관한다.
-- 대상은 저장 시점의 stable staffId 목록으로 고정하며, 수정하면 새 revision을 만든다.
CREATE TABLE IF NOT EXISTS admin_directives (
  app              TEXT    NOT NULL CHECK (app = 'task'),
  directive_id     TEXT    NOT NULL CHECK (
    length(directive_id) BETWEEN 8 AND 80
    AND directive_id LIKE 'adr_%'
    AND directive_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status           TEXT    NOT NULL CHECK (status IN ('active', 'ended')),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  created_at       INTEGER NOT NULL CHECK (created_at > 0),
  created_by       TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at),
  updated_by       TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
  ended_at         INTEGER,
  ended_by         TEXT,
  PRIMARY KEY (app, directive_id),
  CHECK (
    (status = 'active' AND ended_at IS NULL AND ended_by IS NULL)
    OR
    (status = 'ended' AND ended_at IS NOT NULL AND ended_at >= created_at
      AND ended_by IS NOT NULL AND length(ended_by) BETWEEN 1 AND 100)
  )
);

CREATE TABLE IF NOT EXISTS admin_directive_revisions (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  directive_id       TEXT    NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  title              TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
  body               TEXT    NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  priority           TEXT    NOT NULL CHECK (priority IN ('normal', 'important')),
  starts_date        TEXT    NOT NULL CHECK (
    length(starts_date) = 10
    AND starts_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  expires_date       TEXT CHECK (
    expires_date IS NULL OR (
      length(expires_date) = 10
      AND expires_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND expires_date >= starts_date
    )
  ),
  audience_staff_ids TEXT    NOT NULL CHECK (
    json_valid(audience_staff_ids)
    AND json_type(audience_staff_ids) = 'array'
    AND json_array_length(audience_staff_ids) BETWEEN 1 AND 100
  ),
  created_at         INTEGER NOT NULL CHECK (created_at > 0),
  created_by         TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  PRIMARY KEY (app, directive_id, revision),
  FOREIGN KEY (app, directive_id) REFERENCES admin_directives(app, directive_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_directive_revisions_created
  ON admin_directive_revisions(app, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_directive_receipt_events (
  app              TEXT    NOT NULL CHECK (app = 'task'),
  receipt_event_id TEXT    NOT NULL CHECK (
    length(receipt_event_id) BETWEEN 9 AND 90
    AND receipt_event_id LIKE 'adre_%'
    AND receipt_event_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  directive_id     TEXT    NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  staff_id         TEXT    NOT NULL CHECK (
    length(staff_id) BETWEEN 1 AND 80
    AND staff_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  event_type       TEXT    NOT NULL CHECK (event_type IN ('opened', 'acknowledged')),
  created_at       INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, receipt_event_id),
  UNIQUE (app, directive_id, revision, staff_id, event_type),
  FOREIGN KEY (app, directive_id, revision)
    REFERENCES admin_directive_revisions(app, directive_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_admin_directive_receipts_lookup
  ON admin_directive_receipt_events(app, directive_id, revision, staff_id, event_type);

CREATE TRIGGER IF NOT EXISTS trg_admin_directive_audience_insert
BEFORE INSERT ON admin_directive_revisions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.audience_staff_ids)
    WHERE type <> 'text'
      OR length(value) NOT BETWEEN 1 AND 80
      OR value GLOB '*[^A-Za-z0-9_-]*'
  ) THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_INVALID_AUDIENCE') END;
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM json_each(NEW.audience_staff_ids)
  ) <> (
    SELECT COUNT(DISTINCT value) FROM json_each(NEW.audience_staff_ids)
  ) THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_DUPLICATE_AUDIENCE') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_directives_update_guard
BEFORE UPDATE ON admin_directives
BEGIN
  SELECT CASE WHEN NEW.app <> OLD.app
    OR NEW.directive_id <> OLD.directive_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by <> OLD.created_by
  THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_IMMUTABLE_FIELDS') END;
  SELECT CASE WHEN NOT (
    OLD.status = 'active'
    AND NEW.updated_at > OLD.updated_at
    AND (
      (NEW.status = 'active'
        AND NEW.current_revision = OLD.current_revision + 1
        AND NEW.ended_at IS NULL AND NEW.ended_by IS NULL)
      OR
      (NEW.status = 'ended'
        AND NEW.current_revision = OLD.current_revision
        AND NEW.ended_at IS NOT NULL AND NEW.ended_by IS NOT NULL)
    )
  ) THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_INVALID_TRANSITION') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_directives_no_delete
BEFORE DELETE ON admin_directives
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_revisions_no_update
BEFORE UPDATE ON admin_directive_revisions
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_REVISION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_revisions_no_delete
BEFORE DELETE ON admin_directive_revisions
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_REVISION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_receipts_no_update
BEFORE UPDATE ON admin_directive_receipt_events
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_RECEIPT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_receipts_no_delete
BEFORE DELETE ON admin_directive_receipt_events
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_RECEIPT_APPEND_ONLY');
END;
