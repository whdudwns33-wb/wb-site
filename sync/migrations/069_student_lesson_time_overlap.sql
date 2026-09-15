-- 같은 학생에게 같은 시간대의 수업 원장이 둘 생기면 출결·메모 정본이 갈린다.
-- 담당자·과목과 관계없이 활성 정규 수업과 확정·완료 보강을 한 축으로 원자 차단한다.
-- 보강 투영 task는 makeup_cases의 같은 건을 두 번 세지 않도록 정규 수업에서 제외한다.
-- 제목의 [수업] 접두어만 있는 일반 task는 위조 가능하므로 서버 발급 구조화 표식만 신뢰한다.

CREATE VIEW IF NOT EXISTS active_regular_lesson_tasks_v1 AS
WITH normalized_tasks AS (
  SELECT
    app,
    id,
    CASE
      WHEN json_valid(data) AND json_type(data) = 'object' THEN data
      ELSE '{}'
    END AS data
  FROM tasks
  WHERE app = 'task'
), regular_tasks AS (
  SELECT
    app,
    id AS task_id,
    data,
    CAST(json_extract(data, '$.studentId') AS TEXT) AS student_id,
    COALESCE(
      NULLIF(CAST(json_extract(data, '$.start') AS TEXT), ''),
      NULLIF(CAST(json_extract(data, '$.startDate') AS TEXT), ''),
      ''
    ) AS raw_start,
    COALESCE(
      NULLIF(CAST(json_extract(data, '$.end') AS TEXT), ''),
      NULLIF(CAST(json_extract(data, '$.endDate') AS TEXT), ''),
      ''
    ) AS raw_end,
    COALESCE(CAST(json_extract(data, '$.repeat') AS TEXT), '') AS repeat_kind
  FROM normalized_tasks
  WHERE COALESCE(json_extract(data, '$.deleted'), 0) = 0
    AND (
      json_extract(data, '$.taskKind') = 'lesson_instruction'
      OR CAST(COALESCE(json_extract(data, '$.lessonFormVersion'), 0) AS INTEGER) >= 1
      OR CAST(COALESCE(json_extract(data, '$.intakeVersion'), 0) AS INTEGER) >= 1
      OR json_extract(data, '$.intakeSource') = 'teacher_9_field_form'
    )
    AND COALESCE(CAST(json_extract(data, '$.lessonInstanceType') AS TEXT), '') <> 'makeup'
    AND COALESCE(CAST(json_extract(data, '$.makeupCaseId') AS TEXT), '') = ''
    AND length(trim(COALESCE(CAST(json_extract(data, '$.studentId') AS TEXT), ''))) > 0
), checked_windows AS (
  SELECT
    regular_tasks.*,
    CASE WHEN
      (raw_start = '' OR (length(raw_start) = 10 AND strftime('%Y-%m-%d', raw_start) = raw_start))
      AND (raw_end = '' OR (length(raw_end) = 10 AND strftime('%Y-%m-%d', raw_end) = raw_end))
      AND (repeat_kind <> 'once' OR raw_start <> '')
      AND (repeat_kind = 'once' OR raw_start = '' OR raw_end = '' OR raw_start <= raw_end)
    THEN 1 ELSE 0 END AS window_valid
  FROM regular_tasks
), effective_windows AS (
  SELECT
    checked_windows.*,
    CASE
      WHEN window_valid = 1 THEN COALESCE(NULLIF(raw_start, ''), '0001-01-01')
      ELSE '0001-01-01'
    END AS valid_from,
    CASE
      WHEN window_valid = 0 THEN '9999-12-31'
      WHEN repeat_kind = 'once' THEN raw_start
      ELSE COALESCE(NULLIF(raw_end, ''), '9999-12-31')
    END AS valid_to
  FROM checked_windows
)
SELECT
  app,
  task_id,
  student_id,
  data,
  valid_from,
  valid_to,
  CASE WHEN
    window_valid = 1
    AND COALESCE(CAST(json_extract(data, '$.scheduleStatus') AS TEXT), '') <> 'needs_review'
    AND json_type(data, '$.scheduleSlots') = 'array'
    AND COALESCE(json_array_length(data, '$.scheduleSlots'), 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(data, '$.scheduleSlots') AS slot
      WHERE CASE WHEN slot.type <> 'object' THEN 1 ELSE (
        COALESCE(CAST(json_extract(slot.value, '$.status') AS TEXT), '') = 'needs_review'
        OR COALESCE(json_type(slot.value, '$.days'), '') <> 'array'
        OR COALESCE(json_array_length(slot.value, '$.days'), 0) = 0
        OR EXISTS (
          SELECT 1 FROM json_each(slot.value, '$.days') AS day
          WHERE day.type <> 'integer' OR CAST(day.value AS INTEGER) NOT BETWEEN 0 AND 6
        )
        OR length(COALESCE(CAST(json_extract(slot.value, '$.startTime') AS TEXT), '')) <> 5
        OR length(COALESCE(CAST(json_extract(slot.value, '$.endTime') AS TEXT), '')) <> 5
        OR COALESCE(CAST(json_extract(slot.value, '$.startTime') AS TEXT), '') NOT GLOB '[0-2][0-9]:[0-5][0-9]'
        OR COALESCE(CAST(json_extract(slot.value, '$.endTime') AS TEXT), '') NOT GLOB '[0-2][0-9]:[0-5][0-9]'
        OR CAST(substr(COALESCE(CAST(json_extract(slot.value, '$.startTime') AS TEXT), ''), 1, 2) AS INTEGER) NOT BETWEEN 0 AND 23
        OR CAST(substr(COALESCE(CAST(json_extract(slot.value, '$.endTime') AS TEXT), ''), 1, 2) AS INTEGER) NOT BETWEEN 0 AND 23
        OR COALESCE(CAST(json_extract(slot.value, '$.startTime') AS TEXT), '') >=
           COALESCE(CAST(json_extract(slot.value, '$.endTime') AS TEXT), '')
        OR (
          COALESCE(
            NULLIF(CAST(json_extract(slot.value, '$.validFrom') AS TEXT), ''),
            NULLIF(CAST(json_extract(slot.value, '$.startDate') AS TEXT), ''),
            ''
          ) <> ''
          AND (
            length(COALESCE(
              NULLIF(CAST(json_extract(slot.value, '$.validFrom') AS TEXT), ''),
              NULLIF(CAST(json_extract(slot.value, '$.startDate') AS TEXT), ''),
              ''
            )) <> 10
            OR COALESCE(strftime('%Y-%m-%d', COALESCE(
              NULLIF(CAST(json_extract(slot.value, '$.validFrom') AS TEXT), ''),
              NULLIF(CAST(json_extract(slot.value, '$.startDate') AS TEXT), ''),
              ''
            )), '') <> COALESCE(
              NULLIF(CAST(json_extract(slot.value, '$.validFrom') AS TEXT), ''),
              NULLIF(CAST(json_extract(slot.value, '$.startDate') AS TEXT), ''),
              ''
            )
          )
        )
        OR (
          COALESCE(
            NULLIF(CAST(json_extract(slot.value, '$.validTo') AS TEXT), ''),
            NULLIF(CAST(json_extract(slot.value, '$.endDate') AS TEXT), ''),
            ''
          ) <> ''
          AND (
            length(COALESCE(
              NULLIF(CAST(json_extract(slot.value, '$.validTo') AS TEXT), ''),
              NULLIF(CAST(json_extract(slot.value, '$.endDate') AS TEXT), ''),
              ''
            )) <> 10
            OR COALESCE(strftime('%Y-%m-%d', COALESCE(
              NULLIF(CAST(json_extract(slot.value, '$.validTo') AS TEXT), ''),
              NULLIF(CAST(json_extract(slot.value, '$.endDate') AS TEXT), ''),
              ''
            )), '') <> COALESCE(
              NULLIF(CAST(json_extract(slot.value, '$.validTo') AS TEXT), ''),
              NULLIF(CAST(json_extract(slot.value, '$.endDate') AS TEXT), ''),
              ''
            )
          )
        )
        OR (
          COALESCE(
            NULLIF(CAST(json_extract(slot.value, '$.validFrom') AS TEXT), ''),
            NULLIF(CAST(json_extract(slot.value, '$.startDate') AS TEXT), ''),
            '0001-01-01'
          ) > COALESCE(
            NULLIF(CAST(json_extract(slot.value, '$.validTo') AS TEXT), ''),
            NULLIF(CAST(json_extract(slot.value, '$.endDate') AS TEXT), ''),
            '9999-12-31'
          )
        )
      ) END
    )
  THEN 1 ELSE 0 END AS schedule_confirmed
