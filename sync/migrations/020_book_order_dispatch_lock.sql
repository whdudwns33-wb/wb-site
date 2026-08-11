-- 예약 cron과 수동·직접 발송을 하나의 발송 lease로 직렬화한다.
CREATE TABLE IF NOT EXISTS book_order_dispatch_lock (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  owner       TEXT    NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app)
);
