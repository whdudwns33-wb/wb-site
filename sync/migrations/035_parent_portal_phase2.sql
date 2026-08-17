-- 보호자 포털 v3: 내부 메모와 분리된 공개 숙제·준비물 및 enum-only 보호자 요청함.
CREATE TABLE IF NOT EXISTS guardian_lesson_publications (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  publication_id        TEXT    NOT NULL,
  source_task_id        TEXT    NOT NULL,
  task_owner            TEXT    NOT NULL,
  student_id            TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  task_identity_hash    TEXT    NOT NULL CHECK (length(task_identity_hash) = 64),
  lesson_date           TEXT    NOT NULL CHECK (
    COALESCE(length(lesson_date) = 10 AND strftime('%Y-%m-%d', lesson_date) = lesson_date, 0) = 1
  ),
  status                TEXT    NOT NULL CHECK (status IN ('published','withdrawn')),
  public_homework       TEXT    NOT NULL CHECK (length(public_homework) <= 500),
  public_readiness      TEXT    NOT NULL CHECK (length(public_readiness) <= 500),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT    NOT NULL,
  CHECK (
    (status = 'published' AND (length(public_homework) > 0 OR length(public_readiness) > 0))
    OR (status = 'withdrawn' AND public_homework = '' AND public_readiness = '')
  ),
  PRIMARY KEY (app, publication_id),
  UNIQUE (app, task_identity_hash, lesson_date)
);
CREATE INDEX IF NOT EXISTS idx_guardian_lesson_publications_student
  ON guardian_lesson_publications(app, student_id, lesson_date, status);
CREATE INDEX IF NOT EXISTS idx_guardian_lesson_publications_owner
  ON guardian_lesson_publications(app, task_owner, lesson_date);

CREATE TABLE IF NOT EXISTS guardian_lesson_publication_events (
  app              TEXT    NOT NULL CHECK (app = 'task'),
  event_id         TEXT    NOT NULL,
  publication_id   TEXT    NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  event_type       TEXT    NOT NULL CHECK (event_type IN ('published','updated','withdrawn')),
  public_homework  TEXT    NOT NULL CHECK (length(public_homework) <= 500),
  public_readiness TEXT    NOT NULL CHECK (length(public_readiness) <= 500),
  created_at       INTEGER NOT NULL,
  created_by       TEXT    NOT NULL,
  PRIMARY KEY (app, event_id),
  UNIQUE (app, publication_id, revision),
  FOREIGN KEY (app, publication_id) REFERENCES guardian_lesson_publications(app, publication_id)
);

CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publications_update
BEFORE UPDATE ON guardian_lesson_publications
WHEN NEW.publication_id IS NOT OLD.publication_id
  OR NEW.source_task_id IS NOT OLD.source_task_id
  OR NEW.task_owner IS NOT OLD.task_owner
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.student_identity_hash IS NOT OLD.student_identity_hash
  OR NEW.task_identity_hash IS NOT OLD.task_identity_hash
  OR NEW.lesson_date IS NOT OLD.lesson_date
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_INVALID_TRANSITION');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publications_no_delete
BEFORE DELETE ON guardian_lesson_publications
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publication_events_no_update
BEFORE UPDATE ON guardian_lesson_publication_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publication_events_no_delete
BEFORE DELETE ON guardian_lesson_publication_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_EVENT_APPEND_ONLY');
END;

CREATE TABLE IF NOT EXISTS guardian_requests (
  app               TEXT    NOT NULL CHECK (app = 'task'),
  request_id        TEXT    NOT NULL,
  student_id        TEXT    NOT NULL,
  client_request_id TEXT    NOT NULL CHECK (
    length(client_request_id) BETWEEN 16 AND 64
    AND client_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_type      TEXT    NOT NULL CHECK (request_type IN (
    'consultation','schedule_check','info_correction'
  )),
  status            TEXT    NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT,
  CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status IN ('resolved','dismissed') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  ),
  PRIMARY KEY (app, request_id),
  UNIQUE (app, student_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_requests_status
  ON guardian_requests(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_guardian_requests_student
  ON guardian_requests(app, student_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_requests_open_type
  ON guardian_requests(app, student_id, request_type)
  WHERE status='open';

CREATE TABLE IF NOT EXISTS guardian_request_events (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  event_id     TEXT    NOT NULL,
  request_id   TEXT    NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  event_type   TEXT    NOT NULL CHECK (event_type IN ('submitted','resolved','dismissed')),
  created_at   INTEGER NOT NULL,
  created_by   TEXT    NOT NULL,
  PRIMARY KEY (app, event_id),
  UNIQUE (app, request_id, revision),
  FOREIGN KEY (app, request_id) REFERENCES guardian_requests(app, request_id)
);

CREATE TRIGGER IF NOT EXISTS trg_guardian_requests_rate_limit
BEFORE INSERT ON guardian_requests
WHEN NOT EXISTS (
    SELECT 1 FROM guardian_requests existing
    WHERE existing.app=NEW.app AND existing.student_id=NEW.student_id
      AND existing.client_request_id=NEW.client_request_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM guardian_requests existing_open
    WHERE existing_open.app=NEW.app AND existing_open.student_id=NEW.student_id
      AND existing_open.request_type=NEW.request_type AND existing_open.status='open'
  )
  AND (
    SELECT COUNT(*) FROM guardian_requests recent
    WHERE recent.app=NEW.app AND recent.student_id=NEW.student_id
      AND recent.created_at >= NEW.created_at - 86400000
  ) >= 5
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_RATE_LIMIT');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_requests_update
BEFORE UPDATE ON guardian_requests
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.client_request_id IS NOT OLD.client_request_id
  OR NEW.request_type IS NOT OLD.request_type
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'open'
  OR NEW.status NOT IN ('resolved','dismissed')
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_INVALID_TRANSITION');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_requests_no_delete
BEFORE DELETE ON guardian_requests
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_request_events_no_update
BEFORE UPDATE ON guardian_request_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_request_events_no_delete
BEFORE DELETE ON guardian_request_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_responses_no_update
BEFORE UPDATE ON guardian_portal_responses
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PORTAL_RESPONSE_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_responses_no_delete
BEFORE DELETE ON guardian_portal_responses
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PORTAL_RESPONSE_APPEND_ONLY');
END;
