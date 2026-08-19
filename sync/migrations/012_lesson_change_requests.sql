-- 수업 지시서(요일·시간·교재 진도 등) 변경 요청
-- 원장이 등록한 [수업] 지시서는 직원이 직접 고칠 수 없다(서버가 막음).
-- 대신 직원은 여기에 "바꿔 달라"는 제안만 남기고, 원장이 승인해야 실제 지시서에 반영된다.
-- 한 지시서(task_id)당 열려 있는 제안은 하나뿐 — 다시 제출하면 같은 행을 revision만 올려서 갱신한다.
CREATE TABLE IF NOT EXISTS lesson_change_requests (
  app          TEXT    NOT NULL,
  request_key  TEXT    NOT NULL,
  task_id      TEXT    NOT NULL,
  owner        TEXT    NOT NULL,          -- 제안한 직원(=지시서 담당 staffId)
  changes      TEXT    NOT NULL,          -- JSON. 일반 수업 필드 또는 서버가 검증한 operation/effectiveDate
  changes_hash TEXT    NOT NULL,
  note         TEXT,                      -- 직원이 남기는 사유
  revision     INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL CHECK (status IN (
    'approval_waiting',
    'approved',
    'rejected',
    'cancelled'
  )),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  reviewed_at  INTEGER,
  reviewed_by  TEXT,
  review_note  TEXT,
  PRIMARY KEY (app, request_key),
  UNIQUE (app, task_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_change_requests_owner
  ON lesson_change_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_lesson_change_requests_status
  ON lesson_change_requests(app, status, updated_at);
