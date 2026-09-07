-- 한 선생님이 동시에 여러 학생의 보강을 진행할 수 있도록 담당자 기준 겹침은 허용한다.
-- 같은 학생의 확정·완료 보강 두 건이 겹치는 경우만 DB에서 원자적으로 차단한다.

CREATE INDEX IF NOT EXISTS idx_makeup_student_time
  ON makeup_cases(app, student_id, confirmed_start_at, confirmed_end_at);

DROP TRIGGER IF EXISTS trg_makeup_confirmed_time_insert;
DROP TRIGGER IF EXISTS trg_makeup_confirmed_time_update;

CREATE TRIGGER trg_makeup_confirmed_time_insert
BEFORE INSERT ON makeup_cases
WHEN NEW.status IN ('confirmed','completed') AND EXISTS (
  SELECT 1 FROM makeup_cases AS other
  WHERE other.app = NEW.app AND other.status IN ('confirmed','completed') AND other.case_id <> NEW.case_id
    AND other.confirmed_start_at < NEW.confirmed_end_at
    AND NEW.confirmed_start_at < other.confirmed_end_at
    AND other.student_id = NEW.student_id
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_TIME_CONFLICT');
END;

CREATE TRIGGER trg_makeup_confirmed_time_update
BEFORE UPDATE OF status,confirmed_start_at,confirmed_end_at,confirmed_staff_id,student_id ON makeup_cases
WHEN NEW.status IN ('confirmed','completed') AND EXISTS (
  SELECT 1 FROM makeup_cases AS other
  WHERE other.app = NEW.app AND other.status IN ('confirmed','completed') AND other.case_id <> NEW.case_id
    AND other.confirmed_start_at < NEW.confirmed_end_at
    AND NEW.confirmed_start_at < other.confirmed_end_at
    AND other.student_id = NEW.student_id
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_TIME_CONFLICT');
END;
