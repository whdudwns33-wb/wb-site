-- consult 문화상품권 교환이 처리 중인 학생은 정산 진입점을 숨길 수 없다.
-- Worker의 선조회와 별도로 D1 트리거가 claim 삽입과 직원 변경 사이의 경합을 막는다.

CREATE TRIGGER IF NOT EXISTS trg_consult_reward_staff_update_guard
BEFORE UPDATE ON staff
WHEN OLD.app = 'consult'
  AND json_valid(NEW.data) = 1
  AND (
    COALESCE(json_extract(NEW.data, '$.deleted'), 0) = 1
    OR COALESCE(json_extract(NEW.data, '$.owner'), 0) = 1
    OR COALESCE(json_extract(NEW.data, '$.manager'), 0) = 1
  )
  AND EXISTS (
    SELECT 1
    FROM checks AS reward_row
    WHERE reward_row.app = 'consult'
      AND reward_row.owner = OLD.id
      AND json_valid(reward_row.data) = 1
      AND json_extract(reward_row.data, '$.kind') = 'consult_reward_redemption'
      AND json_extract(reward_row.data, '$.version') = 1
      AND json_extract(reward_row.data, '$.staffId') = OLD.id
      AND json_extract(reward_row.data, '$.status') = 'processing'
      AND reward_row.k = '__rewardtx__' || OLD.id || '|' || json_extract(reward_row.data, '$.requestId')
  )
BEGIN
  SELECT RAISE(ABORT, 'REWARD_PROCESSING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_reward_staff_delete_guard
BEFORE DELETE ON staff
WHEN OLD.app = 'consult'
  AND EXISTS (
    SELECT 1
    FROM checks AS reward_row
    WHERE reward_row.app = 'consult'
      AND reward_row.owner = OLD.id
      AND json_valid(reward_row.data) = 1
      AND json_extract(reward_row.data, '$.kind') = 'consult_reward_redemption'
      AND json_extract(reward_row.data, '$.version') = 1
      AND json_extract(reward_row.data, '$.staffId') = OLD.id
      AND json_extract(reward_row.data, '$.status') = 'processing'
      AND reward_row.k = '__rewardtx__' || OLD.id || '|' || json_extract(reward_row.data, '$.requestId')
  )
BEGIN
  SELECT RAISE(ABORT, 'REWARD_PROCESSING_LOCK');
END;
