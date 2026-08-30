-- 당일 남은 수업 인계. 정규 tasks/checks/session_packs는 변경하지 않는다.
CREATE TABLE IF NOT EXISTS lesson_handoffs (
  app                   TEXT NOT NULL CHECK (app = 'task'),
  handoff_id            TEXT NOT NULL CHECK (
    length(handoff_id) = 35 AND handoff_id GLOB 'lh_[0-9a-f]*'
    AND substr(handoff_id,4) NOT GLOB '*[^0-9a-f]*'
  ),
  data_generation       INTEGER NOT NULL CHECK (data_generation >= 0),
  lesson_task_id        TEXT NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 128),
  student_id            TEXT NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  source_date           TEXT NOT NULL CHECK (length(source_date) = 10 AND strftime('%Y-%m-%d',source_date) = source_date),
  record_date           TEXT NOT NULL CHECK (length(record_date) = 10 AND strftime('%Y-%m-%d',record_date) = record_date),
  slot_id               TEXT NOT NULL DEFAULT '' CHECK (length(slot_id) <= 128),
  source_staff_id       TEXT NOT NULL CHECK (length(source_staff_id) BETWEEN 1 AND 128),
  recipient_staff_id    TEXT NOT NULL CHECK (length(recipient_staff_id) BETWEEN 1 AND 128 AND recipient_staff_id <> source_staff_id),
  visit_id              TEXT,
  start_time            TEXT NOT NULL CHECK (length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'),
  total_half_units      INTEGER NOT NULL CHECK (total_half_units BETWEEN 2 AND 12),
  completed_half_units  INTEGER NOT NULL CHECK (completed_half_units >= 1),
  remaining_half_units  INTEGER NOT NULL CHECK (remaining_half_units >= 1),
  note                  TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  source_memo_json      TEXT NOT NULL CHECK (json_valid(source_memo_json) AND json_type(source_memo_json) = 'object'),
  memo_json             TEXT NOT NULL CHECK (json_valid(memo_json) AND json_type(memo_json) = 'object'),
  student_snapshot_json TEXT NOT NULL CHECK (json_valid(student_snapshot_json) AND json_type(student_snapshot_json) = 'object'),
  lesson_snapshot_json  TEXT NOT NULL CHECK (json_valid(lesson_snapshot_json) AND json_type(lesson_snapshot_json) = 'object'),
  status                TEXT NOT NULL CHECK (status IN ('pending','accepted','completed','cancelled')),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= created_at),
  created_by            TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  updated_by            TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  accepted_at           INTEGER,
  completed_at          INTEGER,
  cancelled_at          INTEGER,
  cancel_reason         TEXT NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 500),
  PRIMARY KEY (app,handoff_id),
  CHECK (completed_half_units + remaining_half_units = total_half_units),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (completed_at IS NULL OR (accepted_at IS NOT NULL AND completed_at >= accepted_at)),
  CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
  CHECK (
    (status = 'pending' AND accepted_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'completed' AND accepted_at IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND length(trim(cancel_reason)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_handoffs_one_source
  ON lesson_handoffs(app,lesson_task_id,source_date)
  WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_lesson_handoffs_day_source
  ON lesson_handoffs(app,data_generation,record_date,source_staff_id);
CREATE INDEX IF NOT EXISTS idx_lesson_handoffs_day_recipient
  ON lesson_handoffs(app,data_generation,record_date,recipient_staff_id);

CREATE TABLE IF NOT EXISTS lesson_handoff_events (
  app          TEXT NOT NULL CHECK (app = 'task'),
  event_id     TEXT NOT NULL CHECK (
    length(event_id) = 36 AND event_id GLOB 'lhe_[0-9a-f]*'
    AND substr(event_id,5) NOT GLOB '*[^0-9a-f]*'
  ),
  handoff_id   TEXT NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  event_type   TEXT NOT NULL CHECK (event_type IN ('create','accept','save','complete','cancel')),
  event_data   TEXT NOT NULL CHECK (json_valid(event_data)),
  actor_id     TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app,event_id),
  UNIQUE (app,handoff_id,revision),
  FOREIGN KEY (app,handoff_id) REFERENCES lesson_handoffs(app,handoff_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_handoff_events_handoff
  ON lesson_handoff_events(app,handoff_id,revision);

CREATE TRIGGER IF NOT EXISTS trg_lesson_handoffs_immutable
BEFORE UPDATE ON lesson_handoffs
WHEN NEW.app IS NOT OLD.app
  OR NEW.handoff_id IS NOT OLD.handoff_id
  OR NEW.data_generation IS NOT OLD.data_generation
  OR NEW.lesson_task_id IS NOT OLD.lesson_task_id
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.source_date IS NOT OLD.source_date
  OR NEW.record_date IS NOT OLD.record_date
  OR NEW.slot_id IS NOT OLD.slot_id
  OR NEW.source_staff_id IS NOT OLD.source_staff_id
  OR NEW.recipient_staff_id IS NOT OLD.recipient_staff_id
  OR NEW.visit_id IS NOT OLD.visit_id
  OR NEW.start_time IS NOT OLD.start_time
  OR NEW.total_half_units IS NOT OLD.total_half_units
  OR NEW.completed_half_units IS NOT OLD.completed_half_units
  OR NEW.remaining_half_units IS NOT OLD.remaining_half_units
  OR NEW.note IS NOT OLD.note
  OR NEW.source_memo_json IS NOT OLD.source_memo_json
  OR NEW.student_snapshot_json IS NOT OLD.student_snapshot_json
  OR NEW.lesson_snapshot_json IS NOT OLD.lesson_snapshot_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN
  SELECT RAISE(ABORT, 'LESSON_HANDOFF_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_lesson_handoffs_transition
BEFORE UPDATE ON lesson_handoffs
WHEN NOT (
  (OLD.status = 'pending' AND NEW.status IN ('accepted','cancelled'))
  OR (OLD.status = 'accepted' AND NEW.status IN ('accepted','completed','cancelled'))
  OR (OLD.status = 'completed' AND NEW.status IN ('completed','cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'LESSON_HANDOFF_TRANSITION_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_lesson_handoffs_no_delete
BEFORE DELETE ON lesson_handoffs
BEGIN
  SELECT RAISE(ABORT, 'LESSON_HANDOFF_NO_DELETE');
END;
CREATE TRIGGER IF NOT EXISTS trg_lesson_handoff_events_no_update
BEFORE UPDATE ON lesson_handoff_events
BEGIN
  SELECT RAISE(ABORT, 'LESSON_HANDOFF_EVENT_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS trg_lesson_handoff_events_no_delete
BEFORE DELETE ON lesson_handoff_events
BEGIN
  SELECT RAISE(ABORT, 'LESSON_HANDOFF_EVENT_IMMUTABLE');
END;
