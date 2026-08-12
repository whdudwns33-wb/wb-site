-- 개인 링크 선생님이 자기 학생을 배정 요청하고, 원장 승인만 실제 원생 담당자 목록을 바꾼다.
CREATE TABLE IF NOT EXISTS lesson_assignment_requests (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  request_key  TEXT    NOT NULL,
  staff_id     TEXT    NOT NULL,
  student_name TEXT    NOT NULL,
  grade        TEXT    NOT NULL,
  student_id   TEXT,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  status       TEXT    NOT NULL CHECK (status IN ('approval_waiting','approved','rejected','cancelled')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  reviewed_at  INTEGER,
  reviewed_by  TEXT,
  review_note  TEXT,
  PRIMARY KEY (app, request_key)
);
CREATE INDEX IF NOT EXISTS idx_lesson_assignment_requests_staff
  ON lesson_assignment_requests(app, staff_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_lesson_assignment_requests_status
  ON lesson_assignment_requests(app, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_assignment_requests_open
  ON lesson_assignment_requests(app, staff_id, student_name, grade)
  WHERE status='approval_waiting';
