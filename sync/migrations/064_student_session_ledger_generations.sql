-- 회차 원장 정정은 기존 063 원장을 수정하지 않고 새 세대를 append-only로 쌓는다.
-- 이름·연락처는 저장하지 않으며 stable studentId와 출결 근거만 보존한다.

CREATE TABLE IF NOT EXISTS student_session_ledger_generations (
  app                      TEXT    NOT NULL CHECK (app = 'task'),
  student_id               TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 160),
  configured_start_date    TEXT    NOT NULL CHECK (
    length(configured_start_date) = 10
    AND strftime('%Y-%m-%d', configured_start_date) = configured_start_date
  ),
  generation               INTEGER NOT NULL CHECK (generation >= 1),
  source_cutoff_date       TEXT    NOT NULL CHECK (
    length(source_cutoff_date) = 10
    AND strftime('%Y-%m-%d', source_cutoff_date) = source_cutoff_date
  ),
  kind                     TEXT    NOT NULL CHECK (kind IN ('system_backfill','admin_reconciliation')),
  supersedes_generation    INTEGER,
  supersedes_event_count   INTEGER NOT NULL CHECK (supersedes_event_count >= 0),
  reason_code              TEXT    NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  actor                    TEXT    NOT NULL CHECK (length(actor) BETWEEN 1 AND 160),
  created_at               INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, student_id, configured_start_date, generation),
  FOREIGN KEY (app, student_id, configured_start_date, supersedes_generation)
    REFERENCES student_session_ledger_generations(
      app, student_id, configured_start_date, generation
    ),
  CHECK (
    (generation = 1 AND supersedes_generation IS NULL AND supersedes_event_count = 0)
    OR
    (generation > 1 AND supersedes_generation IS NOT NULL
      AND supersedes_generation = generation - 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_student_session_ledger_generations_latest
  ON student_session_ledger_generations(
    app, student_id, configured_start_date, generation DESC
  );

CREATE TABLE IF NOT EXISTS student_session_ledger_cycles (
  app                      TEXT    NOT NULL CHECK (app = 'task'),
  student_id               TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 160),
  configured_start_date    TEXT    NOT NULL CHECK (
    length(configured_start_date) = 10
    AND strftime('%Y-%m-%d', configured_start_date) = configured_start_date
  ),
  generation               INTEGER NOT NULL CHECK (generation >= 1),
  cycle_number             INTEGER NOT NULL CHECK (cycle_number >= 1),
  cycle_start_date         TEXT    NOT NULL CHECK (
    length(cycle_start_date) = 10
    AND strftime('%Y-%m-%d', cycle_start_date) = cycle_start_date
  ),
  created_at               INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (
    app, student_id, configured_start_date, generation, cycle_number
  ),
  FOREIGN KEY (app, student_id, configured_start_date, generation)
    REFERENCES student_session_ledger_generations(
      app, student_id, configured_start_date, generation
    )
);

CREATE INDEX IF NOT EXISTS idx_student_session_ledger_cycles_latest
  ON student_session_ledger_cycles(
    app, student_id, configured_start_date, generation DESC, cycle_number DESC
  );

CREATE TABLE IF NOT EXISTS student_session_ledger_events (
  app                      TEXT    NOT NULL CHECK (app = 'task'),
  student_id               TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 160),
  configured_start_date    TEXT    NOT NULL CHECK (
    length(configured_start_date) = 10
    AND strftime('%Y-%m-%d', configured_start_date) = configured_start_date
  ),
  generation               INTEGER NOT NULL CHECK (generation >= 1),
  cycle_number             INTEGER NOT NULL CHECK (cycle_number >= 1),
  session_number           INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 4),
  lesson_task_id           TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 160),
  attendance_date          TEXT    NOT NULL CHECK (
    length(attendance_date) = 10
    AND strftime('%Y-%m-%d', attendance_date) = attendance_date
  ),
  attendance_status        TEXT    NOT NULL CHECK (attendance_status IN ('P','L','E')),
  source_kind              TEXT    NOT NULL CHECK (source_kind IN ('check','admin_attested')),
  check_key                TEXT    NOT NULL CHECK (length(check_key) BETWEEN 3 AND 180),
  created_at               INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (
    app, student_id, configured_start_date, generation, cycle_number, session_number
  ),
  UNIQUE (
    app, student_id, configured_start_date, generation, lesson_task_id, attendance_date
  ),
  FOREIGN KEY (
    app, student_id, configured_start_date, generation, cycle_number
  ) REFERENCES student_session_ledger_cycles(
    app, student_id, configured_start_date, generation, cycle_number
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_session_ledger_events_source
  ON student_session_ledger_events(
    app, student_id, configured_start_date, generation, check_key
  );

CREATE INDEX IF NOT EXISTS idx_student_session_ledger_events_cycle
  ON student_session_ledger_events(
    app, student_id, configured_start_date, generation DESC, cycle_number, session_number
  );

-- 063의 모든 정본을 세대 1로 복사한다. WHERE NOT EXISTS 덕분에 이후 세대가 생긴 뒤
-- 이 파일을 다시 실행해도 superseded 세대에 INSERT trigger가 발동하지 않는다.
INSERT INTO student_session_ledger_generations(
  app, student_id, configured_start_date, generation, source_cutoff_date, kind,
  supersedes_generation, supersedes_event_count, reason_code, actor, created_at
)
SELECT cycle.app,
  cycle.student_id,
  cycle.configured_start_date,
  1,
  CASE
    WHEN MAX(event.attendance_date) IS NOT NULL
      AND MAX(event.attendance_date) > cycle.configured_start_date
      THEN MAX(event.attendance_date)
    ELSE cycle.configured_start_date
  END,
  'system_backfill',
  NULL,
  0,
  'legacy_063_migration',
  'system:migration:064',
  MIN(cycle.created_at)
FROM student_session_cycles AS cycle
LEFT JOIN student_session_attendance_events AS event
  ON event.app = cycle.app
  AND event.student_id = cycle.student_id
  AND event.configured_start_date = cycle.configured_start_date
WHERE NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_generations AS existing
  WHERE existing.app = cycle.app
    AND existing.student_id = cycle.student_id
    AND existing.configured_start_date = cycle.configured_start_date
    AND existing.generation = 1
)
GROUP BY cycle.app, cycle.student_id, cycle.configured_start_date;

