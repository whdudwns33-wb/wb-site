-- 보호자 포털 공개 범위를 버전으로 고정한다.
-- 기존 동의는 v1로 남기고, 오늘 출결·수업 진행·차량 상태가 포함된 v2 안내를
-- 다시 확인한 보호자만 새 코드와 세션을 사용할 수 있다.
ALTER TABLE guardian_portal_access
  ADD COLUMN scope_version INTEGER NOT NULL DEFAULT 1 CHECK (scope_version >= 1);

DROP TRIGGER IF EXISTS trg_guardian_portal_access_revoke;
CREATE TRIGGER trg_guardian_portal_access_revoke
AFTER UPDATE OF enabled, guardian_identity_hash, scope_version ON guardian_portal_access
WHEN NEW.enabled = 0
  OR OLD.guardian_identity_hash IS NOT NEW.guardian_identity_hash
  OR OLD.scope_version IS NOT NEW.scope_version
BEGIN
  UPDATE guardian_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE guardian_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;
