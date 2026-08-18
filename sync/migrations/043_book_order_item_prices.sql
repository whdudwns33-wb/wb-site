-- 금액 없이 생성된 기존 주문 항목에 권당 금액을 한 번만 기록하는 보조 원장.
-- 주문 task의 봉인 데이터는 변경하지 않으며 표시명·연락처·학생 정보는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS book_order_item_prices (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  task_id      TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 1 AND 128 AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  item_index   INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 49),
  unit_price   INTEGER NOT NULL CHECK (unit_price BETWEEN 1 AND 10000000),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  created_by   TEXT    NOT NULL CHECK (
    length(created_by) BETWEEN 1 AND 128 AND created_by NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  PRIMARY KEY (app, task_id, item_index)
);

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_prices_no_update
BEFORE UPDATE ON book_order_item_prices
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_prices_no_delete
BEFORE DELETE ON book_order_item_prices
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_APPEND_ONLY');
END;
