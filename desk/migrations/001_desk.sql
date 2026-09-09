-- WB 프로그램데스크(wb-desk) D1 스키마. 배포 워크플로우가 매 배포마다 이 파일을 통째로 다시 적용하므로
-- 모든 문장이 IF NOT EXISTS 여야 한다(트리거 포함). 컬럼 변경은 새 번호의 파일로 덧붙인다.
-- 학생 이름·보호자 전화 같은 개인정보는 desk_docs.data(JSON) 안에만 있고 저장소·정적 파일에는 없다.

-- 원장 계정은 하나뿐이라 id=1 로 고정한다. 비밀번호는 PBKDF2-SHA256(iterations·salt 별도 저장).
CREATE TABLE IF NOT EXISTS desk_admin (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  password_salt       TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 10000),
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL CHECK (created_at > 0)
);

-- 직원. 삭제 대신 active=0 — 요청 원장·연락 기록의 by/owner 가 이 id 를 가리키므로 행은 남긴다.
CREATE TABLE IF NOT EXISTS desk_staff (
  id         TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  role       TEXT    NOT NULL DEFAULT 'staff' CHECK (role = 'staff'),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- 직원 연결 코드(1회용, 7일). 원문은 링크로만 나가고 여기엔 sha256 만 남는다.
CREATE TABLE IF NOT EXISTS desk_codes (
  code_hash   TEXT    PRIMARY KEY,
  staff_id    TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL CHECK (expires_at > 0),
  consumed_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at  INTEGER NOT NULL CHECK (created_at > 0)
);
CREATE INDEX IF NOT EXISTS idx_desk_codes_staff ON desk_codes(staff_id, revoked);

-- 기기 토큰. staff_id 는 'admin' 또는 desk_staff.id. TTL 은 last_seen 기준(원장 30일·직원 180일)이라 코드가 판정한다.
CREATE TABLE IF NOT EXISTS desk_tokens (
  token_hash TEXT    PRIMARY KEY,
  staff_id   TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  last_seen  INTEGER NOT NULL CHECK (last_seen >= created_at),
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_desk_tokens_staff ON desk_tokens(staff_id, revoked);

-- 문서 저장소(students·tasks·checks·contacts·settings). 컬렉션별 규칙은 desk-api.mjs 가 본다.
-- deleted 는 소프트 삭제 — since= 동기화로 다른 기기가 지울 수 있게 행을 남긴다.
CREATE TABLE IF NOT EXISTS desk_docs (
  collection TEXT    NOT NULL CHECK (collection IN ('students', 'tasks', 'checks', 'contacts', 'settings')),
  id         TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_desk_docs_updated ON desk_docs(collection, updated_at);

-- 운영 요청 원장 — sync/ops-request(073) 이식. app 컬럼만 뺐고 규칙은 같다.
-- 학생은 SF 코드·students 문서 id(target_ref)로만 가리키고 이름·연락처는 저장하지 않는다.
-- 상태 갱신은 updated_at CAS 단일 UPDATE 로만, 이력은 desk_request_events 에 append-only.
CREATE TABLE IF NOT EXISTS desk_requests (
  request_id  TEXT    PRIMARY KEY CHECK (
    length(request_id) BETWEEN 8 AND 80
    AND request_id GLOB 'opr_[A-Za-z0-9_-]*'
    AND substr(request_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  req_type    TEXT    NOT NULL CHECK (req_type IN ('account', 'assignment', 'worksheet', 'followup', 'other')),
  program     TEXT    NOT NULL CHECK (
    program IN ('studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo', 'none')
  ),
  target_ref  TEXT    CHECK (target_ref IS NULL OR length(target_ref) BETWEEN 1 AND 128),
  owner_id    TEXT    NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  assignee_id TEXT    CHECK (assignee_id IS NULL OR length(assignee_id) BETWEEN 1 AND 128),
  via         TEXT    NOT NULL CHECK (via IN ('app', 'kakao', 'auto')),
  needed_by   TEXT    CHECK (
    needed_by IS NULL OR needed_by GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  detail      TEXT    NOT NULL CHECK (length(trim(detail)) BETWEEN 1 AND 300),
  status      TEXT    NOT NULL CHECK (
    status IN ('requested', 'accepted', 'in_progress', 'done', 'blocked', 'cancelled')
  ),
  result_note TEXT    CHECK (result_note IS NULL OR length(trim(result_note)) BETWEEN 1 AND 300),
  result_url  TEXT    CHECK (
    result_url IS NULL OR (length(result_url) BETWEEN 9 AND 500 AND result_url GLOB 'https://*')
  ),
  created_at  INTEGER NOT NULL CHECK (created_at > 0),
  accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  done_at     INTEGER CHECK (done_at IS NULL OR done_at >= created_at),
  updated_at  INTEGER NOT NULL CHECK (updated_at >= created_at),
  updated_by  TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS idx_desk_requests_assignee_status ON desk_requests(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_desk_requests_owner ON desk_requests(owner_id);

-- 소요·감사 근거. 누가 어느 상태에서 어느 상태로 눌렀는지만 남기고 본문은 다시 적지 않는다.
CREATE TABLE IF NOT EXISTS desk_request_events (
  event_id    TEXT    PRIMARY KEY CHECK (
    length(event_id) BETWEEN 9 AND 90
    AND event_id GLOB 'opre_[A-Za-z0-9_-]*'
    AND substr(event_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_id  TEXT    NOT NULL CHECK (length(request_id) BETWEEN 8 AND 80),
  actor_id    TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  action      TEXT    NOT NULL CHECK (
    action IN ('create', 'assign', 'accept', 'start', 'done', 'block', 'unblock', 'cancel')
  ),
  from_status TEXT    CHECK (
    from_status IS NULL
    OR from_status IN ('requested', 'accepted', 'in_progress', 'done', 'blocked', 'cancelled')
  ),
  to_status   TEXT    NOT NULL CHECK (
    to_status IN ('requested', 'accepted', 'in_progress', 'done', 'blocked', 'cancelled')
  ),
  created_at  INTEGER NOT NULL CHECK (created_at > 0),
  FOREIGN KEY (request_id) REFERENCES desk_requests(request_id)
);
CREATE INDEX IF NOT EXISTS idx_desk_request_events_request ON desk_request_events(request_id, created_at);

-- 요청자·종류·본문은 만든 뒤 바뀌지 않는다(상태·담당·결과만 갱신). done/cancelled 는 종결 상태다.
-- updated_at 은 갱신마다 반드시 커져야 CAS(expectedUpdatedAt)가 같은 ms 안의 연속 갱신을 구분한다.
CREATE TRIGGER IF NOT EXISTS trg_desk_requests_update_guard
BEFORE UPDATE ON desk_requests
BEGIN
  SELECT CASE WHEN NEW.request_id <> OLD.request_id
    OR NEW.req_type <> OLD.req_type
    OR NEW.program <> OLD.program
    OR NEW.target_ref IS NOT OLD.target_ref
    OR NEW.owner_id <> OLD.owner_id
    OR NEW.via <> OLD.via
    OR NEW.needed_by IS NOT OLD.needed_by
    OR NEW.detail <> OLD.detail
    OR NEW.created_at <> OLD.created_at
  THEN RAISE(ABORT, 'OPS_REQUEST_IMMUTABLE_FIELDS') END;
  SELECT CASE WHEN OLD.status IN ('done', 'cancelled') OR NEW.updated_at <= OLD.updated_at
  THEN RAISE(ABORT, 'OPS_REQUEST_INVALID_TRANSITION') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_desk_requests_no_delete
BEFORE DELETE ON desk_requests
BEGIN
  SELECT RAISE(ABORT, 'OPS_REQUEST_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_desk_request_events_no_update
BEFORE UPDATE ON desk_request_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_REQUEST_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_desk_request_events_no_delete
BEFORE DELETE ON desk_request_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_REQUEST_EVENT_APPEND_ONLY');
END;
