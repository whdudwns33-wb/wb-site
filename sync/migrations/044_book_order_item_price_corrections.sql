-- 1회성 교재 금액의 원기록을 보존하면서 승인된 금액 정정을 별도 이력으로 남긴다.
-- 주문 task, 학생 정보, 기존 금액 원장은 변경하지 않는다.
CREATE TABLE IF NOT EXISTS book_order_item_price_corrections (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  task_id              TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 1 AND 128 AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  item_index           INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 49),
  previous_unit_price  INTEGER NOT NULL CHECK (previous_unit_price BETWEEN 1 AND 10000000),
  corrected_unit_price INTEGER NOT NULL CHECK (
    corrected_unit_price BETWEEN 1 AND 10000000 AND corrected_unit_price <> previous_unit_price
  ),
  reason_code          TEXT    NOT NULL CHECK (reason_code = 'director_amount_correction'),
  created_at           INTEGER NOT NULL CHECK (created_at > 0),
  created_by           TEXT    NOT NULL CHECK (
    length(created_by) BETWEEN 1 AND 128 AND created_by NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  PRIMARY KEY (app, task_id, item_index)
);

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_price_corrections_no_update
BEFORE UPDATE ON book_order_item_price_corrections
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_CORRECTION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_price_corrections_no_delete
BEFORE DELETE ON book_order_item_price_corrections
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_CORRECTION_APPEND_ONLY');
END;

-- 운영에서 확인된 김남기 담당·학생배부 완료·최고수준 S 초3-2 한 항목만 16,000원에서 17,000원으로 정정한다.
INSERT OR IGNORE INTO book_order_item_price_corrections(
  app,task_id,item_index,previous_unit_price,corrected_unit_price,reason_code,created_at,created_by
)
SELECT p.app,p.task_id,p.item_index,p.unit_price,17000,'director_amount_correction',
       CAST(strftime('%s','now') AS INTEGER) * 1000,'director'
FROM book_order_item_prices p
JOIN tasks t ON t.app=p.app AND t.id=p.task_id
JOIN json_each(json_extract(t.data,'$.orderItems')) item ON CAST(item.key AS INTEGER)=p.item_index
JOIN book_order_fulfillments f ON f.app=p.app AND f.task_id=p.task_id AND f.item_index=p.item_index
WHERE p.app='task'
  AND p.task_id='7905db2c-0b17-40bd-bbd7-fbb698f19542'
  AND p.item_index=0
  AND p.unit_price=16000
  AND t.owner='84349fea-f2f0-4fc3-b32a-aaef1e466d54'
  AND replace(json_extract(item.value,'$.title'),' ','')='최고수준S초3-2'
  AND f.status IN ('student_handed','academy_registered');
