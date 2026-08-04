-- 학부모 피드백 문구 검토 요청(안전한 1단계)
-- 실제 외부 발송 정보나 발송 결과는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS feedback_requests (
  app              TEXT    NOT NULL,
  request_key      TEXT    NOT NULL,
  task_id          TEXT    NOT NULL,
  owner            TEXT    NOT NULL,
  feedback_date    TEXT    NOT NULL,
  feedback_type    TEXT    NOT NULL,
  template_version TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  body_hash        TEXT    NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL CHECK (status IN (
    'approval_waiting',
    'content_approved_send_blocked',
    'revision_requested',
    'cancelled'
  )),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  reviewed_at      INTEGER,
  reviewed_by      TEXT,
  review_note      TEXT,
  PRIMARY KEY (app, request_key),
  UNIQUE (app, task_id, feedback_date, feedback_type, template_version)
);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_owner
  ON feedback_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_status
  ON feedback_requests(app, status, updated_at);
