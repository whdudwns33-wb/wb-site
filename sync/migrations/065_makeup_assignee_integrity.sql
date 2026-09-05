-- 실제 보강 담당자와 생성된 보강 task owner가 다르면 최신 회차 원장 근거로 사용할 수 없다.
-- 기존 064 trigger를 additive migration에서 교체해 이미 배포된 DB에도 fail-closed로 적용한다.

DROP TRIGGER IF EXISTS trg_student_session_ledger_event_source;

CREATE TRIGGER trg_student_session_ledger_event_source
BEFORE INSERT ON student_session_ledger_events
WHEN NEW.check_key <> NEW.lesson_task_id || '|' || NEW.attendance_date
OR NOT EXISTS (
  SELECT 1
  FROM tasks AS task
  WHERE task.app = NEW.app
    AND task.id = NEW.lesson_task_id
    AND json_valid(task.data)
    AND json_type(task.data) = 'object'
    AND json_extract(task.data, '$.id') = NEW.lesson_task_id
    AND json_extract(task.data, '$.studentId') = NEW.student_id
    AND json_extract(task.data, '$.staffId') = task.owner
    AND (
      json_extract(task.data, '$.taskKind') = 'lesson_instruction'
      OR COALESCE(json_extract(task.data, '$.lessonFormVersion'), 0) >= 1
      OR COALESCE(json_extract(task.data, '$.intakeVersion'), 0) >= 1
    )
    AND (
      (
        COALESCE(CAST(json_extract(task.data, '$.lessonInstanceType') AS TEXT), '') <> 'makeup'
        AND COALESCE(CAST(json_extract(task.data, '$.makeupCaseId') AS TEXT), '') = ''
      )
      OR EXISTS (
        SELECT 1
        FROM makeup_cases AS makeup
        WHERE makeup.app = task.app
          AND makeup.case_id = CAST(json_extract(task.data, '$.makeupCaseId') AS TEXT)
          AND task.id = 'makeup_lesson_' || makeup.case_id
          AND makeup.student_id = NEW.student_id
          AND makeup.confirmed_staff_id = task.owner
          AND makeup.status IN ('confirmed','completed')
          AND json_extract(task.data, '$.lessonInstanceType') = 'makeup'
          AND (
            json_extract(makeup.history, '$[0].action') = 'create_from_absence'
            OR (
              json_extract(makeup.history, '$[0].action') = 'create_manual'
              AND json_extract(makeup.history, '$[0].reason') = 'manual_absence'
            )
          )
      )
    )
)
OR (
  NEW.source_kind = 'check'
  AND NOT EXISTS (
    SELECT 1
    FROM tasks AS task
    JOIN checks AS attendance
      ON attendance.app = task.app
      AND attendance.k = NEW.check_key
      AND attendance.owner = task.owner
    WHERE task.app = NEW.app
      AND task.id = NEW.lesson_task_id
      AND json_valid(attendance.data)
      AND json_type(attendance.data) = 'object'
      AND json_extract(attendance.data, '$.taskId') = NEW.lesson_task_id
      AND json_extract(attendance.data, '$.date') = NEW.attendance_date
      AND json_extract(attendance.data, '$.att') = NEW.attendance_status
  )
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_EVENT_SOURCE');
END;

-- 일정 없이 이미 끝난 보강을 관리자가 직접 완료할 때만 과거 회차제 출결 한 건을
-- 만들 수 있도록 서버 전용 증빙을 남긴다. generic /sync에는 이 테이블 쓰기 경로가 없고,
-- check.data의 source 문자열만 흉내 내서는 아래 잠금 예외를 통과할 수 없다.
CREATE TABLE IF NOT EXISTS makeup_direct_completion_attestations (
  app               TEXT    NOT NULL CHECK (app = 'task'),
  case_id           TEXT    NOT NULL CHECK (length(case_id) BETWEEN 1 AND 128),
  case_revision     INTEGER NOT NULL CHECK (case_revision >= 2),
  lesson_task_id    TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 160),
  check_key         TEXT    NOT NULL CHECK (length(check_key) BETWEEN 3 AND 180),
  student_id        TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 160),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  attendance_date   TEXT    NOT NULL CHECK (
    length(attendance_date) = 10 AND strftime('%Y-%m-%d', attendance_date) = attendance_date
  ),
  start_time        TEXT    NOT NULL CHECK (
    length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'
  ),
  end_time          TEXT    NOT NULL CHECK (
    length(end_time) = 5 AND end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time < '24:00'
  ),
  attendance_status TEXT    NOT NULL CHECK (attendance_status IN ('P','L','E')),
  actor_id          TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  provenance        TEXT    NOT NULL CHECK (provenance = 'makeup_direct_completion_v1'),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, case_id),
  UNIQUE (app, check_key),
  FOREIGN KEY (app, case_id) REFERENCES makeup_cases(app, case_id)
);

