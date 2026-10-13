-- 실시간 요청 전용: 본문·학생 정보·인증 원문을 담지 않는 기기 알림.
CREATE TABLE IF NOT EXISTS task_push_subscriptions (
 endpoint_id TEXT PRIMARY KEY,
 endpoint TEXT NOT NULL,
 staff_id TEXT NOT NULL,
 auth_kind TEXT NOT NULL CHECK(auth_kind IN ('person','admin')),
 auth_hash TEXT NOT NULL,
 manager INTEGER NOT NULL CHECK(manager IN (0,1)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_push_staff ON task_push_subscriptions(staff_id,active);
CREATE TABLE IF NOT EXISTS task_push_jobs (
 endpoint_id TEXT NOT NULL,
 event_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('teacher','admin')),
 source_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 next_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','failed','skipped')),
 PRIMARY KEY(endpoint_id,event_key),
 FOREIGN KEY(endpoint_id) REFERENCES task_push_subscriptions(endpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_task_push_pending ON task_push_jobs(status,next_at);
-- 요청과 같은 트랜잭션에서 큐에 기록하여 저장 직후 프로세스 종료에도 놓치지 않는다.
CREATE TRIGGER IF NOT EXISTS trg_task_push_teacher AFTER INSERT ON teacher_live_requests
WHEN NEW.app='task'
BEGIN
 INSERT OR IGNORE INTO task_push_jobs(endpoint_id,event_key,kind,source_id,created_at)
 SELECT endpoint_id,'teacher:'||NEW.request_id,'teacher',NEW.request_id,NEW.created_at
 FROM task_push_subscriptions WHERE active=1 AND manager=1;
END;
CREATE TRIGGER IF NOT EXISTS trg_task_push_admin AFTER INSERT ON admin_directive_revisions
WHEN NEW.app='task'
BEGIN
 INSERT OR IGNORE INTO task_push_jobs(endpoint_id,event_key,kind,source_id,revision,created_at)
 SELECT endpoint_id,'admin:'||NEW.directive_id||':'||NEW.revision,'admin',NEW.directive_id,NEW.revision,NEW.created_at
 FROM task_push_subscriptions
 WHERE active=1 AND EXISTS(SELECT 1 FROM json_each(NEW.audience_staff_ids) WHERE value=staff_id);
END;
