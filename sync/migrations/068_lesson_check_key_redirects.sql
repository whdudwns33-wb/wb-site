-- 요일별 담당 분리로 새 taskId에 이동한 과거 수업 check의 옛 키를 영구 봉인한다.
-- 키와 시각만 저장하며 학생 이름·연락처·수업 메모는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS lesson_check_key_redirects (
  app            TEXT    NOT NULL CHECK (app = 'task'),
  old_key        TEXT    NOT NULL CHECK (length(old_key) BETWEEN 12 AND 180 AND old_key LIKE '%|____-__-__'),
  new_key        TEXT    NOT NULL CHECK (length(new_key) BETWEEN 12 AND 180 AND new_key LIKE '%|____-__-__'),
  old_updated_at INTEGER NOT NULL CHECK (old_updated_at >= 0),
  created_at     INTEGER NOT NULL CHECK (created_at > 0),
  created_by     TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, old_key),
  UNIQUE (app, new_key),
  CHECK (old_key <> new_key)
);

CREATE INDEX IF NOT EXISTS idx_lesson_check_key_redirects_new
  ON lesson_check_key_redirects(app, new_key);

CREATE TRIGGER IF NOT EXISTS trg_lesson_check_key_redirects_no_update
BEFORE UPDATE ON lesson_check_key_redirects
BEGIN
  SELECT RAISE(ABORT, 'LESSON_CHECK_REDIRECT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_lesson_check_key_redirects_no_delete
BEFORE DELETE ON lesson_check_key_redirects
BEGIN
  SELECT RAISE(ABORT, 'LESSON_CHECK_REDIRECT_APPEND_ONLY');
END;

-- generic LWW INSERT/UPSERT는 BEFORE INSERT를 지나므로, 전환 직후의 동시 재전송도
-- 해당 한 행만 무시하고 같은 batch의 정상 check는 계속 저장된다.
CREATE TRIGGER IF NOT EXISTS trg_checks_ignore_moved_lesson_key_insert
BEFORE INSERT ON checks
WHEN NEW.app = 'task' AND EXISTS (
  SELECT 1 FROM lesson_check_key_redirects redirect
  WHERE redirect.app = NEW.app AND redirect.old_key = NEW.k
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS trg_checks_reject_moved_lesson_key_update
BEFORE UPDATE OF k ON checks
WHEN NEW.app = 'task' AND EXISTS (
  SELECT 1 FROM lesson_check_key_redirects redirect
  WHERE redirect.app = NEW.app AND redirect.old_key = NEW.k
)
BEGIN
  SELECT RAISE(ABORT, 'LESSON_CHECK_KEY_MOVED');
END;
