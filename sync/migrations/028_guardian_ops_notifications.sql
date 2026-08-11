-- 027_parent_portal.sql 다음에 적용한다(보강 제안 발송 전 guardian_portal_access를 확인한다).
-- 보강·회차 운영 알림톡은 기존 "수업 피드백 알림톡" 동의를 절대 재사용하지 않는다.
-- 학생별로 보강/회차 동의를 각각 명시적으로 받아야만 발송할 수 있다.
CREATE TABLE IF NOT EXISTS guardian_ops_notification_consents (
  app                    TEXT    NOT NULL CHECK (app = 'task'),
  student_id             TEXT    NOT NULL,
  scope                  TEXT    NOT NULL CHECK (scope IN ('makeup','session')),
  consent                INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0,1)),
  guardian_identity_hash TEXT    NOT NULL CHECK (
    length(guardian_identity_hash) = 64 AND guardian_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at             INTEGER NOT NULL,
  updated_by             TEXT    NOT NULL,
  PRIMARY KEY (app, student_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_consents_scope
  ON guardian_ops_notification_consents(app, scope, consent, student_id);

-- 한 공급자 호출을 하기 전에 만드는 불변 예약 원장. 전화번호와 문구 원문은 보관하지
-- 않고 해시만 남긴다. 상태 전이는 아래 events 테이블에 새 행으로만 추가한다.
CREATE TABLE IF NOT EXISTS guardian_ops_notification_sends (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  send_id         TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL CHECK (length(idempotency_key) = 64),
  event_type      TEXT    NOT NULL CHECK (event_type IN (
    'makeup_proposal','makeup_confirmed','makeup_cancelled','session_balance'
  )),
  source_id       TEXT    NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  student_id      TEXT    NOT NULL,
  variables_hash  TEXT    NOT NULL CHECK (length(variables_hash) = 64),
  template_id     TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL CHECK (attempt_no >= 1),
  created_at      INTEGER NOT NULL,
  created_by      TEXT    NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  UNIQUE (app, event_type, source_id, source_revision, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_sends_target
  ON guardian_ops_notification_sends(app, event_type, source_id, source_revision, attempt_no);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_sends_day
  ON guardian_ops_notification_sends(app, created_at);

-- accepted/rejected/unknown 결과도 append-only다. 결과 행이 아직 없으면 dispatching으로
-- 간주하여, Worker 중단이나 결과 기록 실패 때도 확인 전 재발송하지 않는다.
CREATE TABLE IF NOT EXISTS guardian_ops_notification_send_events (
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
  FOREIGN KEY (app, send_id) REFERENCES guardian_ops_notification_sends(app, send_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_events_send
  ON guardian_ops_notification_send_events(app, send_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_ops_events_provider_message
  ON guardian_ops_notification_send_events(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_sends_no_update
BEFORE UPDATE ON guardian_ops_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_sends_no_delete
BEFORE DELETE ON guardian_ops_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_events_no_update
BEFORE UPDATE ON guardian_ops_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_EVENT_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_events_no_delete
BEFORE DELETE ON guardian_ops_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_EVENT_LEDGER_APPEND_ONLY');
END;