INSERT INTO student_session_ledger_cycles(
  app, student_id, configured_start_date, generation,
  cycle_number, cycle_start_date, created_at
)
SELECT legacy.app,
  legacy.student_id,
  legacy.configured_start_date,
  1,
  legacy.cycle_number,
  legacy.cycle_start_date,
  legacy.created_at
FROM student_session_cycles AS legacy
WHERE NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_cycles AS existing
  WHERE existing.app = legacy.app
    AND existing.student_id = legacy.student_id
    AND existing.configured_start_date = legacy.configured_start_date
    AND existing.generation = 1
    AND existing.cycle_number = legacy.cycle_number
)
AND NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_generations AS newer
  WHERE newer.app = legacy.app
    AND newer.student_id = legacy.student_id
    AND newer.configured_start_date = legacy.configured_start_date
    AND newer.generation > 1
);

INSERT INTO student_session_ledger_events(
  app, student_id, configured_start_date, generation, cycle_number, session_number,
  lesson_task_id, attendance_date, attendance_status, source_kind, check_key, created_at
)
SELECT legacy.app,
  legacy.student_id,
  legacy.configured_start_date,
  1,
  legacy.cycle_number,
  legacy.session_number,
  legacy.lesson_task_id,
  legacy.attendance_date,
  legacy.attendance_status,
  'check',
  legacy.check_key,
  legacy.created_at
