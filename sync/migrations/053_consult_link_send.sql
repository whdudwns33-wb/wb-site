-- consult 학생 개인 링크 수신 연락처와 알림톡 접수 원장.
-- 전화번호는 동기화 staff JSON과 분리해 D1에만 둔다.
CREATE TABLE IF NOT EXISTS consult_link_contacts (
  app          TEXT NOT NULL CHECK (app = 'consult'),
  staff_id     TEXT NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  student_name TEXT NOT NULL CHECK (length(student_name) BETWEEN 1 AND 40),
  phone        TEXT,
  consent      INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0,1)),
  updated_at   INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by   TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (
    phone IS NULL OR (
      length(phone) IN (10,11)
      AND phone GLOB '01[016789][0-9]*'
      AND phone NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (consent = 0 OR phone IS NOT NULL),
  PRIMARY KEY (app, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_consult_link_contacts_updated
  ON consult_link_contacts(app, updated_at DESC, staff_id);

-- 학생이 삭제되거나 원장·관리자 역할로 바뀌면 번호 원문을 남기지 않는다.
-- 행 자체는 설정 이력과 CAS 기준을 위해 유지한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_link_contacts_clear_inactive
AFTER UPDATE OF data ON staff
WHEN OLD.app = 'consult' AND NEW.app = 'consult'
  AND CASE WHEN json_valid(NEW.data) THEN
    COALESCE(json_extract(NEW.data,'$.deleted'),0) <> 0
    OR COALESCE(json_extract(NEW.data,'$.owner'),0) <> 0
    OR COALESCE(json_extract(NEW.data,'$.manager'),0) <> 0
  ELSE 1 END
BEGIN
  UPDATE consult_link_contacts
  SET phone = NULL,
      consent = 0,
      updated_at = CASE WHEN updated_at >= NEW.srv_at THEN updated_at + 1 ELSE NEW.srv_at END,
      updated_by = 'system'
  WHERE app = 'consult' AND staff_id = NEW.id
    AND (phone IS NOT NULL OR consent <> 0);
END;

CREATE TABLE IF NOT EXISTS consult_link_sends (
  app                   TEXT NOT NULL CHECK (app = 'consult'),
  send_id               TEXT NOT NULL CHECK (
    length(send_id) = 52
    AND send_id GLOB 'cls_[0-9a-f]*'
    AND substr(send_id,5) NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key       TEXT NOT NULL CHECK (
    length(idempotency_key) = 64
    AND idempotency_key NOT GLOB '*[^0-9a-f]*'
  ),
  send_date             TEXT NOT NULL CHECK (
    send_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  staff_id              TEXT NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  contact_revision      INTEGER NOT NULL CHECK (contact_revision > 0),
  template_id           TEXT NOT NULL CHECK (length(template_id) BETWEEN 1 AND 128),
  attempt_no            INTEGER NOT NULL CHECK (attempt_no >= 1),
  status                TEXT NOT NULL CHECK (
    status IN ('dispatching','accepted','rejected','unknown')
  ),
  provider_group_id     TEXT,
  provider_message_id   TEXT,
  provider_status_code  TEXT,
  safe_error_code       TEXT,
  dispatch_started_at   INTEGER NOT NULL CHECK (dispatch_started_at > 0),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (provider_group_id IS NULL AND provider_message_id IS NULL AND provider_status_code IS NULL)
    OR
    (provider_group_id IS NOT NULL AND provider_message_id IS NOT NULL AND provider_status_code IS NOT NULL)
  ),
  CHECK (status <> 'accepted' OR (
    provider_group_id IS NOT NULL AND safe_error_code IS NULL
  )),
  CHECK (status NOT IN ('rejected','unknown') OR safe_error_code IS NOT NULL),
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  UNIQUE (app, send_date, staff_id, attempt_no)
);

-- 같은 학생은 KST 하루 동안 접수 중·접수됨·불명 상태를 하나만 가진다.
-- 명시적으로 rejected가 된 경우에만 다음 attempt를 허용한다.
CREATE UNIQUE INDEX IF NOT EXISTS ux_consult_link_sends_daily_blocker
  ON consult_link_sends(app, send_date, staff_id)
  WHERE status IN ('dispatching','accepted','unknown');

CREATE INDEX IF NOT EXISTS idx_consult_link_sends_daily_status
  ON consult_link_sends(app, send_date, status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_consult_link_sends_update_guard
BEFORE UPDATE ON consult_link_sends
WHEN NEW.app IS NOT OLD.app
  OR NEW.send_id IS NOT OLD.send_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.send_date IS NOT OLD.send_date
  OR NEW.staff_id IS NOT OLD.staff_id
  OR NEW.contact_revision IS NOT OLD.contact_revision
  OR NEW.template_id IS NOT OLD.template_id
  OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.dispatch_started_at IS NOT OLD.dispatch_started_at
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'dispatching'
  OR NEW.status NOT IN ('accepted','rejected','unknown')
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_LINK_SEND_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_link_sends_no_delete
BEFORE DELETE ON consult_link_sends
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_LINK_SEND_APPEND_ONLY');
END;
