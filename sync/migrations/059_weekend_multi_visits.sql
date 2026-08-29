-- 같은 학생·수업·실제 방문일에도 등·하원 구간을 여러 번 보존한다.
-- 구형 클라이언트는 visit_sequence=1만 사용하므로 기존 완료 기록을 새 방문으로 오인하지 않는다.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS trg_weekend_actual_visit_events_no_delete;
DROP TRIGGER IF EXISTS trg_weekend_actual_visit_events_no_update;
DROP TRIGGER IF EXISTS trg_weekend_actual_visits_no_delete;
DROP TRIGGER IF EXISTS trg_weekend_actual_visits_source_date_guard;
DROP TRIGGER IF EXISTS trg_weekend_actual_visits_update_guard;

CREATE TABLE weekend_actual_visits_next (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  visit_id        TEXT    NOT NULL CHECK (
    visit_id GLOB 'wv_[0-9a-f]*' AND substr(visit_id,4) NOT GLOB '*[^0-9a-f]*' AND length(visit_id) = 35
  ),
  student_id      TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  lesson_task_id  TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 128),
  staff_id        TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  visit_date      TEXT    NOT NULL CHECK (visit_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source_date     TEXT    CHECK (
    source_date IS NULL OR source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  visit_sequence  INTEGER NOT NULL DEFAULT 1 CHECK (visit_sequence BETWEEN 1 AND 99),
  check_in_at     INTEGER NOT NULL CHECK (check_in_at > 0),
  check_out_at    INTEGER CHECK (check_out_at IS NULL OR check_out_at >= check_in_at),
  status          TEXT    NOT NULL CHECK (status IN ('active','completed','cancelled')),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  created_by      TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  updated_by      TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, visit_id),
  UNIQUE (app, student_id, lesson_task_id, visit_date, visit_sequence)
);

CREATE TABLE weekend_actual_visit_events_next (
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
  FOREIGN KEY (app, visit_id) REFERENCES weekend_actual_visits_next(app, visit_id)
);

INSERT INTO weekend_actual_visits_next (
  app, visit_id, student_id, lesson_task_id, staff_id, visit_date, source_date, visit_sequence,
  check_in_at, check_out_at, status, revision, created_at, updated_at, created_by, updated_by
)
SELECT
  app, visit_id, student_id, lesson_task_id, staff_id, visit_date, source_date, 1,
  check_in_at, check_out_at, status, revision, created_at, updated_at, created_by, updated_by
FROM weekend_actual_visits;

INSERT INTO weekend_actual_visit_events_next (
  app, event_id, visit_id, event_type, event_data, actor_id, created_at
)
SELECT app, event_id, visit_id, event_type, event_data, actor_id, created_at
FROM weekend_actual_visit_events;

DROP TABLE weekend_actual_visit_events;
DROP TABLE weekend_actual_visits;
ALTER TABLE weekend_actual_visits_next RENAME TO weekend_actual_visits;
ALTER TABLE weekend_actual_visit_events_next RENAME TO weekend_actual_visit_events;

CREATE INDEX idx_weekend_actual_visits_date_staff
  ON weekend_actual_visits(app, visit_date, staff_id, status);
CREATE INDEX idx_weekend_actual_visits_student
  ON weekend_actual_visits(app, student_id, visit_date DESC);
CREATE INDEX idx_weekend_actual_visits_lesson_day
  ON weekend_actual_visits(app, student_id, lesson_task_id, visit_date, visit_sequence);
CREATE UNIQUE INDEX idx_weekend_actual_visits_one_open
  ON weekend_actual_visits(app, student_id)
  WHERE status = 'active';
CREATE INDEX idx_weekend_actual_visit_events_visit
  ON weekend_actual_visit_events(app, visit_id, created_at);

CREATE TRIGGER trg_weekend_actual_visits_update_guard
BEFORE UPDATE ON weekend_actual_visits
WHEN NEW.app <> OLD.app
  OR NEW.visit_id <> OLD.visit_id
  OR NEW.student_id <> OLD.student_id
  OR NEW.lesson_task_id <> OLD.lesson_task_id
  OR NEW.staff_id <> OLD.staff_id
  OR NEW.visit_date <> OLD.visit_date
  OR NEW.visit_sequence <> OLD.visit_sequence
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_IMMUTABLE');
END;

CREATE TRIGGER trg_weekend_actual_visits_source_date_guard
BEFORE UPDATE OF source_date ON weekend_actual_visits
WHEN NEW.source_date IS NOT OLD.source_date
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_IMMUTABLE');
END;

