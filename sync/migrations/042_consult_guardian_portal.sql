-- consult 보호자 읽기 전용 리포트 포털.
-- task 보호자 포털과 표·쿠키·app 범위를 완전히 분리한다.
CREATE TABLE IF NOT EXISTS consult_guardian_access (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  identity_revision TEXT    NOT NULL CHECK (
    length(identity_revision) = 64 AND identity_revision NOT GLOB '*[^a-f0-9]*'
  ),
  scope_version     INTEGER NOT NULL CHECK (scope_version >= 1),
  accepted_at       INTEGER CHECK (accepted_at IS NULL OR accepted_at > 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by        TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (enabled = 0 OR accepted_at IS NOT NULL),
  PRIMARY KEY (app, staff_id)
);

CREATE TABLE IF NOT EXISTS consult_guardian_codes (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  code_hash         TEXT    NOT NULL CHECK (length(code_hash) = 71 AND code_hash LIKE 'sha256:%'),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  identity_revision TEXT    NOT NULL CHECK (
    length(identity_revision) = 64 AND identity_revision NOT GLOB '*[^a-f0-9]*'
  ),
  scope_version     INTEGER NOT NULL CHECK (scope_version >= 1),
  access_updated_at INTEGER NOT NULL CHECK (access_updated_at > 0),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  expires_at        INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at       INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  revoked           INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  issued_by         TEXT    NOT NULL CHECK (length(issued_by) BETWEEN 1 AND 128),
  claim_id          TEXT CHECK (claim_id IS NULL OR length(claim_id) = 48),
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_consult_guardian_codes_staff
  ON consult_guardian_codes(app, staff_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS consult_guardian_sessions (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  token_hash        TEXT    NOT NULL CHECK (length(token_hash) = 71 AND token_hash LIKE 'sha256:%'),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  identity_revision TEXT    NOT NULL CHECK (
    length(identity_revision) = 64 AND identity_revision NOT GLOB '*[^a-f0-9]*'
  ),
  scope_version     INTEGER NOT NULL CHECK (scope_version >= 1),
  access_updated_at INTEGER NOT NULL CHECK (access_updated_at > 0),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  expires_at        INTEGER NOT NULL CHECK (expires_at > created_at),
  last_seen_at      INTEGER NOT NULL CHECK (last_seen_at >= created_at),
  revoked           INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_consult_guardian_sessions_staff
  ON consult_guardian_sessions(app, staff_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS consult_guardian_acknowledgements (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  ack_id            TEXT    NOT NULL CHECK (length(ack_id) = 52 AND ack_id LIKE 'cga_%'),
  report_ref        TEXT    NOT NULL CHECK (length(report_ref) = 52 AND report_ref LIKE 'cgr_%'),
  source_report_id  TEXT    NOT NULL CHECK (length(source_report_id) BETWEEN 1 AND 128),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  report_revision   INTEGER NOT NULL CHECK (report_revision >= 1),
  acknowledged_at  INTEGER NOT NULL CHECK (acknowledged_at > 0),
  PRIMARY KEY (app, ack_id),
  UNIQUE (app, staff_id, report_ref, report_revision)
);
CREATE INDEX IF NOT EXISTS idx_consult_guardian_ack_staff
  ON consult_guardian_acknowledgements(app, staff_id, acknowledged_at);

-- 공유 해제나 학생 identity revision 변경은 기존 코드와 쿠키 세션을 즉시 폐기한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_access_revoke
AFTER UPDATE OF enabled, identity_revision, scope_version, updated_at ON consult_guardian_access
WHEN NEW.enabled = 0
  OR OLD.identity_revision IS NOT NEW.identity_revision
  OR OLD.scope_version IS NOT NEW.scope_version
  OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_access_delete
AFTER DELETE ON consult_guardian_access
BEGIN
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app=OLD.app AND staff_id=OLD.staff_id AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app=OLD.app AND staff_id=OLD.staff_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_staff_identity_update
AFTER UPDATE OF id, data ON staff
WHEN NEW.app='consult' AND (
  OLD.id IS NOT NEW.id
  OR json_extract(OLD.data,'$.id') IS NOT json_extract(NEW.data,'$.id')
  OR json_extract(OLD.data,'$.name') IS NOT json_extract(NEW.data,'$.name')
  OR COALESCE(json_extract(OLD.data,'$.deleted'),0) IS NOT COALESCE(json_extract(NEW.data,'$.deleted'),0)
  OR COALESCE(json_extract(OLD.data,'$.owner'),0) IS NOT COALESCE(json_extract(NEW.data,'$.owner'),0)
  OR COALESCE(json_extract(OLD.data,'$.manager'),0) IS NOT COALESCE(json_extract(NEW.data,'$.manager'),0)
)
BEGIN
  -- 이름·활성·역할이 원래 값으로 되돌아가도 과거 동의가 다시 살아나면 안 된다.
  -- 기존 access를 영구 비활성화하고 원장이 새 동의를 받아야만 다시 켤 수 있게 한다.
  UPDATE consult_guardian_access
  SET enabled=0, accepted_at=NULL,
      updated_at=MAX(updated_at+1, CAST(strftime('%s','now') AS INTEGER)*1000),
      updated_by='identity-change'
  WHERE app='consult' AND (staff_id=OLD.id OR staff_id=NEW.id);
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app='consult' AND (staff_id=OLD.id OR staff_id=NEW.id) AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app='consult' AND (staff_id=OLD.id OR staff_id=NEW.id) AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_staff_identity_delete
AFTER DELETE ON staff
WHEN OLD.app='consult'
BEGIN
  UPDATE consult_guardian_access
  SET enabled=0, accepted_at=NULL,
      updated_at=MAX(updated_at+1, CAST(strftime('%s','now') AS INTEGER)*1000),
      updated_by='identity-delete'
  WHERE app='consult' AND staff_id=OLD.id;
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app='consult' AND staff_id=OLD.id AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app='consult' AND staff_id=OLD.id AND revoked=0;
END;

-- 보호자가 확인한 판의 내용은 이후 수정·삭제하지 않고 새 revision으로만 발행한다.
-- 동일 JSON을 다시 동기화하며 srv_at만 갱신하는 멱등 upsert는 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_report_no_update
BEFORE UPDATE ON tasks
WHEN OLD.app='consult'
  AND json_valid(OLD.data)
  AND json_extract(OLD.data,'$.kind')='report_snapshot'
  AND json_extract(OLD.data,'$.origin')='admin'
  AND (
    NEW.app IS NOT OLD.app OR NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner
    OR NEW.data IS NOT OLD.data
  )
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_REPORT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_report_no_delete
BEFORE DELETE ON tasks
WHEN OLD.app='consult'
  AND json_valid(OLD.data)
  AND json_extract(OLD.data,'$.kind')='report_snapshot'
  AND json_extract(OLD.data,'$.origin')='admin'
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_REPORT_IMMUTABLE');
END;

-- 한 학생의 활성 보호자 기기는 최근 3개만 유지한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_session_max_three
AFTER INSERT ON consult_guardian_sessions
BEGIN
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0
    AND expires_at>=NEW.created_at AND token_hash NOT IN (
      SELECT token_hash FROM consult_guardian_sessions
      WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0 AND expires_at>=NEW.created_at
      ORDER BY created_at DESC, token_hash DESC LIMIT 3
    );
END;

-- 보호자가 확인하는 순간에도 해당 발행본이 그 기간의 최신 published revision인지 재검증한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_ack_current_report
BEFORE INSERT ON consult_guardian_acknowledgements
WHEN NOT EXISTS (
  SELECT 1 FROM tasks current
  WHERE current.app='consult' AND current.id=NEW.source_report_id AND current.owner=NEW.staff_id
    AND json_valid(current.data) AND json_extract(current.data,'$.id')=current.id
    AND json_extract(current.data,'$.staffId')=current.owner
    AND json_extract(current.data,'$.kind')='report_snapshot'
    AND json_extract(current.data,'$.origin')='admin'
    AND json_extract(current.data,'$.reportStatus')='published'
    AND CAST(json_extract(current.data,'$.reportRevision') AS INTEGER)=NEW.report_revision
    AND COALESCE(json_extract(current.data,'$.deleted'),0)=0
    AND NOT EXISTS (
      SELECT 1 FROM tasks newer
      WHERE newer.app=current.app AND newer.owner=current.owner AND json_valid(newer.data)
        AND json_extract(newer.data,'$.kind')='report_snapshot'
        AND json_extract(newer.data,'$.origin')='admin'
        AND COALESCE(json_extract(newer.data,'$.deleted'),0)=0
        AND json_extract(newer.data,'$.reportType')=json_extract(current.data,'$.reportType')
        AND json_extract(newer.data,'$.periodKey')=json_extract(current.data,'$.periodKey')
        AND (
          CAST(json_extract(newer.data,'$.reportRevision') AS INTEGER) > NEW.report_revision
          OR (CAST(json_extract(newer.data,'$.reportRevision') AS INTEGER)=NEW.report_revision
            AND (newer.updated_at>current.updated_at
              OR (newer.updated_at=current.updated_at AND newer.id>current.id)))
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_REPORT_STALE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_ack_no_update
BEFORE UPDATE ON consult_guardian_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_ACK_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_ack_no_delete
BEFORE DELETE ON consult_guardian_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_ACK_APPEND_ONLY');
END;
