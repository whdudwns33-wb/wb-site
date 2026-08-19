-- 원생 정보·수업 업무지시 변경을 학생 stable ID 기준으로 누적 보관한다.
-- 수업 삭제 이력도 감사 목적으로 남기되 API/UI에서는 절대 노출하지 않는다.
CREATE TABLE IF NOT EXISTS student_change_events (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  event_id           TEXT    NOT NULL CHECK (length(event_id) BETWEEN 8 AND 80 AND event_id LIKE 'sce_%'),
  student_id         TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  task_id            TEXT    CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 160),
  event_type         TEXT    NOT NULL CHECK (event_type IN (
    'student_information',
    'work_instruction',
    'teacher_assignment',
    'withdrawal',
    'leave',
    'information_request',
    'lesson_delete'
  )),
  changed_fields     TEXT    NOT NULL CHECK (json_valid(changed_fields) AND json_type(changed_fields) = 'array'),
  details            TEXT    NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  audience_staff_ids TEXT    NOT NULL CHECK (json_valid(audience_staff_ids) AND json_type(audience_staff_ids) = 'array'),
  effective_date     TEXT    CHECK (effective_date IS NULL OR length(effective_date) = 10),
  requires_ack       INTEGER NOT NULL DEFAULT 0 CHECK (requires_ack IN (0,1)),
  request_key        TEXT,
  request_revision   INTEGER CHECK (request_revision IS NULL OR request_revision >= 1),
  changed_at         INTEGER NOT NULL CHECK (changed_at > 0),
  changed_by         TEXT    NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, event_id),
  UNIQUE (app, request_key, request_revision),
  CHECK ((request_key IS NULL AND request_revision IS NULL) OR
         (request_key IS NOT NULL AND request_revision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_student_change_events_student
  ON student_change_events(app, student_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_student_change_events_task
  ON student_change_events(app, task_id, changed_at);

-- 원장·관리 담당·각 선생님이 서로 독립적으로 변경 내용을 확인한다.
CREATE TABLE IF NOT EXISTS student_change_acknowledgements (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  acknowledgement_id TEXT NOT NULL CHECK (length(acknowledgement_id) BETWEEN 8 AND 80 AND acknowledgement_id LIKE 'sca_%'),
  event_id        TEXT    NOT NULL,
  actor_key       TEXT    NOT NULL CHECK (length(actor_key) BETWEEN 1 AND 160),
  acknowledged_at INTEGER NOT NULL CHECK (acknowledged_at > 0),
  PRIMARY KEY (app, acknowledgement_id),
  UNIQUE (app, event_id, actor_key),
  FOREIGN KEY (app, event_id) REFERENCES student_change_events(app, event_id)
);
CREATE INDEX IF NOT EXISTS idx_student_change_ack_actor
  ON student_change_acknowledgements(app, actor_key, acknowledged_at);

CREATE TRIGGER IF NOT EXISTS trg_student_change_events_no_update
BEFORE UPDATE ON student_change_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_change_events_no_delete
BEFORE DELETE ON student_change_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_change_ack_no_update
BEFORE UPDATE ON student_change_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_ACK_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_change_ack_no_delete
BEFORE DELETE ON student_change_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_ACK_APPEND_ONLY');
END;
