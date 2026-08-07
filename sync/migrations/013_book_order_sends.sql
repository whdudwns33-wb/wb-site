-- 교재 주문 문자를 거래처(출판사)에 실제로 보낸 이력.
-- 전화번호·문구는 저장하지 않는다 — 어느 거래처에 몇 건 보냈는지와 결과만 남긴다.
CREATE TABLE IF NOT EXISTS book_order_sends (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  send_id              TEXT    NOT NULL,
  idempotency_key      TEXT    NOT NULL,
  task_id              TEXT    NOT NULL,
  vendor_name          TEXT    NOT NULL,
  item_count           INTEGER NOT NULL CHECK (item_count >= 1),
  message_hash         TEXT    NOT NULL CHECK (length(message_hash) = 64),
  status               TEXT    NOT NULL CHECK (status IN (
    'reserved',
    'dispatching',
    'accepted',
    'rejected',
    'unknown'
  )),
  provider_group_id    TEXT,
  provider_message_id  TEXT,
  provider_status_code TEXT,
  safe_error_code      TEXT,
  created_at           INTEGER NOT NULL,
  dispatch_started_at  INTEGER,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_book_order_sends_task
  ON book_order_sends(app, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_book_order_sends_day
  ON book_order_sends(app, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_order_sends_provider_message
  ON book_order_sends(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
