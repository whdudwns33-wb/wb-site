-- 프로그램·자료 운영 요청 원장(SOP 콕핏 Phase 1, /ops-request).
-- 계정 발급·배정·문제지·후속 같은 "누가 언제까지 무엇을 해 달라"를 tasks 행이 아닌 별도 표에 둔다 —
-- 그래야 완료율·브리핑 집계에 섞이지 않고, 담당자·소요(요청→접수→완료)를 요청 단위로 셀 수 있다.
-- 학생은 SF 코드 또는 stable studentId(target_ref)로만 가리키고 이름·연락처는 저장하지 않는다.
-- 정규식 검증(SF-\d{3}·SAFE_ID·전화/이메일/주민번호 패턴 거부)은 ops-request.js가 하고 여기서는 길이·어휘만 본다.
-- 상태 갱신은 updated_at CAS 단일 UPDATE로만 일어나고 이력은 ops_request_events에 append-only로 남는다.
CREATE TABLE IF NOT EXISTS ops_requests (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  request_id  TEXT    NOT NULL CHECK (
    length(request_id) BETWEEN 8 AND 80
    AND request_id GLOB 'opr_[A-Za-z0-9_-]*'
    AND substr(request_id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  req_type    TEXT    NOT NULL CHECK (req_type IN ('account','assignment','worksheet','followup','other')),
  program     TEXT    NOT NULL CHECK (
    program IN ('studyforce','classcard','metamath','nelt','exam4you','jokbo','none')
  ),
  target_ref  TEXT    CHECK (target_ref IS NULL OR length(target_ref) BETWEEN 1 AND 128),
  owner_id    TEXT    NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  assignee_id TEXT    CHECK (assignee_id IS NULL OR length(assignee_id) BETWEEN 1 AND 128),
  via         TEXT    NOT NULL CHECK (via IN ('app','kakao','auto')),
  needed_by   TEXT    CHECK (
    needed_by IS NULL OR needed_by GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  detail      TEXT    NOT NULL CHECK (length(trim(detail)) BETWEEN 1 AND 300),
  status      TEXT    NOT NULL CHECK (
    status IN ('requested','accepted','in_progress','done','blocked','cancelled')
  ),
  result_note TEXT    CHECK (result_note IS NULL OR length(trim(result_note)) BETWEEN 1 AND 300),
  result_url  TEXT    CHECK (
    result_url IS NULL OR (length(result_url) BETWEEN 9 AND 500 AND result_url GLOB 'https://*')
  ),
  created_at  INTEGER NOT NULL CHECK (created_at > 0),
  accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  done_at     INTEGER CHECK (done_at IS NULL OR done_at >= created_at),
  updated_at  INTEGER NOT NULL CHECK (updated_at >= created_at),
  updated_by  TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, request_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_requests_assignee_status
  ON ops_requests(app, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_ops_requests_owner
  ON ops_requests(app, owner_id);

-- 소요·감사 근거. 누가 어느 상태에서 어느 상태로 눌렀는지만 남기고 본문은 다시 적지 않는다.
CREATE TABLE IF NOT EXISTS ops_request_events (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  event_id    TEXT    NOT NULL CHECK (
    length(event_id) BETWEEN 9 AND 90
    AND event_id GLOB 'opre_[A-Za-z0-9_-]*'
    AND substr(event_id,6) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_id  TEXT    NOT NULL CHECK (length(request_id) BETWEEN 8 AND 80),
  actor_id    TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  action      TEXT    NOT NULL CHECK (
    action IN ('create','assign','accept','start','done','block','unblock','cancel')
  ),
  from_status TEXT    CHECK (
    from_status IS NULL
    OR from_status IN ('requested','accepted','in_progress','done','blocked','cancelled')
  ),
  to_status   TEXT    NOT NULL CHECK (
    to_status IN ('requested','accepted','in_progress','done','blocked','cancelled')
  ),
  created_at  INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, event_id),
  FOREIGN KEY (app, request_id) REFERENCES ops_requests(app, request_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_request_events_request
  ON ops_request_events(app, request_id, created_at);

-- 요청자·종류·본문은 만든 뒤 바뀌지 않는다(상태·담당·결과만 갱신). done/cancelled는 종결 상태다.
-- updated_at은 갱신마다 반드시 커져야 CAS(expectedUpdatedAt)가 같은 ms 안의 연속 갱신을 구분한다.
CREATE TRIGGER IF NOT EXISTS trg_ops_requests_update_guard
BEFORE UPDATE ON ops_requests
BEGIN
  SELECT CASE WHEN NEW.app <> OLD.app
    OR NEW.request_id <> OLD.request_id
    OR NEW.req_type <> OLD.req_type
    OR NEW.program <> OLD.program
    OR NEW.target_ref IS NOT OLD.target_ref
    OR NEW.owner_id <> OLD.owner_id
    OR NEW.via <> OLD.via
    OR NEW.needed_by IS NOT OLD.needed_by
    OR NEW.detail <> OLD.detail
    OR NEW.created_at <> OLD.created_at
  THEN RAISE(ABORT, 'OPS_REQUEST_IMMUTABLE_FIELDS') END;
  SELECT CASE WHEN OLD.status IN ('done','cancelled') OR NEW.updated_at <= OLD.updated_at
  THEN RAISE(ABORT, 'OPS_REQUEST_INVALID_TRANSITION') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_ops_requests_no_delete
BEFORE DELETE ON ops_requests
BEGIN
  SELECT RAISE(ABORT, 'OPS_REQUEST_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_ops_request_events_no_update
BEFORE UPDATE ON ops_request_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_REQUEST_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_ops_request_events_no_delete
BEFORE DELETE ON ops_request_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_REQUEST_EVENT_APPEND_ONLY');
END;
