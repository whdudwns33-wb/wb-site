-- 이전 날짜에 하원이 누락된 학생도 오늘 등원을 기록할 수 있도록
-- 열린 실제 방문의 유일성 범위를 학생 전체가 아닌 학생·방문일로 제한한다.
-- 같은 날짜의 중복 등원은 계속 차단하고, 날짜가 다른 미하원 기록은 관리자 보정 대상으로 남긴다.
DROP INDEX IF EXISTS idx_weekend_actual_visits_one_open;

CREATE UNIQUE INDEX IF NOT EXISTS idx_weekend_actual_visits_one_open
  ON weekend_actual_visits(app, student_id, visit_date)
  WHERE status = 'active';
