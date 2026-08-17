-- consult 학생 인증사진·질문: D1은 불변 제출 이력, JPEG 원본은 private R2에 둔다.
CREATE TABLE IF NOT EXISTS consult_submissions (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  submission_id     TEXT    NOT NULL CHECK (length(submission_id) BETWEEN 4 AND 128 AND submission_id LIKE 'cs_%'),
  client_request_id TEXT    NOT NULL CHECK (length(client_request_id) BETWEEN 1 AND 128),
  owner             TEXT    NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  kind              TEXT    NOT NULL CHECK (kind IN ('proof','question')),
  task_id           TEXT    CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 128),
  task_date         TEXT    CHECK (task_date IS NULL OR length(task_date) = 10),
  body_text         TEXT    NOT NULL CHECK (length(body_text) <= 2000),
  object_key        TEXT    CHECK (object_key IS NULL OR (length(object_key) BETWEEN 1 AND 200 AND object_key LIKE 'consult/%')),
  media_bytes       INTEGER CHECK (media_bytes IS NULL OR media_bytes BETWEEN 1 AND 2097152),
  media_expires_at  INTEGER CHECK (media_expires_at IS NULL OR media_expires_at > 0),
  status            TEXT    NOT NULL CHECK (status IN ('pending','approved','rejected','answered','cancelled')),
  answer_text       TEXT    CHECK (answer_text IS NULL OR length(answer_text) BETWEEN 1 AND 5000),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at >= created_at),
  reviewed_at       INTEGER CHECK (reviewed_at IS NULL OR reviewed_at > 0),
  reviewed_by       TEXT    CHECK (reviewed_by IS NULL OR length(reviewed_by) BETWEEN 1 AND 128),
  review_note       TEXT    CHECK (review_note IS NULL OR length(review_note) BETWEEN 1 AND 1000),
  PRIMARY KEY (app, submission_id),
  UNIQUE (app, owner, client_request_id),
  UNIQUE (app, object_key),
  CHECK ((object_key IS NULL AND media_bytes IS NULL AND media_expires_at IS NULL)
    OR (object_key IS NOT NULL AND media_bytes IS NOT NULL AND media_expires_at > created_at)),
  CHECK ((kind = 'proof' AND task_id IS NOT NULL AND task_date IS NOT NULL AND object_key IS NOT NULL
      AND status IN ('pending','approved','rejected','cancelled'))
    OR (kind = 'question' AND ((task_id IS NULL AND task_date IS NULL) OR (task_id IS NOT NULL AND task_date IS NOT NULL))
      AND (length(body_text) > 0 OR object_key IS NOT NULL)
      AND status IN ('pending','answered','rejected','cancelled'))),
  CHECK ((status IN ('pending','cancelled') AND answer_text IS NULL
      AND reviewed_at IS NULL AND reviewed_by IS NULL AND review_note IS NULL)
    OR (status = 'approved' AND answer_text IS NULL
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NULL)
    OR (status = 'rejected' AND answer_text IS NULL
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NOT NULL)
    OR (status = 'answered' AND answer_text IS NOT NULL
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_consult_submissions_owner
  ON consult_submissions(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_consult_submissions_owner_created
  ON consult_submissions(app, owner, created_at);
CREATE INDEX IF NOT EXISTS idx_consult_submissions_status
  ON consult_submissions(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_consult_submissions_task
  ON consult_submissions(app, task_id, task_date, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consult_submissions_one_pending_proof
  ON consult_submissions(app, owner, task_id, task_date)
  WHERE kind = 'proof' AND status = 'pending';

CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_daily_limit
BEFORE INSERT ON consult_submissions
WHEN (SELECT COUNT(*) FROM consult_submissions row
  WHERE row.app = NEW.app AND row.owner = NEW.owner AND row.created_at > NEW.created_at - 86400000) >= 20
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_DAILY_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_pending_limit
BEFORE INSERT ON consult_submissions
WHEN (SELECT COUNT(*) FROM consult_submissions row
  WHERE row.app = NEW.app AND row.owner = NEW.owner AND row.status = 'pending') >= 10
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_PENDING_LIMIT');
END;

-- 제출 내용과 R2 key는 고치지 않는다. pending 상태를 한 번 결정하는 CAS만 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_update_guard
BEFORE UPDATE ON consult_submissions
WHEN OLD.app IS NOT NEW.app
  OR OLD.submission_id IS NOT NEW.submission_id
  OR OLD.client_request_id IS NOT NEW.client_request_id
  OR OLD.owner IS NOT NEW.owner
  OR OLD.kind IS NOT NEW.kind
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.task_date IS NOT NEW.task_date
  OR OLD.body_text IS NOT NEW.body_text
  OR OLD.object_key IS NOT NEW.object_key
  OR OLD.media_bytes IS NOT NEW.media_bytes
  OR OLD.media_expires_at IS NOT NEW.media_expires_at
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR NOT (OLD.status = 'pending' AND (
    (OLD.kind = 'proof' AND NEW.status IN ('approved','rejected','cancelled'))
    OR (OLD.kind = 'question' AND NEW.status IN ('answered','rejected','cancelled'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_no_delete
BEFORE DELETE ON consult_submissions
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_HISTORY_REQUIRED');
END;