FROM student_session_attendance_events AS legacy
WHERE NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_events AS existing
  WHERE existing.app = legacy.app
    AND existing.student_id = legacy.student_id
    AND existing.configured_start_date = legacy.configured_start_date
    AND existing.generation = 1
    AND existing.cycle_number = legacy.cycle_number
    AND existing.session_number = legacy.session_number
)
AND NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_generations AS newer
  WHERE newer.app = legacy.app
    AND newer.student_id = legacy.student_id
    AND newer.configured_start_date = legacy.configured_start_date
    AND newer.generation > 1
);

-- 세대 생성은 바로 직전의 최신 세대와 그 이벤트 수를 정확히 알고 있을 때만 성공한다.
-- append-only 이벤트 수가 CAS 역할을 하므로 동시에 시작된 정정 중 하나만 확정된다.
CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_generation_sequence
BEFORE INSERT ON student_session_ledger_generations
WHEN (
  NEW.generation = 1
  AND EXISTS (
    SELECT 1 FROM student_session_ledger_generations AS existing
    WHERE existing.app = NEW.app
      AND existing.student_id = NEW.student_id
      AND existing.configured_start_date = NEW.configured_start_date
  )
) OR (
  NEW.generation > 1
  AND (
    NOT EXISTS (
      SELECT 1 FROM student_session_ledger_generations AS previous
      WHERE previous.app = NEW.app
        AND previous.student_id = NEW.student_id
        AND previous.configured_start_date = NEW.configured_start_date
    )
    OR NEW.supersedes_generation <> (
      SELECT MAX(previous.generation)
      FROM student_session_ledger_generations AS previous
      WHERE previous.app = NEW.app
        AND previous.student_id = NEW.student_id
        AND previous.configured_start_date = NEW.configured_start_date
    )
    OR NEW.generation <> NEW.supersedes_generation + 1
    OR NEW.supersedes_event_count <> (
      SELECT COUNT(*)
      FROM student_session_ledger_events AS previous_event
      WHERE previous_event.app = NEW.app
        AND previous_event.student_id = NEW.student_id
        AND previous_event.configured_start_date = NEW.configured_start_date
        AND previous_event.generation = NEW.supersedes_generation
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_GENERATION_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_cycle_current
BEFORE INSERT ON student_session_ledger_cycles
WHEN NEW.generation <> COALESCE((
  SELECT MAX(current.generation)
  FROM student_session_ledger_generations AS current
  WHERE current.app = NEW.app
    AND current.student_id = NEW.student_id
    AND current.configured_start_date = NEW.configured_start_date
), 0)
OR (NEW.cycle_number = 1 AND NEW.cycle_start_date <> NEW.configured_start_date)
OR (
  NEW.cycle_number > 1
  AND NOT EXISTS (
    SELECT 1
    FROM student_session_ledger_cycles AS previous
    JOIN student_session_ledger_events AS final_event
      ON final_event.app = previous.app
      AND final_event.student_id = previous.student_id
      AND final_event.configured_start_date = previous.configured_start_date
      AND final_event.generation = previous.generation
      AND final_event.cycle_number = previous.cycle_number
      AND final_event.session_number = 4
    WHERE previous.app = NEW.app
      AND previous.student_id = NEW.student_id
      AND previous.configured_start_date = NEW.configured_start_date
      AND previous.generation = NEW.generation
      AND previous.cycle_number = NEW.cycle_number - 1
      AND NEW.cycle_start_date >= final_event.attendance_date
      AND 4 = (
        SELECT COUNT(*)
        FROM student_session_ledger_events AS previous_event
        WHERE previous_event.app = previous.app
          AND previous_event.student_id = previous.student_id
          AND previous_event.configured_start_date = previous.configured_start_date
          AND previous_event.generation = previous.generation
          AND previous_event.cycle_number = previous.cycle_number
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_CYCLE_SEQUENCE');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_event_current
BEFORE INSERT ON student_session_ledger_events
WHEN NEW.generation <> COALESCE((
  SELECT MAX(current.generation)
  FROM student_session_ledger_generations AS current
  WHERE current.app = NEW.app
    AND current.student_id = NEW.student_id
    AND current.configured_start_date = NEW.configured_start_date
), 0)
OR NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_generations AS current
  WHERE current.app = NEW.app
    AND current.student_id = NEW.student_id
    AND current.configured_start_date = NEW.configured_start_date
    AND current.generation = NEW.generation
    AND (
      (current.kind = 'system_backfill' AND NEW.source_kind = 'check')
      OR
      (
        current.kind = 'admin_reconciliation'
        AND (
          (NEW.source_kind = 'admin_attested'
            AND NEW.attendance_date <= current.source_cutoff_date)
          OR
          (NEW.source_kind = 'check'
            AND NEW.attendance_date > current.source_cutoff_date)
        )
      )
    )
)
OR NOT EXISTS (
  SELECT 1
  FROM student_session_ledger_cycles AS cycle
  WHERE cycle.app = NEW.app
    AND cycle.student_id = NEW.student_id
    AND cycle.configured_start_date = NEW.configured_start_date
    AND cycle.generation = NEW.generation
    AND cycle.cycle_number = NEW.cycle_number
    AND NEW.attendance_date >= cycle.cycle_start_date
    AND (
      NEW.cycle_number = 1
      OR NEW.session_number <> 1
      OR NEW.attendance_date = cycle.cycle_start_date
    )
)
OR (
  NEW.session_number > 1
  AND NOT EXISTS (
    SELECT 1
    FROM student_session_ledger_events AS previous
    WHERE previous.app = NEW.app
      AND previous.student_id = NEW.student_id
      AND previous.configured_start_date = NEW.configured_start_date
      AND previous.generation = NEW.generation
      AND previous.cycle_number = NEW.cycle_number
      AND previous.session_number = NEW.session_number - 1
      AND NEW.attendance_date >= previous.attendance_date
  )
)
OR NEW.session_number <> 1 + (
  SELECT COUNT(*)
  FROM student_session_ledger_events AS prior
  WHERE prior.app = NEW.app
    AND prior.student_id = NEW.student_id
    AND prior.configured_start_date = NEW.configured_start_date
    AND prior.generation = NEW.generation
    AND prior.cycle_number = NEW.cycle_number
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_EVENT_SEQUENCE');
END;

-- admin_attested도 실제 수업 task의 stable studentId를 반드시 가리킨다. 다만 관리자가
-- 과거 출석을 증빙하여 정정하는 경우 raw check 행이 없어도 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_event_source
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

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_generations_no_update
BEFORE UPDATE ON student_session_ledger_generations
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_GENERATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_generations_no_delete
BEFORE DELETE ON student_session_ledger_generations
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_GENERATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_cycles_no_update
BEFORE UPDATE ON student_session_ledger_cycles
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_CYCLE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_cycles_no_delete
BEFORE DELETE ON student_session_ledger_cycles
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_CYCLE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_events_no_update
BEFORE UPDATE ON student_session_ledger_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_session_ledger_events_no_delete
BEFORE DELETE ON student_session_ledger_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SESSION_LEDGER_EVENT_APPEND_ONLY');
END;

-- admin_attested가 raw check 없이 먼저 만들어져도 이후 stale 태블릿 업로드가 정본을
-- 바꾸지 못한다. 같은 출결 상태의 메모 갱신과 generic LWW stale no-op는 계속 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_session4_generation_event_check_att_lock_insert
BEFORE INSERT ON checks
WHEN NEW.app = 'task'
  AND json_valid(NEW.data)
  AND EXISTS (
    SELECT 1 FROM student_session_ledger_events AS event
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

CREATE TRIGGER IF NOT EXISTS trg_session4_generation_event_check_att_lock_update
BEFORE UPDATE OF data ON checks
WHEN OLD.app = 'task'
  AND json_valid(OLD.data) AND json_valid(NEW.data)
  AND CAST(json_extract(OLD.data, '$.att') AS TEXT)
    IS NOT CAST(json_extract(NEW.data, '$.att') AS TEXT)
  AND EXISTS (
    SELECT 1 FROM student_session_ledger_events AS event
    WHERE event.app = OLD.app AND event.check_key = OLD.k
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION4_ATTENDANCE_LOCKED');
END;

-- 기존 수강료 알림은 지우지 않고, 회차 원장의 각 세대에서 유효한지 별도 상태로 남긴다.
-- 상태가 없는 057 알림은 Worker가 legacy active로 읽어 이전 배포와 호환한다.
CREATE TABLE IF NOT EXISTS tuition_generation_alert_states (
  app                      TEXT    NOT NULL CHECK (app = 'task'),
  alert_id                 TEXT    NOT NULL CHECK (
    length(alert_id) = 56
    AND alert_id GLOB 'tga_[0-9a-f]*'
    AND substr(alert_id,5) NOT GLOB '*[^0-9a-f]*'
  ),
  student_id               TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  configured_start_date    TEXT    NOT NULL CHECK (
    length(configured_start_date) = 10
    AND strftime('%Y-%m-%d', configured_start_date) = configured_start_date
  ),
  ledger_generation        INTEGER NOT NULL CHECK (ledger_generation >= 1),
  state_revision           INTEGER NOT NULL CHECK (state_revision >= 1),
  state_sequence           INTEGER NOT NULL CHECK (state_sequence >= 1),
  cycle_start_date         TEXT    NOT NULL CHECK (
    length(cycle_start_date) = 10
    AND strftime('%Y-%m-%d', cycle_start_date) = cycle_start_date
  ),
  effective_status         TEXT    NOT NULL CHECK (effective_status IN ('active','suppressed')),
  trigger_task_id          TEXT,
  trigger_date             TEXT,
  reason_code              TEXT    NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  actor                    TEXT    NOT NULL CHECK (length(actor) BETWEEN 1 AND 160),
  created_at               INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (
    app, alert_id, configured_start_date, ledger_generation, state_revision
  ),
  UNIQUE (app, alert_id, state_sequence),
  FOREIGN KEY (app, alert_id)
    REFERENCES tuition_generation_alerts(app, alert_id),
  FOREIGN KEY (app, student_id, configured_start_date, ledger_generation)
    REFERENCES student_session_ledger_generations(
      app, student_id, configured_start_date, generation
    ),
  CHECK (
    (
      effective_status = 'active'
      AND trigger_task_id IS NOT NULL
      AND length(trigger_task_id) BETWEEN 1 AND 128
      AND trigger_date IS NOT NULL
      AND length(trigger_date) = 10
      AND strftime('%Y-%m-%d', trigger_date) = trigger_date
    )
    OR
    (
      effective_status = 'suppressed'
      AND trigger_task_id IS NULL
      AND trigger_date IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_tuition_generation_alert_states_latest
  ON tuition_generation_alert_states(
    app, alert_id, configured_start_date,
    ledger_generation DESC, state_revision DESC
  );

CREATE INDEX IF NOT EXISTS idx_tuition_generation_alert_states_global
  ON tuition_generation_alert_states(app, alert_id, state_sequence DESC);

CREATE INDEX IF NOT EXISTS idx_tuition_generation_alert_states_student
  ON tuition_generation_alert_states(
    app, student_id, configured_start_date, ledger_generation DESC,
    effective_status, cycle_start_date, state_revision DESC
  );

-- alert의 원래 학생·회차와 같고 현재 최신 원장 세대에 대한 상태만 추가할 수 있다.
CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_alert_state_identity
BEFORE INSERT ON tuition_generation_alert_states
WHEN NEW.ledger_generation <> COALESCE((
  SELECT MAX(current.generation)
  FROM student_session_ledger_generations AS current
  WHERE current.app = NEW.app
    AND current.student_id = NEW.student_id
    AND current.configured_start_date = NEW.configured_start_date
), 0)
OR NEW.state_revision <> 1 + COALESCE((
  SELECT MAX(existing.state_revision)
  FROM tuition_generation_alert_states AS existing
  WHERE existing.app = NEW.app
    AND existing.alert_id = NEW.alert_id
    AND existing.configured_start_date = NEW.configured_start_date
    AND existing.ledger_generation = NEW.ledger_generation
), 0)
OR NEW.state_sequence <> 1 + COALESCE((
  SELECT MAX(existing.state_sequence)
  FROM tuition_generation_alert_states AS existing
  WHERE existing.app = NEW.app
    AND existing.alert_id = NEW.alert_id
), 0)
OR NOT EXISTS (
  SELECT 1
  FROM tuition_generation_alerts AS alert
  WHERE alert.app = NEW.app
    AND alert.alert_id = NEW.alert_id
    AND alert.student_id = NEW.student_id
    AND alert.cycle_start_date = NEW.cycle_start_date
)
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_STATE_IDENTITY');
END;

-- active는 최신 원장의 정확한 3회차 근거와 일치해야 한다. suppressed는 그 회차가
-- 사라졌거나 아직 3회에 도달하지 않은 정정 세대에서만 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_alert_state_effective
BEFORE INSERT ON tuition_generation_alert_states
WHEN (
  NEW.effective_status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM student_session_ledger_cycles AS cycle
    JOIN student_session_ledger_events AS event
      ON event.app = cycle.app
      AND event.student_id = cycle.student_id
      AND event.configured_start_date = cycle.configured_start_date
      AND event.generation = cycle.generation
      AND event.cycle_number = cycle.cycle_number
    WHERE cycle.app = NEW.app
      AND cycle.student_id = NEW.student_id
      AND cycle.configured_start_date = NEW.configured_start_date
      AND cycle.generation = NEW.ledger_generation
      AND cycle.cycle_start_date = NEW.cycle_start_date
      AND event.session_number = 3
      AND event.lesson_task_id = NEW.trigger_task_id
      AND event.attendance_date = NEW.trigger_date
  )
)
OR (
  NEW.effective_status = 'suppressed'
  AND 3 <= (
    SELECT COUNT(*)
    FROM student_session_ledger_cycles AS cycle
    JOIN student_session_ledger_events AS event
      ON event.app = cycle.app
      AND event.student_id = cycle.student_id
      AND event.configured_start_date = cycle.configured_start_date
      AND event.generation = cycle.generation
      AND event.cycle_number = cycle.cycle_number
    WHERE cycle.app = NEW.app
      AND cycle.student_id = NEW.student_id
      AND cycle.configured_start_date = NEW.configured_start_date
      AND cycle.generation = NEW.ledger_generation
      AND cycle.cycle_start_date = NEW.cycle_start_date
  )
)
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_STATE_EFFECTIVE');
END;

CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_alert_states_no_update
BEFORE UPDATE ON tuition_generation_alert_states
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_STATE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_alert_states_no_delete
BEFORE DELETE ON tuition_generation_alert_states
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_STATE_APPEND_ONLY');
END;

-- 상태 원장이 있는 알림은 모든 configured namespace를 통틀어 가장 최근 상태가 active이고
-- 그 원장의 최신 세대일 때만 확인한다. 상태가 전혀 없는 057 legacy 알림은 그대로 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_confirmation_effective
BEFORE INSERT ON tuition_generation_alert_confirmations
WHEN EXISTS (
  SELECT 1
  FROM tuition_generation_alert_states AS state
  WHERE state.app = NEW.app
    AND state.alert_id = NEW.alert_id
)
AND NOT EXISTS (
  SELECT 1
  FROM (
    SELECT latest.student_id,
      latest.configured_start_date,
      latest.ledger_generation,
      latest.effective_status
    FROM tuition_generation_alert_states AS latest
    WHERE latest.app = NEW.app
      AND latest.alert_id = NEW.alert_id
    ORDER BY latest.state_sequence DESC
    LIMIT 1
  ) AS effective
  WHERE effective.effective_status = 'active'
    AND effective.ledger_generation = (
      SELECT MAX(current.generation)
      FROM student_session_ledger_generations AS current
      WHERE current.app = NEW.app
        AND current.student_id = effective.student_id
        AND current.configured_start_date = effective.configured_start_date
    )
)
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_SUPPRESSED');
END;