FROM effective_windows;

CREATE VIEW IF NOT EXISTS active_regular_lesson_slots_v1 AS
SELECT
  task.app AS app,
  task.task_id AS task_id,
  task.student_id AS student_id,
  CAST(slot.key AS INTEGER) AS slot_index,
  CAST(day.value AS INTEGER) AS weekday,
  CAST(json_extract(slot.value, '$.startTime') AS TEXT) AS start_time,
  CAST(json_extract(slot.value, '$.endTime') AS TEXT) AS end_time,
  max(
    task.valid_from,
    COALESCE(
      NULLIF(CAST(json_extract(slot.value, '$.validFrom') AS TEXT), ''),
      NULLIF(CAST(json_extract(slot.value, '$.startDate') AS TEXT), ''),
      task.valid_from
    )
  ) AS valid_from,
  min(
    task.valid_to,
    COALESCE(
      NULLIF(CAST(json_extract(slot.value, '$.validTo') AS TEXT), ''),
      NULLIF(CAST(json_extract(slot.value, '$.endDate') AS TEXT), ''),
      task.valid_to
    )
  ) AS valid_to
FROM active_regular_lesson_tasks_v1 AS task,
     json_each(task.data, '$.scheduleSlots') AS slot,
     json_each(slot.value, '$.days') AS day
