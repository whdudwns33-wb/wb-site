-- 저녁 일괄 발송에 포함된 원본 주문. 전화번호와 문자 본문은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS book_order_batch_items (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  task_id    TEXT    NOT NULL,
  send_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app, task_id)
);
CREATE INDEX IF NOT EXISTS idx_book_order_batch_items_send
  ON book_order_batch_items(app, send_id);
