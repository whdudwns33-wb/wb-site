-- 배송 원장과 분리하여 주문완료 직후에도 아카등록을 기록한다.
CREATE TABLE IF NOT EXISTS book_order_academy (
  app TEXT NOT NULL CHECK(app='task'),
  task_id TEXT NOT NULL,
  item_index INTEGER NOT NULL CHECK(item_index>=0),
  registered_at INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY(app,task_id,item_index)
);
