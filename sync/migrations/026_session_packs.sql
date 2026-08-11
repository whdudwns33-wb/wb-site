-- 지정한 학생·수업에만 여는 회차권. 월제 수업은 행을 만들지 않는다.
-- 금액·결제·연락처·자유 메모는 저장하지 않고 수업 사용 횟수만 관리한다.
CREATE TABLE IF NOT EXISTS session_packs (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  pack_id               TEXT    NOT NULL,
  student_id            TEXT    NOT NULL,
  lesson_task_id        TEXT    NOT NULL,
  task_owner            TEXT    NOT NULL,
  lesson_assignment_key TEXT    NOT NULL CHECK (length(lesson_assignment_key) BETWEEN 1 AND 256),
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  task_identity_hash    TEXT    NOT NULL CHECK (length(task_identity_hash) = 64),
  total_sessions        INTEGER NOT NULL CHECK (total_sessions BETWEEN 1 AND 200),
  valid_from            TEXT    NOT NULL CHECK (
    length(valid_from) = 10 AND strftime('%Y-%m-%d', valid_from) = valid_from
  ),
  expires_on            TEXT    NOT NULL CHECK (
    length(expires_on) = 10 AND strftime('%Y-%m-%d', expires_on) = expires_on
    AND expires_on >= valid_from
  ),
  deduction_policy      TEXT    NOT NULL CHECK (deduction_policy = 'recommended_v1'),
  status                TEXT    NOT NULL CHECK (status IN ('active','closed')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  created_at            INTEGER NOT NULL,
  created_by            TEXT    NOT NULL,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT    NOT NULL,
  closed_at             INTEGER,
  closed_by             TEXT,
  PRIMARY KEY (app, pack_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_packs_one_active
  ON session_packs(app, student_id, lesson_task_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_session_packs_student
  ON session_packs(app, student_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_packs_owner
  ON session_packs(app, task_owner, updated_at);

-- delta는 사용 차감(+), 복원(-), 비차감 기록(0)이다. 잔여 횟수는
-- total_sessions - SUM(delta)로만 계산하며 과거 행을 고치지 않는다.
CREATE TABLE IF NOT EXISTS session_pack_usage (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  entry_id             TEXT    NOT NULL,
  pack_id              TEXT    NOT NULL,
  expected_revision    INTEGER NOT NULL CHECK (expected_revision >= 1),
  source_type          TEXT    NOT NULL CHECK (source_type IN ('regular','makeup','adjustment')),
  source_ref           TEXT    NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  source_date          TEXT    CHECK (
    source_date IS NULL OR (length(source_date) = 10 AND strftime('%Y-%m-%d', source_date) = source_date)
  ),
  attendance_event     TEXT    NOT NULL CHECK (attendance_event IN (
    'present','late','approved_absence','same_day','no_show','academy_cancel',
    'makeup_completed','manual_adjustment'
  )),
  delta                INTEGER NOT NULL CHECK (delta BETWEEN -200 AND 200),
  consumption_group_id TEXT,
  reason_code          TEXT,
  actor_id             TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (app, entry_id),
  UNIQUE (app, source_type, source_ref),
  FOREIGN KEY (app, pack_id) REFERENCES session_packs(app, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_session_pack_usage_pack
  ON session_pack_usage(app, pack_id, created_at);
-- 원 결석과 완료 보강은 같은 그룹에서 양수 차감을 한 번만 가질 수 있다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_pack_usage_one_consumption
  ON session_pack_usage(app, pack_id, consumption_group_id)
  WHERE delta > 0 AND consumption_group_id IS NOT NULL;

-- ledger insert와 pack revision 증가를 같은 SQLite 문장 안에서 처리한다.
CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_guard
BEFORE INSERT ON session_pack_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id AND pack.status = 'active'
  ) THEN RAISE(ABORT, 'SESSION_PACK_NOT_ACTIVE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND pack.revision = NEW.expected_revision
  ) THEN RAISE(ABORT, 'SESSION_PACK_REVISION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM session_packs AS pack
    JOIN tasks AS task
      ON task.app = pack.app AND task.id = pack.lesson_task_id
    JOIN staff AS teacher
      ON teacher.app = pack.app AND teacher.id = pack.task_owner
    JOIN private_rosters AS roster
      ON roster.app = pack.app
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND task.owner = pack.task_owner
      AND json_valid(task.data)
      AND json_type(task.data) = 'object'
      AND json_extract(task.data, '$.id') = pack.lesson_task_id
      AND json_extract(task.data, '$.studentId') = pack.student_id
      AND json_extract(task.data, '$.staffId') = pack.task_owner
      AND COALESCE(json_extract(task.data, '$.deleted'), 0) = 0
      AND (
        json_extract(task.data, '$.taskKind') = 'lesson_instruction'
        OR COALESCE(json_extract(task.data, '$.lessonFormVersion'), 0) <> 0
        OR COALESCE(json_extract(task.data, '$.intakeVersion'), 0) <> 0
      )
      AND CAST(COALESCE(
        NULLIF(json_extract(task.data, '$.lessonAssignmentKey'), ''),
        NULLIF(json_extract(task.data, '$.lessonDedupeKey'), ''),
        json_extract(task.data, '$.id')
      ) AS TEXT) = pack.lesson_assignment_key
      AND json_valid(teacher.data)
      AND json_type(teacher.data) = 'object'
      AND COALESCE(json_extract(teacher.data, '$.deleted'), 0) = 0
      AND json_valid(roster.data)
      AND json_type(roster.data) = 'object'
      AND EXISTS (
        SELECT 1 FROM json_each(roster.data, '$.roster.students') AS student
        WHERE json_type(student.value) = 'object'
          AND json_extract(student.value, '$.id') = pack.student_id
          AND json_extract(student.value, '$.start') <= strftime('%Y-%m', 'now', '+9 hours')
          AND (
            COALESCE(json_extract(student.value, '$.end'), '') = ''
            OR strftime('%Y-%m', 'now', '+9 hours') < json_extract(student.value, '$.end')
          )
          AND json_type(student.value, '$.teacherIds') = 'array'
          AND EXISTS (
            SELECT 1 FROM json_each(student.value, '$.teacherIds') AS assigned
            WHERE CAST(assigned.value AS TEXT) = pack.task_owner
          )
      )
  ) THEN RAISE(ABORT, 'SESSION_PACK_IDENTITY_MISMATCH') END;
  SELECT CASE WHEN NEW.source_type <> 'adjustment' AND NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND NEW.source_date BETWEEN pack.valid_from AND pack.expires_on
  ) THEN RAISE(ABORT, 'SESSION_PACK_DATE_OUT_OF_RANGE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND (SELECT COALESCE(SUM(delta), 0) FROM session_pack_usage
           WHERE app = NEW.app AND pack_id = NEW.pack_id) + NEW.delta
          BETWEEN 0 AND pack.total_sessions
  ) THEN RAISE(ABORT, 'SESSION_PACK_BALANCE_INVALID') END;
END;

-- 보강 완료 UPDATE 바로 다음 문장만 makeup 사용 원장을 쓸 수 있다. D1 batch에서
-- 첫 CAS가 0건이면 changes()가 0이므로 두 번째 문장이 실패하고 전체 batch가 롤백된다.
CREATE TRIGGER IF NOT EXISTS trg_session_pack_makeup_usage_guard
BEFORE INSERT ON session_pack_usage
WHEN NEW.source_type = 'makeup' AND NEW.reason_code = 'makeup_atomic_v1'
BEGIN
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'MAKEUP_REVISION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM makeup_cases AS item
    WHERE item.app = NEW.app AND item.case_id = NEW.source_ref
      AND item.status = 'completed'
      AND item.consumption_group_id = NEW.consumption_group_id
      AND item.completed_by = NEW.actor_id
  ) THEN RAISE(ABORT, 'MAKEUP_USAGE_EVIDENCE_INVALID') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_revision
AFTER INSERT ON session_pack_usage
BEGIN
  UPDATE session_packs
  SET revision = revision + 1, updated_at = NEW.created_at, updated_by = NEW.actor_id
  WHERE app = NEW.app AND pack_id = NEW.pack_id AND revision = NEW.expected_revision;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_no_update
BEFORE UPDATE ON session_pack_usage
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_no_delete
BEFORE DELETE ON session_pack_usage
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_immutable
BEFORE UPDATE ON session_packs
WHEN NEW.app IS NOT OLD.app
  OR NEW.pack_id IS NOT OLD.pack_id
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.lesson_task_id IS NOT OLD.lesson_task_id
  OR NEW.task_owner IS NOT OLD.task_owner
  OR NEW.lesson_assignment_key IS NOT OLD.lesson_assignment_key
  OR NEW.student_identity_hash IS NOT OLD.student_identity_hash
  OR NEW.task_identity_hash IS NOT OLD.task_identity_hash
  OR NEW.total_sessions IS NOT OLD.total_sessions
  OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.expires_on IS NOT OLD.expires_on
  OR NEW.deduction_policy IS NOT OLD.deduction_policy
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_transition
BEFORE UPDATE ON session_packs
WHEN NEW.revision <> OLD.revision + 1
  OR NEW.updated_at < OLD.updated_at
  OR NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'active' AND NEW.status = 'closed')
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_INVALID_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_no_delete
BEFORE DELETE ON session_packs
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_APPEND_ONLY');
END;