WHERE task.schedule_confirmed = 1;

CREATE TRIGGER IF NOT EXISTS trg_regular_lesson_time_insert
AFTER INSERT ON tasks
WHEN NEW.app = 'task'
BEGIN
  -- 미확정·빈·손상 시간표는 같은 학생의 겹치는 운영기간이 있으면 추측하지 않는다.
  SELECT RAISE(ABORT, 'SCHEDULE_UNCONFIRMED')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_tasks_v1 AS incoming
    WHERE incoming.app = NEW.app AND incoming.task_id = NEW.id
      AND (
        (
          incoming.schedule_confirmed = 0
          AND (
            EXISTS (
              SELECT 1 FROM active_regular_lesson_tasks_v1 AS other
              WHERE other.app = incoming.app AND other.task_id <> incoming.task_id
                AND other.student_id = incoming.student_id
                AND incoming.valid_from <= other.valid_to AND other.valid_from <= incoming.valid_to
            )
            OR EXISTS (
              SELECT 1 FROM makeup_cases AS makeup
              WHERE makeup.app = incoming.app AND makeup.student_id = incoming.student_id
                AND makeup.status IN ('confirmed', 'completed')
                AND substr(makeup.confirmed_start_at, 1, 10) BETWEEN incoming.valid_from AND incoming.valid_to
            )
          )
        )
        OR (
          incoming.schedule_confirmed = 1
          AND EXISTS (
            SELECT 1 FROM active_regular_lesson_tasks_v1 AS other
            WHERE other.app = incoming.app AND other.task_id <> incoming.task_id
              AND other.student_id = incoming.student_id AND other.schedule_confirmed = 0
              AND incoming.valid_from <= other.valid_to AND other.valid_from <= incoming.valid_to
          )
        )
      )
  );

  -- 한 task 안의 서로 다른 slot도 같은 학생의 수업 두 건으로 갈라질 수 없게 한다.
  SELECT RAISE(ABORT, 'STUDENT_SCHEDULE_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_slots_v1 AS left_slot
    JOIN active_regular_lesson_slots_v1 AS right_slot
      ON right_slot.app = left_slot.app
     AND right_slot.task_id = left_slot.task_id
     AND right_slot.slot_index > left_slot.slot_index
     AND right_slot.weekday = left_slot.weekday
    WHERE left_slot.app = NEW.app AND left_slot.task_id = NEW.id
      AND left_slot.start_time < right_slot.end_time
      AND right_slot.start_time < left_slot.end_time
      AND date(
        max(left_slot.valid_from, right_slot.valid_from),
        printf(
          '+%d days',
          (left_slot.weekday - CAST(strftime('%w', max(left_slot.valid_from, right_slot.valid_from)) AS INTEGER) + 7) % 7
        )
      ) <= min(left_slot.valid_to, right_slot.valid_to)
  );

  SELECT RAISE(ABORT, 'STUDENT_SCHEDULE_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_slots_v1 AS incoming
    JOIN active_regular_lesson_slots_v1 AS other
      ON other.app = incoming.app
     AND other.task_id <> incoming.task_id
     AND other.student_id = incoming.student_id
     AND other.weekday = incoming.weekday
    WHERE incoming.app = NEW.app AND incoming.task_id = NEW.id
      AND incoming.start_time < other.end_time
      AND other.start_time < incoming.end_time
      AND date(
        max(incoming.valid_from, other.valid_from),
        printf(
          '+%d days',
          (incoming.weekday - CAST(strftime('%w', max(incoming.valid_from, other.valid_from)) AS INTEGER) + 7) % 7
        )
      ) <= min(incoming.valid_to, other.valid_to)
  );

  SELECT RAISE(ABORT, 'STUDENT_MAKEUP_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_slots_v1 AS incoming
    JOIN makeup_cases AS makeup
      ON makeup.app = incoming.app
     AND makeup.student_id = incoming.student_id
     AND makeup.status IN ('confirmed', 'completed')
    WHERE incoming.app = NEW.app AND incoming.task_id = NEW.id
      AND substr(makeup.confirmed_start_at, 1, 10) BETWEEN incoming.valid_from AND incoming.valid_to
      AND CAST(strftime('%w', substr(makeup.confirmed_start_at, 1, 10)) AS INTEGER) = incoming.weekday
      AND incoming.start_time < substr(makeup.confirmed_end_at, 12, 5)
      AND substr(makeup.confirmed_start_at, 12, 5) < incoming.end_time
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_regular_lesson_time_update
AFTER UPDATE OF data ON tasks
WHEN NEW.app = 'task' AND CASE WHEN json_valid(OLD.data) AND json_valid(NEW.data) THEN
  json_extract(OLD.data, '$.studentId') IS NOT json_extract(NEW.data, '$.studentId')
  OR json_extract(OLD.data, '$.deleted') IS NOT json_extract(NEW.data, '$.deleted')
  OR json_extract(OLD.data, '$.start') IS NOT json_extract(NEW.data, '$.start')
  OR json_extract(OLD.data, '$.end') IS NOT json_extract(NEW.data, '$.end')
  OR json_extract(OLD.data, '$.startDate') IS NOT json_extract(NEW.data, '$.startDate')
  OR json_extract(OLD.data, '$.endDate') IS NOT json_extract(NEW.data, '$.endDate')
  OR json_extract(OLD.data, '$.repeat') IS NOT json_extract(NEW.data, '$.repeat')
  OR json_extract(OLD.data, '$.scheduleStatus') IS NOT json_extract(NEW.data, '$.scheduleStatus')
  OR json_extract(OLD.data, '$.scheduleSlots') IS NOT json_extract(NEW.data, '$.scheduleSlots')
  OR json_extract(OLD.data, '$.taskKind') IS NOT json_extract(NEW.data, '$.taskKind')
  OR json_extract(OLD.data, '$.lessonFormVersion') IS NOT json_extract(NEW.data, '$.lessonFormVersion')
  OR json_extract(OLD.data, '$.intakeVersion') IS NOT json_extract(NEW.data, '$.intakeVersion')
  OR json_extract(OLD.data, '$.intakeSource') IS NOT json_extract(NEW.data, '$.intakeSource')
  OR json_extract(OLD.data, '$.lessonInstanceType') IS NOT json_extract(NEW.data, '$.lessonInstanceType')
  OR json_extract(OLD.data, '$.makeupCaseId') IS NOT json_extract(NEW.data, '$.makeupCaseId')
ELSE 1 END
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULE_UNCONFIRMED')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_tasks_v1 AS incoming
    WHERE incoming.app = NEW.app AND incoming.task_id = NEW.id
      AND (
        (
          incoming.schedule_confirmed = 0
          AND (
            EXISTS (
              SELECT 1 FROM active_regular_lesson_tasks_v1 AS other
              WHERE other.app = incoming.app AND other.task_id <> incoming.task_id
                AND other.student_id = incoming.student_id
                AND incoming.valid_from <= other.valid_to AND other.valid_from <= incoming.valid_to
            )
            OR EXISTS (
              SELECT 1 FROM makeup_cases AS makeup
              WHERE makeup.app = incoming.app AND makeup.student_id = incoming.student_id
                AND makeup.status IN ('confirmed', 'completed')
                AND substr(makeup.confirmed_start_at, 1, 10) BETWEEN incoming.valid_from AND incoming.valid_to
            )
          )
        )
        OR (
          incoming.schedule_confirmed = 1
          AND EXISTS (
            SELECT 1 FROM active_regular_lesson_tasks_v1 AS other
            WHERE other.app = incoming.app AND other.task_id <> incoming.task_id
              AND other.student_id = incoming.student_id AND other.schedule_confirmed = 0
              AND incoming.valid_from <= other.valid_to AND other.valid_from <= incoming.valid_to
          )
        )
      )
  );

  SELECT RAISE(ABORT, 'STUDENT_SCHEDULE_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_slots_v1 AS left_slot
    JOIN active_regular_lesson_slots_v1 AS right_slot
      ON right_slot.app = left_slot.app
     AND right_slot.task_id = left_slot.task_id
     AND right_slot.slot_index > left_slot.slot_index
     AND right_slot.weekday = left_slot.weekday
    WHERE left_slot.app = NEW.app AND left_slot.task_id = NEW.id
      AND left_slot.start_time < right_slot.end_time
      AND right_slot.start_time < left_slot.end_time
      AND date(
        max(left_slot.valid_from, right_slot.valid_from),
        printf(
          '+%d days',
          (left_slot.weekday - CAST(strftime('%w', max(left_slot.valid_from, right_slot.valid_from)) AS INTEGER) + 7) % 7
        )
      ) <= min(left_slot.valid_to, right_slot.valid_to)
  );

  SELECT RAISE(ABORT, 'STUDENT_SCHEDULE_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_slots_v1 AS incoming
    JOIN active_regular_lesson_slots_v1 AS other
      ON other.app = incoming.app
     AND other.task_id <> incoming.task_id
     AND other.student_id = incoming.student_id
     AND other.weekday = incoming.weekday
    WHERE incoming.app = NEW.app AND incoming.task_id = NEW.id
      AND incoming.start_time < other.end_time
      AND other.start_time < incoming.end_time
      AND date(
        max(incoming.valid_from, other.valid_from),
        printf(
          '+%d days',
          (incoming.weekday - CAST(strftime('%w', max(incoming.valid_from, other.valid_from)) AS INTEGER) + 7) % 7
        )
      ) <= min(incoming.valid_to, other.valid_to)
  );

  SELECT RAISE(ABORT, 'STUDENT_MAKEUP_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM active_regular_lesson_slots_v1 AS incoming
    JOIN makeup_cases AS makeup
      ON makeup.app = incoming.app
     AND makeup.student_id = incoming.student_id
     AND makeup.status IN ('confirmed', 'completed')
    WHERE incoming.app = NEW.app AND incoming.task_id = NEW.id
      AND substr(makeup.confirmed_start_at, 1, 10) BETWEEN incoming.valid_from AND incoming.valid_to
      AND CAST(strftime('%w', substr(makeup.confirmed_start_at, 1, 10)) AS INTEGER) = incoming.weekday
      AND incoming.start_time < substr(makeup.confirmed_end_at, 12, 5)
      AND substr(makeup.confirmed_start_at, 12, 5) < incoming.end_time
  );
