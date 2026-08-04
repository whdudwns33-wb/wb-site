-- 원장 본인(TEST-SMS-001)에게만 보내는 오늘 수행 보고 테스트 발송 원장.
-- 전화번호, 문자 본문, 공급자 원본 응답은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS director_report_sends (
  app                    TEXT    NOT NULL CHECK (app = 'task'),
  send_id                TEXT    NOT NULL,
  idempotency_key        TEXT    NOT NULL,
  report_date            TEXT    NOT NULL,
  staff_id               TEXT    NOT NULL,
  recipient_slot         TEXT    NOT NULL CHECK (recipient_slot = 'TEST-SMS-001'),
  total_count            INTEGER NOT NULL CHECK (total_count >= 0),
  done_count             INTEGER NOT NULL CHECK (done_count >= 0),
  doing_count            INTEGER NOT NULL CHECK (doing_count >= 0),
  todo_count             INTEGER NOT NULL CHECK (todo_count >= 0),
  blocked_count          INTEGER NOT NULL CHECK (blocked_count >= 0),
  message_hash           TEXT    NOT NULL CHECK (length(message_hash) = 64),
  status                 TEXT    NOT NULL CHECK (status IN (
    'reserved',
    'dispatching',
    'accepted',
    'rejected',
    'unknown'
  )),
  provider_group_id      TEXT,
  provider_message_id    TEXT,
  provider_status_code   TEXT,
  safe_error_code        TEXT,
  created_at             INTEGER NOT NULL,
  dispatch_started_at    INTEGER,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  CHECK (done_count + doing_count + todo_count + blocked_count = total_count)
);

CREATE INDEX IF NOT EXISTS idx_director_report_sends_staff_day
  ON director_report_sends(app, report_date, staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_director_report_sends_day
  ON director_report_sends(app, report_date, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_director_report_sends_provider_message
  ON director_report_sends(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
