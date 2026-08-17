-- 기존 scope_version=1 열은 구 Worker 호환을 위해 그대로 두고 실제 동의 범위를 별도 봉인한다.
-- 새 Worker는 아래 열·trigger가 모두 준비되지 않으면 503으로 닫힌다.
ALTER TABLE student_portal_access
  ADD COLUMN effective_scope_version INTEGER NOT NULL DEFAULT 1 CHECK (effective_scope_version IN (1,2));
ALTER TABLE student_portal_access
  ADD COLUMN scope_confirmed_at INTEGER CHECK (scope_confirmed_at IS NULL OR scope_confirmed_at>0);

ALTER TABLE student_portal_codes
  ADD COLUMN effective_scope_version INTEGER NOT NULL DEFAULT 1 CHECK (effective_scope_version IN (1,2));

ALTER TABLE student_portal_sessions
  ADD COLUMN effective_scope_version INTEGER NOT NULL DEFAULT 1 CHECK (effective_scope_version IN (1,2));

-- 동의 scope가 바뀌면 종전 scope의 코드·세션을 즉시 폐기한다.
DROP TRIGGER IF EXISTS trg_student_portal_access_revoke;
CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_revoke
AFTER UPDATE OF enabled, student_identity_hash, guardian_identity_hash,
  scope_version, effective_scope_version, scope_confirmed_at ON student_portal_access
WHEN NEW.enabled=0
  OR OLD.student_identity_hash IS NOT NEW.student_identity_hash
  OR OLD.guardian_identity_hash IS NOT NEW.guardian_identity_hash
  OR OLD.scope_version IS NOT NEW.scope_version
  OR OLD.effective_scope_version IS NOT NEW.effective_scope_version
  OR OLD.scope_confirmed_at IS NOT NEW.scope_confirmed_at
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

-- 구 Worker가 v2 access를 v1 코드나 세션으로 잘못 봉인하는 것을 DB에서도 막는다.
CREATE TRIGGER IF NOT EXISTS trg_student_portal_code_scope_insert
BEFORE INSERT ON student_portal_codes
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.student_identity_hash=NEW.student_identity_hash
    AND access.guardian_identity_hash=NEW.guardian_identity_hash
    AND access.updated_at=NEW.access_updated_at
    AND access.scope_version=1
    AND access.effective_scope_version=NEW.effective_scope_version
    AND (access.effective_scope_version=1 OR access.scope_confirmed_at=access.updated_at)
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_CODE_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_session_scope_insert
BEFORE INSERT ON student_portal_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.student_identity_hash=NEW.student_identity_hash
    AND access.guardian_identity_hash=NEW.guardian_identity_hash
    AND access.updated_at=NEW.access_updated_at
    AND access.scope_version=1
    AND access.effective_scope_version=NEW.effective_scope_version
    AND (access.effective_scope_version=1 OR access.scope_confirmed_at=access.updated_at)
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_SESSION_SCOPE_MISMATCH');
END;

-- 구 Worker가 이용을 끈 경우에도 다음 재활성화가 v2 동의를 우회하지 못하게 v1로 되돌린다.
CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_disable_scope
AFTER UPDATE OF enabled ON student_portal_access
WHEN NEW.enabled=0 AND NEW.effective_scope_version<>1
BEGIN
  UPDATE student_portal_access SET effective_scope_version=1,scope_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id AND effective_scope_version<>1;
END;

-- 구 Worker의 v1 재저장은 v2 seal을 갱신하지 못하므로 즉시 v1로 닫는다.
CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_scope_mismatch
AFTER UPDATE OF updated_at ON student_portal_access
WHEN NEW.enabled=1 AND NEW.effective_scope_version=2
  AND NEW.scope_confirmed_at IS NOT NEW.updated_at
BEGIN
  UPDATE student_portal_access SET effective_scope_version=1,scope_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id AND effective_scope_version=2;
END;