CREATE INDEX IF NOT EXISTS idx_makeup_direct_completion_attestations_task
ON makeup_direct_completion_attestations(app, lesson_task_id);

CREATE TRIGGER IF NOT EXISTS trg_makeup_direct_completion_attestation_identity
BEFORE INSERT ON makeup_direct_completion_attestations
WHEN NEW.lesson_task_id <> 'makeup_lesson_' || NEW.case_id
OR NEW.check_key <> NEW.lesson_task_id || '|' || NEW.attendance_date
OR NEW.start_time >= NEW.end_time
OR EXISTS (
  SELECT 1 FROM checks AS current WHERE current.app = NEW.app AND current.k = NEW.check_key
)
OR NOT EXISTS (
  SELECT 1
  FROM makeup_cases AS makeup
  JOIN tasks AS task
    ON task.app = makeup.app AND task.id = NEW.lesson_task_id
  WHERE makeup.app = NEW.app
    AND makeup.case_id = NEW.case_id
    AND makeup.student_id = NEW.student_id
    AND makeup.status = 'confirmed'
    AND makeup.revision = NEW.case_revision
    AND makeup.completed_at IS NULL AND makeup.completed_by IS NULL
    AND makeup.confirmed_staff_id = NEW.staff_id
    AND substr(makeup.confirmed_start_at, 1, 10) = NEW.attendance_date
    AND substr(makeup.confirmed_end_at, 1, 10) = NEW.attendance_date
    AND substr(makeup.confirmed_start_at, 12, 5) = NEW.start_time
    AND substr(makeup.confirmed_end_at, 12, 5) = NEW.end_time
    AND makeup.updated_at = NEW.created_at
    AND json_valid(makeup.history) AND json_type(makeup.history) = 'array'
    AND json_array_length(makeup.history) > 0
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].action') = 'schedule_for_completion'
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].actorId') = NEW.actor_id
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].staffId') = NEW.staff_id
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].date') = NEW.attendance_date
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].startTime') = NEW.start_time
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].endTime') = NEW.end_time
    AND task.owner = NEW.staff_id
    AND task.updated_at = NEW.created_at
    AND json_valid(task.data) AND json_type(task.data) = 'object'
    AND json_extract(task.data, '$.id') = NEW.lesson_task_id
    AND json_extract(task.data, '$.staffId') = task.owner
    AND json_extract(task.data, '$.studentId') = NEW.student_id
    AND json_extract(task.data, '$.lessonInstanceType') = 'makeup'
    AND json_extract(task.data, '$.makeupCaseId') = NEW.case_id
    AND json_extract(task.data, '$.start') = NEW.attendance_date
    AND json_extract(task.data, '$.end') = NEW.attendance_date
    AND EXISTS (
      SELECT 1 FROM json_each(task.data, '$.scheduleSlots') AS slot
      WHERE json_extract(slot.value, '$.startTime') = NEW.start_time
        AND json_extract(slot.value, '$.endTime') = NEW.end_time
        AND json_extract(slot.value, '$.validFrom') = NEW.attendance_date
        AND json_extract(slot.value, '$.validTo') = NEW.attendance_date
    )
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_DIRECT_ATTESTATION_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_makeup_direct_completion_attestations_no_update
BEFORE UPDATE ON makeup_direct_completion_attestations
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_DIRECT_ATTESTATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_makeup_direct_completion_attestations_no_delete
BEFORE DELETE ON makeup_direct_completion_attestations
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_DIRECT_ATTESTATION_APPEND_ONLY');
END;

-- 063의 일반 과거 출결 잠금은 그대로 유지하되, 위 증빙과 현재 confirmed case/task/check가
-- 한 치도 다르지 않은 직접완료 INSERT만 예외로 둔다. UPDATE 잠금은 교체하지 않는다.
DROP TRIGGER IF EXISTS trg_session4_check_att_lock_insert;

