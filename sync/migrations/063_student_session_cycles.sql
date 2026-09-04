-- 학생 단위 4회제 회차 원장. 이름·연락처는 저장하지 않고 stable studentId만 사용한다.
-- 기존 회차제 학생은 설정된 시작일로 0/4 첫 회차만 안전하게 준비하고,
-- 출석 사용 내역은 Worker가 최종 P/L/E 정본을 검증하여 append-only로 보강한다.

CREATE TABLE IF NOT EXISTS student_session_cycles (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  student_id            TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 160),
  configured_start_date TEXT    NOT NULL CHECK (
    length(configured_start_date) = 10
    AND strftime('%Y-%m-%d', configured_start_date) = configured_start_date
  ),
  cycle_number          INTEGER NOT NULL CHECK (cycle_number >= 1),
  cycle_start_date      TEXT    NOT NULL CHECK (
    length(cycle_start_date) = 10
    AND strftime('%Y-%m-%d', cycle_start_date) = cycle_start_date
  ),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, student_id, configured_start_date, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_student_session_cycles_current
  ON student_session_cycles(app, student_id, configured_start_date, cycle_number DESC);

CREATE TABLE IF NOT EXISTS student_session_attendance_events (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  student_id            TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 160),
  configured_start_date TEXT    NOT NULL CHECK (
    length(configured_start_date) = 10
    AND strftime('%Y-%m-%d', configured_start_date) = configured_start_date
  ),
  cycle_number          INTEGER NOT NULL CHECK (cycle_number >= 1),
  session_number        INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 4),
  lesson_task_id        TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 160),
  attendance_date       TEXT    NOT NULL CHECK (
    length(attendance_date) = 10
    AND strftime('%Y-%m-%d', attendance_date) = attendance_date
  ),
  attendance_status     TEXT    NOT NULL CHECK (attendance_status IN ('P','L','E')),
  check_key             TEXT    NOT NULL CHECK (length(check_key) BETWEEN 3 AND 180),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, student_id, configured_start_date, lesson_task_id, attendance_date),
  UNIQUE (app, student_id, configured_start_date, cycle_number, session_number),
  FOREIGN KEY (app, student_id, configured_start_date, cycle_number)
    REFERENCES student_session_cycles(app, student_id, configured_start_date, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_student_session_attendance_cycle
  ON student_session_attendance_events(
    app, student_id, configured_start_date, cycle_number, session_number
  );

CREATE TRIGGER IF NOT EXISTS trg_student_session_cycle_eligible
BEFORE INSERT ON student_session_cycles
WHEN NOT EXISTS (
  SELECT 1
  FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
  WHERE roster.app = NEW.app
    AND json_valid(roster.data)
    AND json_extract(student.value, '$.id') = NEW.student_id
    AND json_extract(student.value, '$.billingMode') = 'session4'
    AND json_extract(student.value, '$.sessionCycleStartDate') = NEW.configured_start_date
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_NOT_ELIGIBLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_cycle_sequence
BEFORE INSERT ON student_session_cycles
WHEN (
  NEW.cycle_number = 1 AND NEW.cycle_start_date <> NEW.configured_start_date
) OR (
  NEW.cycle_number > 1 AND NOT EXISTS (
    SELECT 1
    FROM student_session_cycles AS previous
    WHERE previous.app = NEW.app
      AND previous.student_id = NEW.student_id
      AND previous.configured_start_date = NEW.configured_start_date
      AND previous.cycle_number = NEW.cycle_number - 1
      AND (
        SELECT COUNT(*)
        FROM student_session_attendance_events AS event
        WHERE event.app = previous.app
          AND event.student_id = previous.student_id
          AND event.configured_start_date = previous.configured_start_date
          AND event.cycle_number = previous.cycle_number
      ) = 4
  )
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_CYCLE_SEQUENCE');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_event_eligible
BEFORE INSERT ON student_session_attendance_events
WHEN NOT EXISTS (
  SELECT 1
  FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
  WHERE roster.app = NEW.app
    AND json_valid(roster.data)
    AND json_extract(student.value, '$.id') = NEW.student_id
    AND json_extract(student.value, '$.billingMode') = 'session4'
    AND json_extract(student.value, '$.sessionCycleStartDate') = NEW.configured_start_date
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_NOT_ELIGIBLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_event_source
BEFORE INSERT ON student_session_attendance_events
WHEN NEW.check_key <> NEW.lesson_task_id || '|' || NEW.attendance_date
  OR NOT EXISTS (
    SELECT 1
    FROM tasks AS task
    JOIN checks AS attendance
      ON attendance.app = task.app AND attendance.k = NEW.check_key
    WHERE task.app = NEW.app
      AND task.id = NEW.lesson_task_id
      AND task.owner = attendance.owner
      AND json_valid(task.data) AND json_type(task.data) = 'object'
      AND json_valid(attendance.data) AND json_type(attendance.data) = 'object'
      AND json_extract(task.data, '$.id') = NEW.lesson_task_id
      AND json_extract(task.data, '$.studentId') = NEW.student_id
      AND json_extract(task.data, '$.staffId') = task.owner
      AND (
        COALESCE(json_extract(task.data, '$.deleted'), 0) = 0
        OR (
          COALESCE(json_extract(task.data, '$.deleted'), 0) = 1
          AND strftime('%Y-%m-%d', CAST(json_extract(task.data, '$.end') AS TEXT)) =
            CAST(json_extract(task.data, '$.end') AS TEXT)
          AND NEW.attendance_date <= CAST(json_extract(task.data, '$.end') AS TEXT)
        )
      )
      AND (
        (
          COALESCE(json_extract(task.data, '$.lessonInstanceType'), '') <> 'makeup'
          AND COALESCE(json_extract(task.data, '$.makeupCaseId'), '') = ''
        ) OR EXISTS (
          SELECT 1 FROM makeup_cases AS makeup
          WHERE makeup.app = task.app
            AND makeup.case_id = json_extract(task.data, '$.makeupCaseId')
            AND task.id = 'makeup_lesson_' || makeup.case_id
            AND makeup.student_id = NEW.student_id
            AND makeup.status IN ('confirmed','completed')
            AND json_extract(task.data, '$.lessonInstanceType') = 'makeup'
            AND json_extract(task.data, '$.start') = NEW.attendance_date
            AND json_extract(task.data, '$.end') = NEW.attendance_date
            AND (
              json_extract(makeup.history, '$[0].action') = 'create_from_absence'
              OR (
                json_extract(makeup.history, '$[0].action') = 'create_manual'
                AND json_extract(makeup.history, '$[0].reason') = 'manual_absence'
              )
            )
        )
      )
      AND json_extract(attendance.data, '$.taskId') = NEW.lesson_task_id
      AND json_extract(attendance.data, '$.date') = NEW.attendance_date
      AND json_extract(attendance.data, '$.att') = NEW.attendance_status
      AND NEW.attendance_status IN ('P','L','E')
  )
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_ATTENDANCE_SOURCE');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_event_sequence
BEFORE INSERT ON student_session_attendance_events
WHEN NOT EXISTS (
  SELECT 1
  FROM student_session_cycles AS cycle
  WHERE cycle.app = NEW.app
    AND cycle.student_id = NEW.student_id
    AND cycle.configured_start_date = NEW.configured_start_date
    AND cycle.cycle_number = NEW.cycle_number
    AND NEW.attendance_date >= cycle.cycle_start_date
    AND (cycle.cycle_number = 1 OR NEW.session_number <> 1 OR NEW.attendance_date = cycle.cycle_start_date)
    AND NEW.session_number = 1 + (
      SELECT COUNT(*)
      FROM student_session_attendance_events AS prior
      WHERE prior.app = cycle.app
        AND prior.student_id = cycle.student_id
        AND prior.configured_start_date = cycle.configured_start_date
        AND prior.cycle_number = cycle.cycle_number
    )
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_EVENT_SEQUENCE');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_cycles_no_update
BEFORE UPDATE ON student_session_cycles
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_CYCLE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_cycles_no_delete
BEFORE DELETE ON student_session_cycles
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_CYCLE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_events_no_update
BEFORE UPDATE ON student_session_attendance_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_events_no_delete
BEFORE DELETE ON student_session_attendance_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_EVENT_APPEND_ONLY');
END;


-- 한 번 회차 원장의 사용 근거가 된 check는 학생의 현재 결제 방식·회차 시작일·보강
-- 상태가 바뀌어도 영구 정본이다. generic LWW의 stale 재전송과 동일 att 메모 수정만 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_session4_event_check_att_lock_insert
BEFORE INSERT ON checks
WHEN NEW.app = 'task'
  AND json_valid(NEW.data)
  AND EXISTS (
    SELECT 1 FROM student_session_attendance_events AS event
    WHERE event.app = NEW.app AND event.check_key = NEW.k
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

CREATE TRIGGER IF NOT EXISTS trg_session4_event_check_att_lock_update
BEFORE UPDATE OF data ON checks
WHEN OLD.app = 'task'
  AND json_valid(OLD.data) AND json_valid(NEW.data)
  AND CAST(json_extract(OLD.data, '$.att') AS TEXT)
    IS NOT CAST(json_extract(NEW.data, '$.att') AS TEXT)
  AND EXISTS (
    SELECT 1 FROM student_session_attendance_events AS event
    WHERE event.app = OLD.app AND event.check_key = OLD.k
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION4_ATTENDANCE_LOCKED');
END;


-- 회차제 출결은 수업일 KST 23:50에 확정된다. generic /sync의 INSERT ... ON CONFLICT도
-- BEFORE INSERT를 먼저 거치므로, 기존 att와 같은 재전송만 통과시키고 신규·변경은 막는다.
CREATE TRIGGER IF NOT EXISTS trg_session4_check_att_lock_insert
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
      AND strftime('%Y-%m-%d', CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)) =
        CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)
      AND substr(OLD.k, instr(OLD.k, '|') + 1) >=
        CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION4_ATTENDANCE_LOCKED');
END;


-- 개인정보를 넣지 않고 현재 roster의 회차제 설정만으로 첫 0/4 회차를 일반 backfill한다.
INSERT OR IGNORE INTO student_session_cycles(
  app, student_id, configured_start_date, cycle_number, cycle_start_date, created_at
)
SELECT roster.app,
  CAST(json_extract(student.value, '$.id') AS TEXT),
  CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT),
  1,
  CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT),
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
WHERE roster.app = 'task'
  AND json_valid(roster.data)
  AND json_extract(student.value, '$.billingMode') = 'session4'
  AND length(CAST(json_extract(student.value, '$.id') AS TEXT)) BETWEEN 1 AND 160
  AND length(CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)) = 10
  AND strftime('%Y-%m-%d', CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT)) =
    CAST(json_extract(student.value, '$.sessionCycleStartDate') AS TEXT);
