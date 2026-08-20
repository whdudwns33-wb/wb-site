-- 담당 원생 배정 요청에 수업 생성 정보를 함께 보관한다.
ALTER TABLE lesson_assignment_requests ADD COLUMN request_data TEXT;

-- 동명이인은 student_id로 구분하고, 구형 요청만 이름·학년 기준 제약을 유지한다.
DROP INDEX IF EXISTS idx_lesson_assignment_requests_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_assignment_requests_open_student
  ON lesson_assignment_requests(app, staff_id, student_id)
  WHERE status='approval_waiting' AND student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_assignment_requests_open_legacy
  ON lesson_assignment_requests(app, staff_id, student_name, grade)
  WHERE status='approval_waiting' AND student_id IS NULL;
