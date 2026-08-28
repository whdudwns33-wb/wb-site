-- 선생님→관리자 실시간 요청과 학생 단위 4회제 수강료 생성 알림 원장.
-- 표시 이름은 저장하지 않고 stable ID로 현재 staff/roster에서 다시 찾는다.

CREATE TABLE IF NOT EXISTS teacher_live_requests (
  app                 TEXT    NOT NULL CHECK (app = 'task'),
  request_id          TEXT    NOT NULL CHECK (
    length(request_id) BETWEEN 8 AND 80
    AND request_id GLOB 'tlr_[A-Za-z0-9_-]*'
    AND substr(request_id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  lesson_task_id      TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 128),
  lesson_date         TEXT    NOT NULL CHECK (
    lesson_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  student_id          TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  sender_staff_id     TEXT    NOT NULL CHECK (length(sender_staff_id) BETWEEN 1 AND 128),
  recipient_admin_id TEXT    NOT NULL CHECK (length(recipient_admin_id) BETWEEN 1 AND 128),
  body                 TEXT    NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at           INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, request_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_live_requests_created
  ON teacher_live_requests(app, created_at DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_teacher_live_requests_student
  ON teacher_live_requests(app, student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS teacher_live_request_receipt_events (
  app              TEXT    NOT NULL CHECK (app = 'task'),
  receipt_event_id TEXT    NOT NULL CHECK (
    length(receipt_event_id) = 57
    AND receipt_event_id GLOB 'tlre_[0-9a-f]*'
    AND substr(receipt_event_id,6) NOT GLOB '*[^0-9a-f]*'
  ),
  request_id       TEXT    NOT NULL CHECK (length(request_id) BETWEEN 8 AND 80),
  admin_id         TEXT    NOT NULL CHECK (length(admin_id) BETWEEN 1 AND 128),
  event_type       TEXT    NOT NULL CHECK (event_type IN ('opened','acknowledged')),
  created_at       INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, receipt_event_id),
  UNIQUE (app, request_id, admin_id, event_type),
  FOREIGN KEY (app, request_id) REFERENCES teacher_live_requests(app, request_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_live_request_receipts_request
  ON teacher_live_request_receipt_events(app, request_id, admin_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_teacher_live_requests_no_update
BEFORE UPDATE ON teacher_live_requests
BEGIN
  SELECT RAISE(ABORT, 'TEACHER_LIVE_REQUEST_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_teacher_live_requests_no_delete
BEFORE DELETE ON teacher_live_requests
BEGIN
  SELECT RAISE(ABORT, 'TEACHER_LIVE_REQUEST_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_teacher_live_request_receipts_no_update
BEFORE UPDATE ON teacher_live_request_receipt_events
BEGIN
  SELECT RAISE(ABORT, 'TEACHER_LIVE_REQUEST_RECEIPT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_teacher_live_request_receipts_no_delete
BEFORE DELETE ON teacher_live_request_receipt_events
BEGIN
  SELECT RAISE(ABORT, 'TEACHER_LIVE_REQUEST_RECEIPT_APPEND_ONLY');
END;

CREATE TABLE IF NOT EXISTS tuition_generation_alerts (
  app               TEXT    NOT NULL CHECK (app = 'task'),
  alert_id          TEXT    NOT NULL CHECK (
    length(alert_id) = 56
    AND alert_id GLOB 'tga_[0-9a-f]*'
    AND substr(alert_id,5) NOT GLOB '*[^0-9a-f]*'
  ),
  student_id        TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  cycle_start_date  TEXT    NOT NULL CHECK (
    cycle_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  threshold_count   INTEGER NOT NULL CHECK (threshold_count = 3),
  trigger_task_id   TEXT    NOT NULL CHECK (length(trigger_task_id) BETWEEN 1 AND 128),
  trigger_date      TEXT    NOT NULL CHECK (
    trigger_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, alert_id),
  UNIQUE (app, student_id, cycle_start_date)
);

CREATE INDEX IF NOT EXISTS idx_tuition_generation_alerts_student
  ON tuition_generation_alerts(app, student_id, cycle_start_date DESC);
CREATE INDEX IF NOT EXISTS idx_tuition_generation_alerts_created
  ON tuition_generation_alerts(app, created_at DESC, alert_id DESC);

CREATE TABLE IF NOT EXISTS tuition_generation_alert_confirmations (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  confirmation_id TEXT    NOT NULL CHECK (
    length(confirmation_id) = 56
    AND confirmation_id GLOB 'tgc_[0-9a-f]*'
    AND substr(confirmation_id,5) NOT GLOB '*[^0-9a-f]*'
  ),
  alert_id        TEXT    NOT NULL CHECK (length(alert_id) = 56),
  confirmed_at    INTEGER NOT NULL CHECK (confirmed_at > 0),
  confirmed_by    TEXT    NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND 160),
  PRIMARY KEY (app, confirmation_id),
  UNIQUE (app, alert_id),
  FOREIGN KEY (app, alert_id) REFERENCES tuition_generation_alerts(app, alert_id)
);

CREATE INDEX IF NOT EXISTS idx_tuition_generation_confirmations_alert
  ON tuition_generation_alert_confirmations(app, alert_id, confirmed_at);

CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_alerts_no_update
BEFORE UPDATE ON tuition_generation_alerts
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_alerts_no_delete
BEFORE DELETE ON tuition_generation_alerts
BEGIN
  SELECT RAISE(ABORT, 'TUITION_ALERT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_confirmations_no_update
BEFORE UPDATE ON tuition_generation_alert_confirmations
BEGIN
  SELECT RAISE(ABORT, 'TUITION_CONFIRMATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_tuition_generation_confirmations_no_delete
BEFORE DELETE ON tuition_generation_alert_confirmations
BEGIN
  SELECT RAISE(ABORT, 'TUITION_CONFIRMATION_APPEND_ONLY');
END;