CREATE TRIGGER trg_session4_check_att_lock_insert
BEFORE INSERT ON checks
WHEN NEW.app = 'task'
  AND json_valid(NEW.data)
  AND instr(NEW.k, '|') > 1
  AND instr(substr(NEW.k, instr(NEW.k, '|') + 1), '|') = 0
  AND strftime('%Y-%m-%d', substr(NEW.k, instr(NEW.k, '|') + 1)) =
    substr(NEW.k, instr(NEW.k, '|') + 1)
  AND (
    substr(NEW.k, instr(NEW.k, '|') + 1) < date('now', '+9 hours')
    OR (
      substr(NEW.k, instr(NEW.k, '|') + 1) = date('now', '+9 hours')
      AND time('now', '+9 hours') >= '23:50:00'
    )
  )
  AND COALESCE(CAST(json_extract(NEW.data, '$.att') AS TEXT), '') <> ''
  AND EXISTS (
    SELECT 1
    FROM tasks AS task, private_rosters AS roster,
      json_each(roster.data, '$.roster.students') AS student
    WHERE task.app = NEW.app
      AND roster.app = NEW.app
      AND json_valid(task.data) AND json_type(task.data) = 'object'
      AND json_valid(roster.data)
      AND task.id = substr(NEW.k, 1, instr(NEW.k, '|') - 1)
      AND json_extract(task.data, '$.id') = task.id
      AND json_extract(task.data, '$.staffId') = task.owner
      AND (
        json_extract(task.data, '$.taskKind') = 'lesson_instruction'
        OR COALESCE(json_extract(task.data, '$.lessonFormVersion'), 0) >= 1
        OR COALESCE(json_extract(task.data, '$.intakeVersion'), 0) >= 1
      )
      AND (
        (
          COALESCE(CAST(json_extract(task.data, '$.lessonInstanceType') AS TEXT), '') <> 'makeup'
          AND COALESCE(CAST(json_extract(task.data, '$.makeupCaseId') AS TEXT), '') = ''
        )
        OR (
          json_extract(task.data, '$.lessonInstanceType') = 'makeup'
          AND task.id = 'makeup_lesson_' || CAST(json_extract(task.data, '$.makeupCaseId') AS TEXT)
          AND json_extract(task.data, '$.start') = substr(NEW.k, instr(NEW.k, '|') + 1)
          AND json_extract(task.data, '$.end') = substr(NEW.k, instr(NEW.k, '|') + 1)
          AND EXISTS (
            SELECT 1 FROM makeup_cases AS makeup
            WHERE makeup.app = task.app
              AND makeup.case_id = json_extract(task.data, '$.makeupCaseId')
              AND makeup.student_id = json_extract(task.data, '$.studentId')
              AND makeup.confirmed_staff_id = task.owner
              AND (
                (
                  makeup.status = 'confirmed'
                  AND substr(makeup.confirmed_start_at, 1, 10) = substr(NEW.k, instr(NEW.k, '|') + 1)
                  AND substr(makeup.confirmed_end_at, 1, 10) = substr(NEW.k, instr(NEW.k, '|') + 1)
                )
                OR (
                  makeup.status = 'completed'
                  AND makeup.completed_at IS NOT NULL AND makeup.completed_by IS NOT NULL
                  AND json_extract(makeup.history,
                    '$[' || (json_array_length(makeup.history) - 1) || '].action') = 'complete'
                )
              )
              AND (
                json_extract(makeup.history, '$[0].action') = 'create_from_absence'
                OR (
                  json_extract(makeup.history, '$[0].action') = 'create_manual'
                  AND json_extract(makeup.history, '$[0].reason') = 'manual_absence'
                )
              )
          )
        )
      )
      AND (
        COALESCE(json_extract(task.data, '$.deleted'), 0) = 0
        OR strftime('%Y-%m-%d', CAST(json_extract(task.data, '$.end') AS TEXT)) =
          CAST(json_extract(task.data, '$.end') AS TEXT)
      )
      AND (
        COALESCE(CAST(json_extract(task.data, '$.start') AS TEXT), '') = ''
        OR substr(NEW.k, instr(NEW.k, '|') + 1) >= CAST(json_extract(task.data, '$.start') AS TEXT)
      )
      AND (
        COALESCE(CAST(json_extract(task.data, '$.end') AS TEXT), '') = ''
        OR substr(NEW.k, instr(NEW.k, '|') + 1) <= CAST(json_extract(task.data, '$.end') AS TEXT)
      )
      AND json_extract(student.value, '$.id') = json_extract(task.data, '$.studentId')
      AND json_extract(student.value, '$.billingMode') = 'session4'
      AND strftime('%Y-%m-%d', CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)) =
        CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)
      AND substr(NEW.k, instr(NEW.k, '|') + 1) >=
        CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM makeup_direct_completion_attestations AS attestation
    JOIN makeup_cases AS makeup
      ON makeup.app = attestation.app AND makeup.case_id = attestation.case_id
    JOIN tasks AS task
      ON task.app = attestation.app AND task.id = attestation.lesson_task_id
    WHERE attestation.app = NEW.app
      AND attestation.check_key = NEW.k
      AND attestation.lesson_task_id = substr(NEW.k, 1, instr(NEW.k, '|') - 1)
      AND attestation.attendance_date = substr(NEW.k, instr(NEW.k, '|') + 1)
      AND attestation.staff_id = NEW.owner
      AND attestation.attendance_status = CAST(json_extract(NEW.data, '$.att') AS TEXT)
      AND attestation.provenance = CAST(json_extract(NEW.data, '$.source') AS TEXT)
      AND attestation.lesson_task_id = CAST(json_extract(NEW.data, '$.taskId') AS TEXT)
      AND attestation.attendance_date = CAST(json_extract(NEW.data, '$.date') AS TEXT)
      AND attestation.created_at = NEW.updated_at
      AND attestation.created_at = NEW.srv_at
      AND attestation.case_revision = makeup.revision
      AND makeup.status = 'confirmed'
      AND makeup.student_id = attestation.student_id
      AND makeup.confirmed_staff_id = attestation.staff_id
      AND makeup.updated_at = attestation.created_at
      AND substr(makeup.confirmed_start_at, 1, 10) = attestation.attendance_date
      AND substr(makeup.confirmed_end_at, 1, 10) = attestation.attendance_date
      AND substr(makeup.confirmed_start_at, 12, 5) = attestation.start_time
      AND substr(makeup.confirmed_end_at, 12, 5) = attestation.end_time
      AND json_extract(makeup.history,
        '$[' || (json_array_length(makeup.history) - 1) || '].action') = 'schedule_for_completion'
      AND json_extract(makeup.history,
        '$[' || (json_array_length(makeup.history) - 1) || '].actorId') = attestation.actor_id
      AND task.owner = attestation.staff_id
      AND task.updated_at = attestation.created_at
      AND json_valid(task.data) AND json_type(task.data) = 'object'
      AND json_extract(task.data, '$.id') = attestation.lesson_task_id
      AND json_extract(task.data, '$.staffId') = task.owner
      AND json_extract(task.data, '$.studentId') = attestation.student_id
      AND json_extract(task.data, '$.lessonInstanceType') = 'makeup'
      AND json_extract(task.data, '$.makeupCaseId') = attestation.case_id
      AND json_extract(task.data, '$.start') = attestation.attendance_date
      AND json_extract(task.data, '$.end') = attestation.attendance_date
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM checks AS current WHERE current.app = NEW.app AND current.k = NEW.k
    )
    OR EXISTS (
      SELECT 1 FROM checks AS current
      WHERE current.app = NEW.app AND current.k = NEW.k
        AND NEW.updated_at > current.updated_at
        AND (
          NOT json_valid(current.data)
          OR CAST(json_extract(current.data, '$.att') AS TEXT)
            IS NOT CAST(json_extract(NEW.data, '$.att') AS TEXT)
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION4_ATTENDANCE_LOCKED');
END;

-- 완료 원장이 가리키는 출결은 서버 정본이다. 완료 직전 generic sync 사전검사와
-- 완료 트랜잭션 사이의 race도 DB가 막도록 핵심 식별자와 출결을 불변화한다.
-- note/steps/source 같은 비출결 필드는 동일한 정본 식별자·출결을 유지하면 계속 수정할 수 있다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_completed_check_identity_lock
BEFORE UPDATE ON checks
WHEN EXISTS (
  SELECT 1
  FROM tasks AS task
  JOIN makeup_cases AS makeup
    ON makeup.app = task.app
   AND makeup.case_id = CAST(json_extract(task.data, '$.makeupCaseId') AS TEXT)
  WHERE OLD.app = 'task'
    AND task.app = OLD.app
    AND task.id = substr(OLD.k, 1, instr(OLD.k, '|') - 1)
    AND OLD.k = task.id || '|' || CAST(json_extract(task.data, '$.start') AS TEXT)
    AND OLD.owner = task.owner
    AND json_valid(OLD.data) AND json_type(OLD.data) = 'object'
    AND CAST(json_extract(OLD.data, '$.taskId') AS TEXT) = task.id
    AND CAST(json_extract(OLD.data, '$.date') AS TEXT) = CAST(json_extract(task.data, '$.start') AS TEXT)
    AND CAST(json_extract(OLD.data, '$.att') AS TEXT) IN ('P','L','E')
    AND json_valid(task.data) AND json_type(task.data) = 'object'
    AND CAST(json_extract(task.data, '$.id') AS TEXT) = task.id
    AND CAST(json_extract(task.data, '$.staffId') AS TEXT) = task.owner
    AND CAST(json_extract(task.data, '$.lessonInstanceType') AS TEXT) = 'makeup'
    AND task.id = 'makeup_lesson_' || CAST(json_extract(task.data, '$.makeupCaseId') AS TEXT)
    AND (
      CAST(json_extract(task.data, '$.taskKind') AS TEXT) = 'lesson_instruction'
      OR COALESCE(CAST(json_extract(task.data, '$.lessonFormVersion') AS INTEGER), 0) >= 1
      OR COALESCE(CAST(json_extract(task.data, '$.intakeVersion') AS INTEGER), 0) >= 1
    )
    AND CAST(json_extract(task.data, '$.repeat') AS TEXT) = 'once'
    AND strftime('%Y-%m-%d', CAST(json_extract(task.data, '$.start') AS TEXT)) =
      CAST(json_extract(task.data, '$.start') AS TEXT)
    AND CAST(json_extract(task.data, '$.end') AS TEXT) = CAST(json_extract(task.data, '$.start') AS TEXT)
    AND makeup.status = 'completed'
    AND makeup.student_id = CAST(json_extract(task.data, '$.studentId') AS TEXT)
    AND makeup.source_task_id = CAST(json_extract(task.data, '$.makeupSourceTaskId') AS TEXT)
    AND makeup.source_date = CAST(json_extract(task.data, '$.makeupSourceDate') AS TEXT)
    AND makeup.confirmed_staff_id = task.owner
    AND substr(makeup.confirmed_start_at, 1, 10) = CAST(json_extract(task.data, '$.start') AS TEXT)
    AND substr(makeup.confirmed_end_at, 1, 10) = CAST(json_extract(task.data, '$.start') AS TEXT)
    AND makeup.completed_at IS NOT NULL
    AND makeup.completed_by = task.owner
    AND json_valid(makeup.history) AND json_type(makeup.history) = 'array'
    AND json_array_length(makeup.history) > 0
    AND json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].action') = 'complete'
    AND CAST(json_extract(makeup.history,
      '$[' || (json_array_length(makeup.history) - 1) || '].revision') AS INTEGER) = makeup.revision
)
AND (
  NEW.app IS NOT OLD.app
  OR NEW.k IS NOT OLD.k
  OR NEW.owner IS NOT OLD.owner
  OR NOT json_valid(NEW.data)
  OR CASE WHEN json_valid(NEW.data)
      THEN CAST(json_extract(NEW.data, '$.taskId') AS TEXT) ELSE NULL END
    IS NOT CASE WHEN json_valid(OLD.data)
      THEN CAST(json_extract(OLD.data, '$.taskId') AS TEXT) ELSE NULL END
  OR CASE WHEN json_valid(NEW.data)
      THEN CAST(json_extract(NEW.data, '$.date') AS TEXT) ELSE NULL END
    IS NOT CASE WHEN json_valid(OLD.data)
      THEN CAST(json_extract(OLD.data, '$.date') AS TEXT) ELSE NULL END
  OR CASE WHEN json_valid(NEW.data)
      THEN CAST(json_extract(NEW.data, '$.att') AS TEXT) ELSE NULL END
    IS NOT CASE WHEN json_valid(OLD.data)
      THEN CAST(json_extract(OLD.data, '$.att') AS TEXT) ELSE NULL END
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_COMPLETED_ATTENDANCE_LOCKED');
END;
