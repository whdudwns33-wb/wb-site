-- 실제 방문일과 원래 수업 카드 날짜를 분리해 보존한다.
-- 기존 기록과 구형 클라이언트 호환을 위해 source_date는 nullable로 추가한다.
ALTER TABLE weekend_actual_visits
  ADD COLUMN source_date TEXT CHECK (
    source_date IS NULL OR source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  );

-- 기존 update guard는 그대로 둔 채 source_date 전용 보호 장치를 추가한다.
-- source_date도 방문 원장의 stable identity에 포함되므로 생성 뒤에는 바꿀 수 없다.
CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visits_source_date_guard
BEFORE UPDATE OF source_date ON weekend_actual_visits
WHEN NEW.source_date IS NOT OLD.source_date
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_IMMUTABLE');
END;
