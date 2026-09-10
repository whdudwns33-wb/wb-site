-- 보강 수업 자체가 결석된 뒤 새 일정을 잡을 때의 append-only 감사 원장.
-- 기존 결석 출결은 지우지 않고, 재보강으로 일정이 이동된 정확한 출결 키만
-- 이후 일정 기록 검증에서 제외한다. 학생 이름·연락처는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS makeup_absence_retries (
  app                 TEXT NOT NULL CHECK (app = 'task'),
  case_id             TEXT NOT NULL,
  revision            INTEGER NOT NULL CHECK (revision >= 1),
  lesson_task_id      TEXT NOT NULL,
  check_key           TEXT NOT NULL,
  previous_date       TEXT NOT NULL CHECK (
    length(previous_date) = 10 AND strftime('%Y-%m-%d', previous_date) = previous_date
  ),
  previous_start_time TEXT NOT NULL CHECK (
    length(previous_start_time) = 5 AND previous_start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND previous_start_time < '24:00'
  ),
  previous_end_time   TEXT NOT NULL CHECK (
    length(previous_end_time) = 5 AND previous_end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND previous_end_time < '24:00'
  ),
  previous_staff_id   TEXT NOT NULL,
  attendance_status   TEXT NOT NULL CHECK (attendance_status = 'A'),
  created_at          INTEGER NOT NULL,
  created_by          TEXT NOT NULL,
  PRIMARY KEY (app, case_id, revision),
  UNIQUE (app, case_id, lesson_task_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_makeup_absence_retries_check
  ON makeup_absence_retries(app, lesson_task_id, check_key);
