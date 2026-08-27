-- 054: 회차 사용 권한은 원생 명단의 legacy teacherIds가 아니라 실제 수업 task의
-- owner와 data.staffId를 정본으로 삼는다. 나머지 수업·학생 정체성 검증은 유지한다.
DROP TRIGGER IF EXISTS trg_session_pack_usage_guard;

CREATE TRIGGER trg_session_pack_usage_guard
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

-- task 담당자 CAS 직후 활성 회차권의 owner/key/hash를 같은 batch에서 이전한다.
-- 민감정보 없는 guard 행은 직전 changes()와 최종 정체성을 증명하는 감사 원장으로 남는다.
CREATE TABLE IF NOT EXISTS session_pack_transfer_guards (
  app                         TEXT    NOT NULL CHECK (app = 'task'),
  transfer_id                 TEXT    NOT NULL,
  lesson_task_id              TEXT    NOT NULL,
  pack_id                     TEXT,
  expected_owner              TEXT    NOT NULL,
  expected_assignment_key     TEXT    NOT NULL,
  expected_task_identity_hash TEXT    NOT NULL CHECK (length(expected_task_identity_hash) = 64),
  expected_revision           INTEGER,
  expected_task_updated_at    INTEGER NOT NULL,
  previous_changes            INTEGER NOT NULL,
  created_at                  INTEGER NOT NULL,
  PRIMARY KEY (app, transfer_id)
);

DROP TRIGGER IF EXISTS trg_session_pack_transfer_guard;
CREATE TRIGGER trg_session_pack_transfer_guard
BEFORE INSERT ON session_pack_transfer_guards
BEGIN
  SELECT CASE WHEN NEW.previous_changes <> 1 AND NEW.pack_id IS NULL
    THEN RAISE(ABORT, 'SESSION_PACK_TRANSFER_TASK_CONFLICT') END;
  SELECT CASE WHEN NEW.previous_changes <> 1 AND NEW.pack_id IS NOT NULL
    THEN RAISE(ABORT, 'SESSION_PACK_TRANSFER_PACK_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks AS task
    WHERE task.app = NEW.app AND task.id = NEW.lesson_task_id
      AND task.owner = NEW.expected_owner AND task.updated_at = NEW.expected_task_updated_at
      AND json_valid(task.data) AND json_type(task.data) = 'object'
      AND json_extract(task.data, '$.id') = NEW.lesson_task_id
      AND json_extract(task.data, '$.staffId') = NEW.expected_owner
      AND COALESCE(json_extract(task.data, '$.deleted'), 0) = 0
      AND CAST(COALESCE(
        NULLIF(json_extract(task.data, '$.lessonAssignmentKey'), ''),
        NULLIF(json_extract(task.data, '$.lessonDedupeKey'), ''),
        json_extract(task.data, '$.id')
      ) AS TEXT) = NEW.expected_assignment_key
  ) THEN RAISE(ABORT, 'SESSION_PACK_TRANSFER_IDENTITY_CONFLICT') END;
  SELECT CASE WHEN NEW.pack_id IS NULL AND EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.lesson_task_id = NEW.lesson_task_id AND pack.status = 'active'
  ) THEN RAISE(ABORT, 'SESSION_PACK_TRANSFER_PACK_CONFLICT') END;
  SELECT CASE WHEN NEW.pack_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM session_packs AS pack
    JOIN tasks AS task ON task.app = pack.app AND task.id = pack.lesson_task_id
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND pack.lesson_task_id = NEW.lesson_task_id AND pack.status = 'active'
      AND pack.task_owner = NEW.expected_owner
      AND pack.lesson_assignment_key = NEW.expected_assignment_key
      AND pack.task_identity_hash = NEW.expected_task_identity_hash
      AND pack.revision = NEW.expected_revision
      AND task.owner = pack.task_owner
      AND json_extract(task.data, '$.studentId') = pack.student_id
  ) THEN RAISE(ABORT, 'SESSION_PACK_TRANSFER_PACK_CONFLICT') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_transfer_guard_no_update
BEFORE UPDATE ON session_pack_transfer_guards
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_TRANSFER_GUARD_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_transfer_guard_no_delete
BEFORE DELETE ON session_pack_transfer_guards
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_TRANSFER_GUARD_APPEND_ONLY');
END;

DROP TRIGGER IF EXISTS trg_session_pack_immutable;
CREATE TRIGGER trg_session_pack_immutable
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
  SELECT CASE WHEN (
    OLD.status = 'active' AND NEW.status = 'active'
    AND NEW.app IS OLD.app AND NEW.pack_id IS OLD.pack_id
    AND NEW.student_id IS OLD.student_id AND NEW.lesson_task_id IS OLD.lesson_task_id
    AND NEW.student_identity_hash IS OLD.student_identity_hash
    AND NEW.total_sessions IS OLD.total_sessions AND NEW.valid_from IS OLD.valid_from
    AND NEW.expires_on IS OLD.expires_on AND NEW.deduction_policy IS OLD.deduction_policy
    AND NEW.created_at IS OLD.created_at AND NEW.created_by IS OLD.created_by
    AND NEW.task_owner IS NOT OLD.task_owner
    AND NEW.lesson_assignment_key IS NOT OLD.lesson_assignment_key
    AND NEW.task_identity_hash IS NOT OLD.task_identity_hash
    AND changes() <> 1
  ) THEN RAISE(ABORT, 'SESSION_PACK_TRANSFER_TASK_CONFLICT') END;
  SELECT CASE WHEN NOT (
    OLD.status = 'active' AND NEW.status = 'active'
    AND NEW.app IS OLD.app
    AND NEW.pack_id IS OLD.pack_id
    AND NEW.student_id IS OLD.student_id
    AND NEW.lesson_task_id IS OLD.lesson_task_id
    AND NEW.student_identity_hash IS OLD.student_identity_hash
    AND NEW.total_sessions IS OLD.total_sessions
    AND NEW.valid_from IS OLD.valid_from
    AND NEW.expires_on IS OLD.expires_on
    AND NEW.deduction_policy IS OLD.deduction_policy
    AND NEW.created_at IS OLD.created_at
    AND NEW.created_by IS OLD.created_by
    AND NEW.task_owner IS NOT OLD.task_owner
    AND NEW.lesson_assignment_key IS NOT OLD.lesson_assignment_key
    AND NEW.task_identity_hash IS NOT OLD.task_identity_hash
    AND changes() = 1
    AND EXISTS (
      SELECT 1
      FROM tasks AS task
      JOIN staff AS teacher ON teacher.app = task.app AND teacher.id = NEW.task_owner
      WHERE task.app = NEW.app AND task.id = NEW.lesson_task_id
        AND task.owner = NEW.task_owner
        AND json_valid(task.data) AND json_type(task.data) = 'object'
        AND json_extract(task.data, '$.id') = NEW.lesson_task_id
        AND json_extract(task.data, '$.studentId') = NEW.student_id
        AND json_extract(task.data, '$.staffId') = NEW.task_owner
        AND CAST(COALESCE(
          NULLIF(json_extract(task.data, '$.lessonAssignmentKey'), ''),
          NULLIF(json_extract(task.data, '$.lessonDedupeKey'), ''),
          json_extract(task.data, '$.id')
        ) AS TEXT) = NEW.lesson_assignment_key
        AND task.updated_at <= NEW.updated_at
        AND json_valid(teacher.data) AND json_type(teacher.data) = 'object'
        AND COALESCE(json_extract(teacher.data, '$.deleted'), 0) = 0
    )
  ) THEN RAISE(ABORT, 'SESSION_PACK_IMMUTABLE') END;
END;
