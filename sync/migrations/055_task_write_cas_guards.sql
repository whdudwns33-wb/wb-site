-- 055: 다중 문장 D1 batch의 optimistic UPDATE가 0건일 때 후속 쓰기가 부분 커밋되지 않게 한다.
-- guard 행에는 개인정보나 원문 payload가 없고 성공한 CAS의 최소 감사 정보만 append-only로 남긴다.
CREATE TABLE IF NOT EXISTS task_write_cas_guards (
  app              TEXT    NOT NULL CHECK (app = 'task'),
  guard_id         TEXT    NOT NULL CHECK (length(guard_id) BETWEEN 8 AND 80 AND guard_id LIKE 'twcg_%'),
  operation        TEXT    NOT NULL CHECK (length(operation) BETWEEN 1 AND 80),
  previous_changes INTEGER NOT NULL CHECK (previous_changes = 1),
  created_at       INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, guard_id)
);

CREATE TRIGGER IF NOT EXISTS trg_task_write_cas_guard
BEFORE INSERT ON task_write_cas_guards
WHEN NEW.previous_changes <> 1
BEGIN
  SELECT RAISE(ABORT, 'TASK_WRITE_CAS_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_write_cas_guard_no_update
BEFORE UPDATE ON task_write_cas_guards
BEGIN
  SELECT RAISE(ABORT, 'TASK_WRITE_CAS_GUARD_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_write_cas_guard_no_delete
BEFORE DELETE ON task_write_cas_guards
BEGIN
  SELECT RAISE(ABORT, 'TASK_WRITE_CAS_GUARD_APPEND_ONLY');
END;
