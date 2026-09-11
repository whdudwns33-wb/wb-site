-- 069의 JSON 전개 view/trigger는 D1 쓰기 경로에서 과도한 비용과 잠금 시간을 만들 수 있다.
-- 일정 충돌 검증은 Worker의 학생별 revision 직렬화 경로로 옮기고, 기존 운영 DB 객체를 제거한다.

-- view를 참조하는 trigger부터 제거해야 중간 상태에서도 종속 객체가 남지 않는다.
DROP TRIGGER IF EXISTS trg_regular_lesson_time_insert;
DROP TRIGGER IF EXISTS trg_regular_lesson_time_update;
DROP TRIGGER IF EXISTS trg_makeup_regular_time_insert;
DROP TRIGGER IF EXISTS trg_makeup_regular_time_update;

-- 파생 slots view가 tasks view를 참조하므로 역순으로 제거한다.
DROP VIEW IF EXISTS active_regular_lesson_slots_v1;
DROP VIEW IF EXISTS active_regular_lesson_tasks_v1;

-- 이름이나 연락처를 두지 않는 학생별 CAS revision 원장이다.
CREATE TABLE IF NOT EXISTS student_schedule_revisions (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  student_id TEXT    NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app, student_id)
);

-- 보강이 실제 일정에 들어올 때만 해당 학생의 일정 revision을 한 번 올린다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_schedule_revision_insert
AFTER INSERT ON makeup_cases
WHEN NEW.status IN ('confirmed', 'completed')
BEGIN
  INSERT INTO student_schedule_revisions(app, student_id, revision, updated_at)
  VALUES(NEW.app, NEW.student_id, 1, NEW.updated_at)
  ON CONFLICT(app, student_id) DO UPDATE SET
    revision = student_schedule_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

-- 활성 보강의 학생·상태·시간이 바뀌면 이전/새 학생 캐시를 모두 무효화한다.
-- 학생이 같으면 두 번째 INSERT를 생략해 한 변경당 한 번만 증가시킨다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_schedule_revision_update
AFTER UPDATE OF student_id, status, confirmed_start_at, confirmed_end_at ON makeup_cases
WHEN (
  OLD.student_id IS NOT NEW.student_id
  OR OLD.status IS NOT NEW.status
  OR OLD.confirmed_start_at IS NOT NEW.confirmed_start_at
  OR OLD.confirmed_end_at IS NOT NEW.confirmed_end_at
) AND (
  OLD.status IN ('confirmed', 'completed')
  OR NEW.status IN ('confirmed', 'completed')
)
BEGIN
  INSERT INTO student_schedule_revisions(app, student_id, revision, updated_at)
  VALUES(OLD.app, OLD.student_id, 1, NEW.updated_at)
  ON CONFLICT(app, student_id) DO UPDATE SET
    revision = student_schedule_revisions.revision + 1,
    updated_at = excluded.updated_at;

  INSERT INTO student_schedule_revisions(app, student_id, revision, updated_at)
  SELECT NEW.app, NEW.student_id, 1, NEW.updated_at
  WHERE NEW.app IS NOT OLD.app OR NEW.student_id IS NOT OLD.student_id
  ON CONFLICT(app, student_id) DO UPDATE SET
    revision = student_schedule_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;