END;

-- 066의 보강↔보강 차단 트리거는 그대로 두고 정규 수업과의 교차 충돌만 별도로 더한다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_regular_time_insert
BEFORE INSERT ON makeup_cases
WHEN NEW.status IN ('confirmed', 'completed')
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULE_UNCONFIRMED')
  WHERE EXISTS (
    SELECT 1 FROM active_regular_lesson_tasks_v1 AS regular
    WHERE regular.app = NEW.app AND regular.student_id = NEW.student_id
      AND regular.schedule_confirmed = 0
      AND substr(NEW.confirmed_start_at, 1, 10) BETWEEN regular.valid_from AND regular.valid_to
  );

  SELECT RAISE(ABORT, 'STUDENT_SCHEDULE_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM active_regular_lesson_slots_v1 AS regular
    WHERE regular.app = NEW.app AND regular.student_id = NEW.student_id
      AND substr(NEW.confirmed_start_at, 1, 10) BETWEEN regular.valid_from AND regular.valid_to
      AND CAST(strftime('%w', substr(NEW.confirmed_start_at, 1, 10)) AS INTEGER) = regular.weekday
      AND substr(NEW.confirmed_start_at, 12, 5) < regular.end_time
      AND regular.start_time < substr(NEW.confirmed_end_at, 12, 5)
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_makeup_regular_time_update
BEFORE UPDATE OF status,confirmed_start_at,confirmed_end_at,confirmed_staff_id,student_id ON makeup_cases
WHEN NEW.status IN ('confirmed', 'completed')
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULE_UNCONFIRMED')
  WHERE EXISTS (
    SELECT 1 FROM active_regular_lesson_tasks_v1 AS regular
    WHERE regular.app = NEW.app AND regular.student_id = NEW.student_id
      AND regular.schedule_confirmed = 0
      AND substr(NEW.confirmed_start_at, 1, 10) BETWEEN regular.valid_from AND regular.valid_to
  );

  SELECT RAISE(ABORT, 'STUDENT_SCHEDULE_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM active_regular_lesson_slots_v1 AS regular
    WHERE regular.app = NEW.app AND regular.student_id = NEW.student_id
      AND substr(NEW.confirmed_start_at, 1, 10) BETWEEN regular.valid_from AND regular.valid_to
      AND CAST(strftime('%w', substr(NEW.confirmed_start_at, 1, 10)) AS INTEGER) = regular.weekday
      AND substr(NEW.confirmed_start_at, 12, 5) < regular.end_time
      AND regular.start_time < substr(NEW.confirmed_end_at, 12, 5)
  );
END;