-- 한 원 수업 카드는 한 실제 방문일에만 연결한다. 같은 실제 방문일의 여러 구간은 허용한다.
CREATE TRIGGER trg_weekend_actual_visits_source_date_insert_guard
BEFORE INSERT ON weekend_actual_visits
WHEN NEW.status <> 'cancelled'
  AND NEW.source_date IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM weekend_actual_visits linked
    WHERE linked.app = NEW.app
      AND linked.student_id = NEW.student_id
      AND linked.lesson_task_id = NEW.lesson_task_id
      AND linked.source_date = NEW.source_date
      AND linked.visit_date <> NEW.visit_date
      AND linked.status <> 'cancelled'
  )
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_SOURCE_DATE_ALREADY_LINKED');
END;

CREATE TRIGGER trg_weekend_actual_visits_source_date_reopen_guard
BEFORE UPDATE OF status ON weekend_actual_visits
WHEN OLD.status = 'cancelled'
  AND NEW.status <> 'cancelled'
  AND NEW.source_date IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM weekend_actual_visits linked
    WHERE linked.app = NEW.app
      AND linked.student_id = NEW.student_id
      AND linked.lesson_task_id = NEW.lesson_task_id
      AND linked.source_date = NEW.source_date
      AND linked.visit_date <> NEW.visit_date
      AND linked.status <> 'cancelled'
  )
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_SOURCE_DATE_ALREADY_LINKED');
END;

CREATE TRIGGER trg_weekend_actual_visits_time_insert_guard
BEFORE INSERT ON weekend_actual_visits
WHEN NEW.status <> 'cancelled'
  AND EXISTS (
    SELECT 1 FROM weekend_actual_visits sibling
    WHERE sibling.app = NEW.app
      AND sibling.student_id = NEW.student_id
      AND sibling.lesson_task_id = NEW.lesson_task_id
      AND sibling.visit_date = NEW.visit_date
      AND sibling.status <> 'cancelled'
      AND NOT (
        COALESCE(NEW.check_out_at, 9223372036854775807) <= sibling.check_in_at
        OR COALESCE(sibling.check_out_at, 9223372036854775807) <= NEW.check_in_at
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_TIME_OVERLAP');
END;

CREATE TRIGGER trg_weekend_actual_visits_time_update_guard
BEFORE UPDATE OF check_in_at, check_out_at, status ON weekend_actual_visits
WHEN NEW.status <> 'cancelled'
  AND (
    EXISTS (
      SELECT 1 FROM weekend_actual_visits sibling
      WHERE sibling.app = NEW.app
        AND sibling.student_id = NEW.student_id
        AND sibling.lesson_task_id = NEW.lesson_task_id
        AND sibling.visit_date = NEW.visit_date
        AND sibling.visit_id <> NEW.visit_id
        AND sibling.status <> 'cancelled'
        AND NOT (
          COALESCE(NEW.check_out_at, 9223372036854775807) <= sibling.check_in_at
          OR COALESCE(sibling.check_out_at, 9223372036854775807) <= NEW.check_in_at
        )
    )
    OR EXISTS (
      SELECT 1 FROM weekend_actual_visits earlier
      WHERE earlier.app = NEW.app
        AND earlier.student_id = NEW.student_id
        AND earlier.lesson_task_id = NEW.lesson_task_id
        AND earlier.visit_date = NEW.visit_date
        AND earlier.visit_sequence < NEW.visit_sequence
        AND earlier.status <> 'cancelled'
        AND (earlier.check_out_at IS NULL OR earlier.check_out_at > NEW.check_in_at)
    )
    OR EXISTS (
      SELECT 1 FROM weekend_actual_visits later
      WHERE later.app = NEW.app
        AND later.student_id = NEW.student_id
        AND later.lesson_task_id = NEW.lesson_task_id
        AND later.visit_date = NEW.visit_date
        AND later.visit_sequence > NEW.visit_sequence
        AND later.status <> 'cancelled'
        AND (NEW.check_out_at IS NULL OR NEW.check_out_at > later.check_in_at)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_TIME_OVERLAP');
END;

CREATE TRIGGER trg_weekend_actual_visits_no_delete
BEFORE DELETE ON weekend_actual_visits
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_NO_DELETE');
END;

CREATE TRIGGER trg_weekend_actual_visit_events_no_update
BEFORE UPDATE ON weekend_actual_visit_events
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_EVENT_IMMUTABLE');
END;

CREATE TRIGGER trg_weekend_actual_visit_events_no_delete
BEFORE DELETE ON weekend_actual_visit_events
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_EVENT_NO_DELETE');
END;

PRAGMA defer_foreign_keys = OFF;
