-- 토·일 예정 시간표와 분리해서 기록하는 실제 등·하원 원장.
-- 학생·수업 연결은 stable studentId와 lesson task id만 사용한다.
CREATE TABLE IF NOT EXISTS weekend_actual_visits (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  visit_id        TEXT    NOT NULL CHECK (
    visit_id GLOB 'wv_[0-9a-f]*' AND substr(visit_id,4) NOT GLOB '*[^0-9a-f]*' AND length(visit_id) = 35
  ),
  student_id      TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  lesson_task_id  TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 128),
  staff_id        TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  visit_date      TEXT    NOT NULL CHECK (visit_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  check_in_at     INTEGER NOT NULL CHECK (check_in_at > 0),
  check_out_at    INTEGER CHECK (check_out_at IS NULL OR check_out_at >= check_in_at),
  status          TEXT    NOT NULL CHECK (status IN ('active','completed','cancelled')),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  created_by      TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  updated_by      TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, visit_id),
  UNIQUE (app, student_id, lesson_task_id, visit_date)
);

CREATE INDEX IF NOT EXISTS idx_weekend_actual_visits_date_staff
  ON weekend_actual_visits(app, visit_date, staff_id, status);
CREATE INDEX IF NOT EXISTS idx_weekend_actual_visits_student
  ON weekend_actual_visits(app, student_id, visit_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekend_actual_visits_one_open
  ON weekend_actual_visits(app, student_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS weekend_actual_visit_events (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  event_id     TEXT    NOT NULL CHECK (
    event_id GLOB 'wve_[0-9a-f]*' AND substr(event_id,5) NOT GLOB '*[^0-9a-f]*' AND length(event_id) = 36
  ),
  visit_id     TEXT    NOT NULL CHECK (length(visit_id) BETWEEN 1 AND 128),
  event_type   TEXT    NOT NULL CHECK (event_type IN ('check_in','check_out','correct','cancel','reopen')),
  event_data   TEXT    NOT NULL,
  actor_id     TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, event_id),
  FOREIGN KEY (app, visit_id) REFERENCES weekend_actual_visits(app, visit_id)
);

CREATE INDEX IF NOT EXISTS idx_weekend_actual_visit_events_visit
  ON weekend_actual_visit_events(app, visit_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visits_update_guard
BEFORE UPDATE ON weekend_actual_visits
WHEN NEW.app <> OLD.app
  OR NEW.visit_id <> OLD.visit_id
  OR NEW.student_id <> OLD.student_id
  OR NEW.lesson_task_id <> OLD.lesson_task_id
  OR NEW.staff_id <> OLD.staff_id
  OR NEW.visit_date <> OLD.visit_date
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visits_no_delete
BEFORE DELETE ON weekend_actual_visits
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_NO_DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visit_events_no_update
BEFORE UPDATE ON weekend_actual_visit_events
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visit_events_no_delete
BEFORE DELETE ON weekend_actual_visit_events
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_EVENT_NO_DELETE');
END;
