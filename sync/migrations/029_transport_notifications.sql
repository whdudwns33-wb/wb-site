-- 차량 기사 연락·승하차 알림톡. 보호자 번호 정본은 기존 stable studentId 연락처를
-- 그대로 사용하고, 차량 목적 동의는 당시 보호자 identity에 별도로 결합한다.
ALTER TABLE guardian_contacts_by_student
  ADD COLUMN transport_call_allowed INTEGER NOT NULL DEFAULT 0 CHECK (transport_call_allowed IN (0,1));
ALTER TABLE guardian_contacts_by_student
  ADD COLUMN transport_boarded_consent INTEGER NOT NULL DEFAULT 0 CHECK (transport_boarded_consent IN (0,1));
ALTER TABLE guardian_contacts_by_student
  ADD COLUMN transport_dropped_consent INTEGER NOT NULL DEFAULT 0 CHECK (transport_dropped_consent IN (0,1));
ALTER TABLE guardian_contacts_by_student
  ADD COLUMN transport_guardian_identity_hash TEXT CHECK (
    transport_guardian_identity_hash IS NULL OR (
      length(transport_guardian_identity_hash) = 64
      AND transport_guardian_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  );
ALTER TABLE guardian_contacts_by_student
  ADD COLUMN transport_updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guardian_contacts_by_student
  ADD COLUMN transport_updated_by TEXT;

-- 공급자 호출 전 만드는 불변 예약과 append-only 결과. 전화번호·메시지 원문은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS transport_notification_sends (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  send_id         TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL CHECK (length(idempotency_key) = 64),
  event_state     TEXT    NOT NULL CHECK (event_state IN ('boarded','dropped')),
  transport_date  TEXT    NOT NULL CHECK (
    COALESCE(length(transport_date) = 10 AND
      strftime('%Y-%m-%d', transport_date) = transport_date, 0) = 1
  ),
  route_id        TEXT    NOT NULL,
  student_id      TEXT    NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  variables_hash  TEXT    NOT NULL CHECK (length(variables_hash) = 64),
  template_id     TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      TEXT    NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  UNIQUE (app, transport_date, route_id, student_id, event_state, source_revision)
);
CREATE INDEX IF NOT EXISTS idx_transport_notification_sends_day
  ON transport_notification_sends(app, transport_date, route_id, created_at);

-- 결과가 없으면 dispatching으로 간주한다. accepted/unknown 및 결과 미기록은 재발송하지 않는다.
CREATE TABLE IF NOT EXISTS transport_notification_send_events (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  ledger_event_id      TEXT    NOT NULL,
  send_id              TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('accepted','rejected','unknown')),
  provider_group_id    TEXT,
  provider_message_id  TEXT,
  provider_status_code TEXT,
  safe_error_code      TEXT,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (app, ledger_event_id),
  UNIQUE (app, send_id),
  FOREIGN KEY (app, send_id) REFERENCES transport_notification_sends(app, send_id)
);
CREATE INDEX IF NOT EXISTS idx_transport_notification_events_send
  ON transport_notification_send_events(app, send_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_notification_events_provider_message
  ON transport_notification_send_events(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_transport_notification_sends_no_update
BEFORE UPDATE ON transport_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_notification_sends_no_delete
BEFORE DELETE ON transport_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_notification_events_no_update
BEFORE UPDATE ON transport_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_EVENT_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_notification_events_no_delete
BEFORE DELETE ON transport_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_EVENT_LEDGER_APPEND_ONLY');
END;
