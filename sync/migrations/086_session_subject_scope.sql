-- 회차 대상 외 과목은 출결 잠금을 적용하지 않는다. 과목 미지정 기존 설정은 유지한다.
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
      AND (COALESCE(json_extract(student.value, '$.sessionBillingSubject'), '') = ''
        OR json_extract(task.data, '$.subject') = json_extract(student.value, '$.sessionBillingSubject'))
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

DROP TRIGGER IF EXISTS trg_session4_check_att_lock_update;
CREATE TRIGGER IF NOT EXISTS trg_session4_check_att_lock_update
BEFORE UPDATE OF data ON checks
WHEN OLD.app = 'task'
  AND json_valid(OLD.data) AND json_valid(NEW.data)
  AND CAST(json_extract(OLD.data, '$.att') AS TEXT)
    IS NOT CAST(json_extract(NEW.data, '$.att') AS TEXT)
  AND instr(OLD.k, '|') > 1
  AND instr(substr(OLD.k, instr(OLD.k, '|') + 1), '|') = 0
  AND strftime('%Y-%m-%d', substr(OLD.k, instr(OLD.k, '|') + 1)) =
    substr(OLD.k, instr(OLD.k, '|') + 1)
  AND (
    substr(OLD.k, instr(OLD.k, '|') + 1) < date('now', '+9 hours')
    OR (
      substr(OLD.k, instr(OLD.k, '|') + 1) = date('now', '+9 hours')
      AND time('now', '+9 hours') >= '23:50:00'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM tasks AS task, private_rosters AS roster,
      json_each(roster.data, '$.roster.students') AS student
    WHERE task.app = OLD.app
      AND roster.app = OLD.app
      AND json_valid(task.data) AND json_type(task.data) = 'object'
      AND json_valid(roster.data)
      AND task.id = substr(OLD.k, 1, instr(OLD.k, '|') - 1)
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
          AND json_extract(task.data, '$.start') = substr(OLD.k, instr(OLD.k, '|') + 1)
          AND json_extract(task.data, '$.end') = substr(OLD.k, instr(OLD.k, '|') + 1)
          AND EXISTS (
            SELECT 1 FROM makeup_cases AS makeup
            WHERE makeup.app = task.app
              AND makeup.case_id = json_extract(task.data, '$.makeupCaseId')
              AND makeup.student_id = json_extract(task.data, '$.studentId')
              AND makeup.confirmed_staff_id = task.owner
              AND (
                (
                  makeup.status = 'confirmed'
                  AND substr(makeup.confirmed_start_at, 1, 10) = substr(OLD.k, instr(OLD.k, '|') + 1)
                  AND substr(makeup.confirmed_end_at, 1, 10) = substr(OLD.k, instr(OLD.k, '|') + 1)
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
        OR substr(OLD.k, instr(OLD.k, '|') + 1) >= CAST(json_extract(task.data, '$.start') AS TEXT)
      )
      AND (
        COALESCE(CAST(json_extract(task.data, '$.end') AS TEXT), '') = ''
        OR substr(OLD.k, instr(OLD.k, '|') + 1) <= CAST(json_extract(task.data, '$.end') AS TEXT)
      )
      AND json_extract(student.value, '$.id') = json_extract(task.data, '$.studentId')
      AND json_extract(student.value, '$.billingMode') = 'session4'
      AND (COALESCE(json_extract(student.value, '$.sessionBillingSubject'), '') = ''
        OR json_extract(task.data, '$.subject') = json_extract(student.value, '$.sessionBillingSubject'))
      AND strftime('%Y-%m-%d', CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)) =
        CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)
      AND substr(OLD.k, instr(OLD.k, '|') + 1) >=
        CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION4_ATTENDANCE_LOCKED');
END;
