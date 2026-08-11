-- 모든 학생의 결석 수업과 보강 일정을 잇는 운영 원장.
-- 이름·전화·보호자·상담 메모는 저장하지 않고 stable ID만 보관한다.
CREATE TABLE IF NOT EXISTS makeup_cases (
  app                         TEXT    NOT NULL CHECK (app = 'task'),
  case_id                     TEXT    NOT NULL,
  student_id                  TEXT    NOT NULL,
  source_task_id              TEXT    NOT NULL,
  source_date                 TEXT    NOT NULL CHECK (
    length(source_date) = 10 AND strftime('%Y-%m-%d', source_date) = source_date
  ),
  source_teacher_id           TEXT    NOT NULL,
  consumption_group_id        TEXT    NOT NULL,
  status                      TEXT    NOT NULL CHECK (status IN (
    'review_pending','reviewed','awaiting_parent','confirmed','completed','cancelled'
  )),
  revision                    INTEGER NOT NULL CHECK (revision >= 1),
  proposed_start_at           TEXT,
  proposed_end_at             TEXT,
  proposed_staff_id           TEXT,
  confirmed_start_at          TEXT,
  confirmed_end_at            TEXT,
  confirmed_staff_id          TEXT,
  completed_at                INTEGER,
  completed_by                TEXT,
  cancelled_at                INTEGER,
  cancelled_by                TEXT,
  reason                      TEXT CHECK (reason IS NULL OR reason IN (
    'policy_ineligible','already_resolved','parent_declined',
    'schedule_unavailable','student_inactive','other'
  )),
  notification_needed         INTEGER NOT NULL DEFAULT 0 CHECK (notification_needed IN (0,1)),
  notification_event          TEXT,
  notification_event_revision INTEGER NOT NULL DEFAULT 0 CHECK (notification_event_revision >= 0),
  history                     TEXT    NOT NULL CHECK (json_valid(history)),
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  PRIMARY KEY (app, case_id),
  UNIQUE (app, source_task_id, source_date),
  UNIQUE (app, consumption_group_id),
  CHECK (
    (proposed_start_at IS NULL AND proposed_end_at IS NULL AND proposed_staff_id IS NULL)
    OR (
      proposed_start_at IS NOT NULL AND proposed_end_at IS NOT NULL AND proposed_staff_id IS NOT NULL
      AND length(proposed_start_at) = 25 AND length(proposed_end_at) = 25
      AND substr(proposed_start_at, 11, 1) = 'T' AND substr(proposed_end_at, 11, 1) = 'T'
      AND substr(proposed_start_at, 20, 6) = '+09:00' AND substr(proposed_end_at, 20, 6) = '+09:00'
      AND substr(proposed_start_at, 1, 10) = substr(proposed_end_at, 1, 10)
      AND proposed_start_at < proposed_end_at
    )
  ),
  CHECK (
    (confirmed_start_at IS NULL AND confirmed_end_at IS NULL AND confirmed_staff_id IS NULL)
    OR (
      confirmed_start_at IS NOT NULL AND confirmed_end_at IS NOT NULL AND confirmed_staff_id IS NOT NULL
      AND length(confirmed_start_at) = 25 AND length(confirmed_end_at) = 25
      AND substr(confirmed_start_at, 11, 1) = 'T' AND substr(confirmed_end_at, 11, 1) = 'T'
      AND substr(confirmed_start_at, 20, 6) = '+09:00' AND substr(confirmed_end_at, 20, 6) = '+09:00'
      AND substr(confirmed_start_at, 1, 10) = substr(confirmed_end_at, 1, 10)
      AND confirmed_start_at < confirmed_end_at
    )
  ),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
  CHECK (
    notification_needed = 0 OR (
      notification_event IN ('proposal','confirmed','cancelled')
      AND notification_event_revision >= 1 AND notification_event_revision <= revision
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_makeup_status
  ON makeup_cases(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_makeup_student
  ON makeup_cases(app, student_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_makeup_staff_time
  ON makeup_cases(app, confirmed_staff_id, confirmed_start_at, confirmed_end_at);

-- 서로 다른 보강 건을 동시에 확정해도 두 번째 쓰기는 같은 SQLite 트랜잭션에서 막는다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_confirmed_time_insert
BEFORE INSERT ON makeup_cases
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM makeup_cases AS other
  WHERE other.app = NEW.app AND other.status = 'confirmed' AND other.case_id <> NEW.case_id
    AND other.confirmed_start_at < NEW.confirmed_end_at
    AND NEW.confirmed_start_at < other.confirmed_end_at
    AND (other.student_id = NEW.student_id OR other.confirmed_staff_id = NEW.confirmed_staff_id)
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_TIME_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_makeup_confirmed_time_update
BEFORE UPDATE OF status,confirmed_start_at,confirmed_end_at,confirmed_staff_id,student_id ON makeup_cases
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM makeup_cases AS other
  WHERE other.app = NEW.app AND other.status = 'confirmed' AND other.case_id <> NEW.case_id
    AND other.confirmed_start_at < NEW.confirmed_end_at
    AND NEW.confirmed_start_at < other.confirmed_end_at
    AND (other.student_id = NEW.student_id OR other.confirmed_staff_id = NEW.confirmed_staff_id)
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_TIME_CONFLICT');
END;

-- API 실수나 직접 쓰기로도 원장/타 담당자가 완료자로 기록될 수 없다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_complete_assignee
BEFORE UPDATE OF status,completed_by ON makeup_cases
WHEN NEW.status = 'completed' AND (
  OLD.status <> 'confirmed'
  OR NEW.confirmed_staff_id IS NOT OLD.confirmed_staff_id
  OR OLD.confirmed_staff_id IS NULL
  OR NEW.completed_by IS NULL
  OR NEW.completed_by <> OLD.confirmed_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_COMPLETE_ASSIGNEE');
END;
