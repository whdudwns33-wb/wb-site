-- 물리 삭제된 task가 오래 열린 태블릿 캐시에서 다시 살아나지 않게 한다.
-- 학생 정보·수업 내용은 저장하지 않고, 캐시 정리에 필요한 taskId와 예전 담당자만 남긴다.
CREATE TABLE IF NOT EXISTS task_revocations (
  revocation_seq  INTEGER PRIMARY KEY AUTOINCREMENT,
  app             TEXT    NOT NULL CHECK (app = 'task'),
  data_generation INTEGER NOT NULL CHECK (data_generation >= 0),
  task_id         TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 1 AND 128 AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  former_owner    TEXT    NOT NULL CHECK (
    former_owner = '' OR (
      length(former_owner) BETWEEN 1 AND 128 AND former_owner NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  revoked_at      INTEGER NOT NULL CHECK (revoked_at > 0),
  UNIQUE (app, data_generation, task_id, former_owner)
);

CREATE INDEX IF NOT EXISTS idx_task_revocations_generation_seq
  ON task_revocations(app, data_generation, revocation_seq);

CREATE INDEX IF NOT EXISTS idx_task_revocations_owner_seq
  ON task_revocations(app, data_generation, former_owner, revocation_seq);

CREATE TRIGGER IF NOT EXISTS trg_task_revocations_no_update
BEFORE UPDATE ON task_revocations
BEGIN
  SELECT RAISE(ABORT, 'TASK_REVOCATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_revocations_no_delete
BEFORE DELETE ON task_revocations
BEGIN
  SELECT RAISE(ABORT, 'TASK_REVOCATION_APPEND_ONLY');
END;

-- task 물리 삭제와 표식 생성은 하나의 SQLite transaction에서 같이 성립한다.
-- ON CONFLICT DO NOTHING은 동일 삭제의 멱등 재시도만 허용하고 CHECK 오류는 숨기지 않는다.
CREATE TRIGGER IF NOT EXISTS trg_tasks_capture_revocation_delete
AFTER DELETE ON tasks
WHEN OLD.app = 'task'
BEGIN
  INSERT INTO task_revocations(app, data_generation, task_id, former_owner, revoked_at)
  SELECT OLD.app, generation, OLD.id, COALESCE(OLD.owner, ''),
    max(OLD.updated_at, OLD.srv_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  FROM app_data_generations
  WHERE app = OLD.app
  ON CONFLICT(app, data_generation, task_id, former_owner) DO NOTHING;
END;

-- 구형 브라우저가 삭제 전 task/check를 다시 올려도 전체 sync를 실패시키지 않고 해당 행만 무시한다.
CREATE TRIGGER IF NOT EXISTS trg_tasks_ignore_revoked_insert
BEFORE INSERT ON tasks
WHEN NEW.app = 'task' AND EXISTS (
  SELECT 1
  FROM task_revocations AS revocation
  JOIN app_data_generations AS generation
    ON generation.app = revocation.app AND generation.generation = revocation.data_generation
  WHERE revocation.app = NEW.app AND revocation.task_id = NEW.id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_ignore_revoked_update
BEFORE UPDATE ON tasks
WHEN NEW.app = 'task' AND EXISTS (
  SELECT 1
  FROM task_revocations AS revocation
  JOIN app_data_generations AS generation
    ON generation.app = revocation.app AND generation.generation = revocation.data_generation
  WHERE revocation.app = NEW.app AND revocation.task_id = NEW.id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS trg_checks_ignore_revoked_task_insert
BEFORE INSERT ON checks
WHEN NEW.app = 'task' AND instr(NEW.k, '|') > 1 AND EXISTS (
  SELECT 1
  FROM task_revocations AS revocation
  JOIN app_data_generations AS generation
    ON generation.app = revocation.app AND generation.generation = revocation.data_generation
  WHERE revocation.app = NEW.app
    AND revocation.task_id = substr(NEW.k, 1, instr(NEW.k, '|') - 1)
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS trg_checks_ignore_revoked_task_update
BEFORE UPDATE ON checks
WHEN NEW.app = 'task' AND instr(NEW.k, '|') > 1 AND EXISTS (
  SELECT 1
  FROM task_revocations AS revocation
  JOIN app_data_generations AS generation
    ON generation.app = revocation.app AND generation.generation = revocation.data_generation
  WHERE revocation.app = NEW.app
    AND revocation.task_id = substr(NEW.k, 1, instr(NEW.k, '|') - 1)
)
BEGIN
  SELECT RAISE(IGNORE);
END;
