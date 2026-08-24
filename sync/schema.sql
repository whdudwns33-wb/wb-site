-- WB 동기화 백엔드 (Cloudflare D1)
--
-- 설계 원칙
--  1) 학생·직원별로 분할한다. 한 사람이 자기 데이터를 저장할 때 남의 데이터를 건드리지 않는다.
--     (기존 Apps Script는 매번 전체 상태를 통째로 주고받아 30명 부근에서 무너졌다)
--  2) 델타 동기화. srv_at(서버 시각) 이후 바뀐 행만 주고받는다.
--  3) 충돌은 updated_at(클라이언트 시각) 기준 last-write-wins.
--     서버가 srv_at을 따로 찍는 이유는 기기 시계가 틀어져도 델타 기준이 흔들리지 않게 하기 위함이다.

CREATE TABLE IF NOT EXISTS staff (
  app        TEXT    NOT NULL,          -- 'task' | 'consult'
  id         TEXT    NOT NULL,
  owner      TEXT,                      -- 본인 id. 조회 규칙을 세 테이블에서 동일하게 쓰기 위함
  data       TEXT    NOT NULL,          -- JSON 원본
  updated_at INTEGER NOT NULL,          -- 클라이언트 시각 (충돌 판정)
  srv_at     INTEGER NOT NULL,          -- 서버 시각 (델타 기준)
  PRIMARY KEY (app, id)
);
CREATE INDEX IF NOT EXISTS idx_staff_srv   ON staff(app, srv_at);
CREATE INDEX IF NOT EXISTS idx_staff_owner ON staff(app, owner, srv_at);

CREATE TABLE IF NOT EXISTS tasks (
  app        TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  owner      TEXT,                      -- 담당 staffId
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  srv_at     INTEGER NOT NULL,
  PRIMARY KEY (app, id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_srv   ON tasks(app, srv_at);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(app, owner, srv_at);

CREATE TABLE IF NOT EXISTS checks (
  app        TEXT    NOT NULL,
  k          TEXT    NOT NULL,          -- 'taskId|date' 또는 '__st__staffId|date' 등
  owner      TEXT,                      -- 이 기록이 누구 것인지 (분할 키)
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  srv_at     INTEGER NOT NULL,
  PRIMARY KEY (app, k)
);
CREATE INDEX IF NOT EXISTS idx_checks_srv   ON checks(app, srv_at);
CREATE INDEX IF NOT EXISTS idx_checks_owner ON checks(app, owner, srv_at);

-- 개인 링크 토큰. 링크마다 다른 토큰을 줘서, 링크 하나가 새어도 그 사람 것만 열린다.
-- (기존 구조는 모든 개인 링크에 전체 접근 비밀키가 들어 있었다)
CREATE TABLE IF NOT EXISTS tokens (
  app        TEXT    NOT NULL,
  token      TEXT    NOT NULL,
  staff_id   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, token)
);
CREATE INDEX IF NOT EXISTS idx_tokens_staff ON tokens(app, staff_id);

-- consult 원장 로그인 계정. 비밀번호 원문은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS admin_accounts (
  app                 TEXT    NOT NULL PRIMARY KEY CHECK (app = 'consult'),
  login_id            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_salt       TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);

-- 개인 링크에는 장기 bearer 대신 짧게 유효한 1회용 code만 넣는다.
CREATE TABLE IF NOT EXISTS bootstrap_codes (
  app         TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  staff_id    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_bootstrap_staff
  ON bootstrap_codes(app, staff_id, revoked, expires_at);

-- 학생 체계 초기화 세대. 다른 세대의 generic sync 쓰기는 적용 전에 거절한다.
CREATE TABLE IF NOT EXISTS app_data_generations (
  app TEXT PRIMARY KEY CHECK (app IN ('task', 'consult')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_data_generations(app, generation, updated_at) VALUES
  ('task', 0, 0),
  ('consult', 0, 0);

-- 학부모 피드백 문구의 검토 요청 원장.
-- 원장 지시(2026-08)로 별도 승인 클릭 없이 제출 즉시 카카오 알림톡 실발송을 시도한다.
-- status는 그 시도 결과다 — 'sent'는 성공, 'content_approved_send_blocked'는 "아직 안 나감"
-- (보호자 연락처·동의 미등록, 발송 스위치 꺼짐, 카카오 반려 등 — 사유는 review_note에 남는다).
-- teacher_name/student_name/content_text/plus_text/minus_text는 알림톡 템플릿 변수에
-- 그대로 들어가는 항목별 값이다(parent-feedback-send.js). body/body_hash는 예전 자유 문구
-- 형식과 "복사하기" 버튼용으로 계속 남겨둔다.
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
  teacher_name     TEXT,
  student_id       TEXT,              -- private_rosters.roster.students[].id (수신자 결합 정본)
  student_name     TEXT,
  content_text     TEXT,
  plus_text        TEXT,
  minus_text       TEXT,
  revision         INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL CHECK (status IN (
    'approval_waiting',
    'content_approved_send_blocked',
    'sent',
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

-- 원장 본인(TEST-SMS-001)에게만 보내는 오늘 수행 보고 테스트 발송 원장.
-- 전화번호, 문자 본문, 공급자 원본 응답은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS director_report_sends (
  app                    TEXT    NOT NULL CHECK (app = 'task'),
  send_id                TEXT    NOT NULL,
  idempotency_key        TEXT    NOT NULL,
  report_date            TEXT    NOT NULL,
  staff_id               TEXT    NOT NULL,
  recipient_slot         TEXT    NOT NULL CHECK (recipient_slot = 'TEST-SMS-001'),
  total_count            INTEGER NOT NULL CHECK (total_count >= 0),
  done_count             INTEGER NOT NULL CHECK (done_count >= 0),
  doing_count            INTEGER NOT NULL CHECK (doing_count >= 0),
  todo_count             INTEGER NOT NULL CHECK (todo_count >= 0),
  blocked_count          INTEGER NOT NULL CHECK (blocked_count >= 0),
  message_hash           TEXT    NOT NULL CHECK (length(message_hash) = 64),
  status                 TEXT    NOT NULL CHECK (status IN (
    'reserved',
    'dispatching',
    'accepted',
    'rejected',
    'unknown'
  )),
  provider_group_id      TEXT,
  provider_message_id    TEXT,
  provider_status_code   TEXT,
  safe_error_code        TEXT,
  created_at             INTEGER NOT NULL,
  dispatch_started_at    INTEGER,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  CHECK (done_count + doing_count + todo_count + blocked_count = total_count)
);

CREATE INDEX IF NOT EXISTS idx_director_report_sends_staff_day
  ON director_report_sends(app, report_date, staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_director_report_sends_day
  ON director_report_sends(app, report_date, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_director_report_sends_provider_message
  ON director_report_sends(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

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

-- 원생 정보·수업 업무지시 변경의 누적 이력과 사용자별 독립 확인 상태.
-- lesson_delete 행은 감사 보존용이며 student-change API에서 항상 제외한다.
CREATE TABLE IF NOT EXISTS student_change_events (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  event_id           TEXT    NOT NULL CHECK (length(event_id) BETWEEN 8 AND 80 AND event_id LIKE 'sce_%'),
  student_id         TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  task_id            TEXT    CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 160),
  event_type         TEXT    NOT NULL CHECK (event_type IN (
    'student_information','work_instruction','teacher_assignment','withdrawal','leave',
    'information_request','lesson_delete'
  )),
  changed_fields     TEXT    NOT NULL CHECK (json_valid(changed_fields) AND json_type(changed_fields) = 'array'),
  details            TEXT    NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  audience_staff_ids TEXT    NOT NULL CHECK (json_valid(audience_staff_ids) AND json_type(audience_staff_ids) = 'array'),
  effective_date     TEXT    CHECK (effective_date IS NULL OR length(effective_date) = 10),
  requires_ack       INTEGER NOT NULL DEFAULT 0 CHECK (requires_ack IN (0,1)),
  request_key        TEXT,
  request_revision   INTEGER CHECK (request_revision IS NULL OR request_revision >= 1),
  changed_at         INTEGER NOT NULL CHECK (changed_at > 0),
  changed_by         TEXT    NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, event_id),
  UNIQUE (app, request_key, request_revision),
  CHECK ((request_key IS NULL AND request_revision IS NULL) OR
         (request_key IS NOT NULL AND request_revision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_student_change_events_student
  ON student_change_events(app, student_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_student_change_events_task
  ON student_change_events(app, task_id, changed_at);

CREATE TABLE IF NOT EXISTS student_change_acknowledgements (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  acknowledgement_id TEXT   NOT NULL CHECK (length(acknowledgement_id) BETWEEN 8 AND 80 AND acknowledgement_id LIKE 'sca_%'),
  event_id           TEXT    NOT NULL,
  actor_key          TEXT    NOT NULL CHECK (length(actor_key) BETWEEN 1 AND 160),
  acknowledged_at    INTEGER NOT NULL CHECK (acknowledged_at > 0),
  PRIMARY KEY (app, acknowledgement_id),
  UNIQUE (app, event_id, actor_key),
  FOREIGN KEY (app, event_id) REFERENCES student_change_events(app, event_id)
);
CREATE INDEX IF NOT EXISTS idx_student_change_ack_actor
  ON student_change_acknowledgements(app, actor_key, acknowledged_at);

CREATE TRIGGER IF NOT EXISTS trg_student_change_events_no_update
BEFORE UPDATE ON student_change_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_change_events_no_delete
BEFORE DELETE ON student_change_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_change_ack_no_update
BEFORE UPDATE ON student_change_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_ACK_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_change_ack_no_delete
BEFORE DELETE ON student_change_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_CHANGE_ACK_APPEND_ONLY');
END;

-- 관리자가 여러 선생님에게 전달하는 공통 요청을 버전별로 보관한다.
CREATE TABLE IF NOT EXISTS admin_directives (
  app TEXT NOT NULL CHECK (app = 'task'),
  directive_id TEXT NOT NULL CHECK (length(directive_id) BETWEEN 8 AND 80 AND directive_id LIKE 'adr_%' AND directive_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
  ended_at INTEGER,
  ended_by TEXT,
  PRIMARY KEY (app, directive_id),
  CHECK ((status = 'active' AND ended_at IS NULL AND ended_by IS NULL) OR (status = 'ended' AND ended_at IS NOT NULL AND ended_at >= created_at AND ended_by IS NOT NULL AND length(ended_by) BETWEEN 1 AND 100))
);
CREATE TABLE IF NOT EXISTS admin_directive_revisions (
  app TEXT NOT NULL CHECK (app = 'task'),
  directive_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  priority TEXT NOT NULL CHECK (priority IN ('normal', 'important')),
  starts_date TEXT NOT NULL CHECK (length(starts_date) = 10 AND starts_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  expires_date TEXT CHECK (expires_date IS NULL OR (length(expires_date) = 10 AND expires_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND expires_date >= starts_date)),
  audience_staff_ids TEXT NOT NULL CHECK (json_valid(audience_staff_ids) AND json_type(audience_staff_ids) = 'array' AND json_array_length(audience_staff_ids) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  PRIMARY KEY (app, directive_id, revision),
  FOREIGN KEY (app, directive_id) REFERENCES admin_directives(app, directive_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_directive_revisions_created ON admin_directive_revisions(app, created_at DESC);
CREATE TABLE IF NOT EXISTS admin_directive_receipt_events (
  app TEXT NOT NULL CHECK (app = 'task'),
  receipt_event_id TEXT NOT NULL CHECK (length(receipt_event_id) BETWEEN 9 AND 90 AND receipt_event_id LIKE 'adre_%' AND receipt_event_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  directive_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  staff_id TEXT NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 80 AND staff_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'acknowledged')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, receipt_event_id),
  UNIQUE (app, directive_id, revision, staff_id, event_type),
  FOREIGN KEY (app, directive_id, revision) REFERENCES admin_directive_revisions(app, directive_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_admin_directive_receipts_lookup ON admin_directive_receipt_events(app, directive_id, revision, staff_id, event_type);
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_audience_insert
BEFORE INSERT ON admin_directive_revisions
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.audience_staff_ids) WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 80 OR value GLOB '*[^A-Za-z0-9_-]*') THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_INVALID_AUDIENCE') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.audience_staff_ids)) <> (SELECT COUNT(DISTINCT value) FROM json_each(NEW.audience_staff_ids)) THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_DUPLICATE_AUDIENCE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directives_update_guard
BEFORE UPDATE ON admin_directives
BEGIN
  SELECT CASE WHEN NEW.app <> OLD.app OR NEW.directive_id <> OLD.directive_id OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_IMMUTABLE_FIELDS') END;
  SELECT CASE WHEN NOT (OLD.status = 'active' AND NEW.updated_at > OLD.updated_at AND ((NEW.status = 'active' AND NEW.current_revision = OLD.current_revision + 1 AND NEW.ended_at IS NULL AND NEW.ended_by IS NULL) OR (NEW.status = 'ended' AND NEW.current_revision = OLD.current_revision AND NEW.ended_at IS NOT NULL AND NEW.ended_by IS NOT NULL))) THEN RAISE(ABORT, 'ADMIN_DIRECTIVE_INVALID_TRANSITION') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directives_no_delete BEFORE DELETE ON admin_directives BEGIN SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_revisions_no_update BEFORE UPDATE ON admin_directive_revisions BEGIN SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_REVISION_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_revisions_no_delete BEFORE DELETE ON admin_directive_revisions BEGIN SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_REVISION_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_receipts_no_update BEFORE UPDATE ON admin_directive_receipt_events BEGIN SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_RECEIPT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS trg_admin_directive_receipts_no_delete BEFORE DELETE ON admin_directive_receipt_events BEGIN SELECT RAISE(ABORT, 'ADMIN_DIRECTIVE_RECEIPT_APPEND_ONLY'); END;

-- 교재 주문 문자를 거래처(출판사)에 실제로 보낸 이력.
-- 전화번호·문구는 저장하지 않는다 — 어느 거래처에 몇 건 보냈는지와 결과만 남긴다.
CREATE TABLE IF NOT EXISTS book_order_sends (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  send_id              TEXT    NOT NULL,
  idempotency_key      TEXT    NOT NULL,
  task_id              TEXT    NOT NULL,
  vendor_name          TEXT    NOT NULL,
  item_count           INTEGER NOT NULL CHECK (item_count >= 1),
  message_hash         TEXT    NOT NULL CHECK (length(message_hash) = 64),
  status               TEXT    NOT NULL CHECK (status IN (
    'reserved',
    'dispatching',
    'accepted',
    'rejected',
    'unknown'
  )),
  provider_group_id    TEXT,
  provider_message_id  TEXT,
  provider_status_code TEXT,
  safe_error_code      TEXT,
  created_at           INTEGER NOT NULL,
  dispatch_started_at  INTEGER,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_book_order_sends_task
  ON book_order_sends(app, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_book_order_sends_day
  ON book_order_sends(app, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_order_sends_provider_message
  ON book_order_sends(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- 저녁 일괄 발송에 포함된 원본 주문. 한 주문이 두 번 발송 묶음에 들어가지 않게 한다.
CREATE TABLE IF NOT EXISTS book_order_batch_items (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  task_id    TEXT    NOT NULL,
  send_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app, task_id)
);
CREATE INDEX IF NOT EXISTS idx_book_order_batch_items_send
  ON book_order_batch_items(app, send_id);

-- 예약 cron과 수동·직접 발송이 같은 주문을 동시에 발송하지 않게 하는 단일 lease.
-- owner가 일치하는 실행만 해제하며, 비정상 종료 시 10분 뒤 다음 실행이 인계한다.
CREATE TABLE IF NOT EXISTS book_order_dispatch_lock (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  owner       TEXT    NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app)
);

-- 교재 DB(textbooks.json)는 저장소의 정적 파일이라 앱에서 직접 고칠 수 없다.
-- 여기서는 그 자리를 메운다: 선생님이 "이 교재를 새로 추가해 주세요"를 신청하면(request),
-- 원장이 검토(review)해 승인해야 교재 목록에 실제로 나타난다. 원장이 직접 신청하면
-- 검토 없이 바로 승인 상태로 등록된다(book-add-request.js에서 처리).
-- 같은 사람이 같은 이름을 다시 신청하면 새 행이 아니라 같은 행을 revision만 올려서 갱신한다.
CREATE TABLE IF NOT EXISTS book_add_requests (
  app          TEXT    NOT NULL,
  request_key  TEXT    NOT NULL,
  book_id      TEXT    NOT NULL,          -- 승인되면 클라이언트가 교재 목록에 병합할 때 쓰는 id (ADD 접두)
  owner        TEXT    NOT NULL,          -- 신청한 직원(staffId) 또는 'director'
  title        TEXT    NOT NULL,
  subject      TEXT,
  level        TEXT,
  vendor_name  TEXT,
  units        TEXT    NOT NULL DEFAULT '[]',  -- JSON. [{name, sections:[...]}]
  note         TEXT,
  content_hash TEXT    NOT NULL,          -- subject·level·vendor·units·note 해시 — 같은 내용 재신청 감지용
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
  request_data TEXT,
  PRIMARY KEY (app, request_key)
);
CREATE INDEX IF NOT EXISTS idx_book_add_requests_owner
  ON book_add_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_add_requests_status
  ON book_add_requests(app, status, updated_at);

-- 기존 교재(textbooks.json 정적 항목이든, book_add_requests로 승인 등록된 항목이든) 수정 신청.
-- 정적 파일은 앱에서 직접 못 고치므로, 여기서도 book_add_requests와 같은 방식을 쓴다:
-- 선생님이 "이렇게 고쳐 주세요"를 신청하면(request), 원장이 검토(review)해 승인해야
-- 실제 목록에 반영된다(클라이언트가 승인된 수정을 읽어와 해당 책 위에 덮어씌운다).
-- 원장이 직접 신청하면 검토 없이 바로 승인 상태로 등록된다.
-- 한 책(book_id)당 열려 있는 신청은 하나뿐 — 다시 제출하면 같은 행을 revision만 올려서 갱신한다.
CREATE TABLE IF NOT EXISTS book_edit_requests (
  app          TEXT    NOT NULL,
  request_key  TEXT    NOT NULL,
  book_id      TEXT    NOT NULL,          -- 수정 대상 교재 id (기존 BK.. 또는 승인된 ADD.. id)
  owner        TEXT    NOT NULL,          -- 신청한 직원(staffId) 또는 'director'
  title        TEXT    NOT NULL,          -- 최종 상태 스냅샷 — 항상 값이 있어야 함(교재명은 비울 수 없음)
  subject      TEXT,
  level        TEXT,
  vendor_name  TEXT,
  units        TEXT    NOT NULL DEFAULT '[]',  -- JSON. [{name, sections:[...]}]
  note         TEXT,
  content_hash TEXT    NOT NULL,
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
  UNIQUE (app, book_id)
);
CREATE INDEX IF NOT EXISTS idx_book_edit_requests_owner
  ON book_edit_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_edit_requests_status
  ON book_edit_requests(app, status, updated_at);

-- 보호자 연락처·발송 동의 원장. 전화번호는 GitHub Pages 정적 파일에 절대 올리지 않고
-- 여기 D1(비공개 서버 DB)에만 둔다. 원장(scope='all')만 넣고 고칠 수 있다.
CREATE TABLE IF NOT EXISTS guardian_contacts (
  app          TEXT    NOT NULL,
  student_name TEXT    NOT NULL,        -- private_rosters의 학생 이름과 동일 표기로 맞춘다
  phone        TEXT,                    -- 정규화된 숫자만(010########). 비어 있으면 미등록
  consent      INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0, 1)),  -- 보호자 알림 발송 동의
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT,
  PRIMARY KEY (app, student_name)
);

-- 이름 기반 guardian_contacts는 기존 데이터 확인·정리용으로만 남긴다. 실제 발송은
-- 동명이인·개명 오연결을 막기 위해 stable studentId PK를 가진 이 테이블만 읽는다.
CREATE TABLE IF NOT EXISTS guardian_contacts_by_student (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  student_id   TEXT    NOT NULL,
  student_name TEXT    NOT NULL,        -- 화면·감사용 스냅샷; 조회 키로 사용하지 않음
  phone        TEXT,
  consent      INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0, 1)),
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT,
  transport_call_allowed INTEGER NOT NULL DEFAULT 0 CHECK (transport_call_allowed IN (0,1)),
  transport_boarded_consent INTEGER NOT NULL DEFAULT 0 CHECK (transport_boarded_consent IN (0,1)),
  transport_dropped_consent INTEGER NOT NULL DEFAULT 0 CHECK (transport_dropped_consent IN (0,1)),
  transport_guardian_identity_hash TEXT CHECK (
    transport_guardian_identity_hash IS NULL OR (
      length(transport_guardian_identity_hash) = 64
      AND transport_guardian_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  transport_updated_at INTEGER NOT NULL DEFAULT 0,
  transport_updated_by TEXT,
  PRIMARY KEY (app, student_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_contacts_by_student_name
  ON guardian_contacts_by_student(app, student_name);

-- 아카플로우 학생번호와 WB stable studentId의 비공개 불변 연결.
-- 담당 강사명은 5계정 운영 때문에 식별값으로 저장하지 않는다.
CREATE TABLE IF NOT EXISTS acaflow_student_links (
  app                 TEXT    NOT NULL CHECK (app = 'task'),
  external_student_no TEXT    NOT NULL CHECK (
    length(external_student_no) BETWEEN 1 AND 128
    AND external_student_no NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  student_id          TEXT    NOT NULL,
  linked_at           INTEGER NOT NULL,
  linked_by           TEXT    NOT NULL,
  PRIMARY KEY (app, external_student_no),
  UNIQUE (app, student_id)
);
CREATE INDEX IF NOT EXISTS idx_acaflow_student_links_student
  ON acaflow_student_links(app, student_id);

-- 학부모 피드백 실제 발송 이력 — book_order_sends와 같은 골격
-- (예약→발송중→결과, 멱등키로 중복 발송 방지, 하루 발송 한도).
CREATE TABLE IF NOT EXISTS parent_feedback_sends (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  send_id              TEXT    NOT NULL,
  idempotency_key      TEXT    NOT NULL,
  feedback_request_key TEXT    NOT NULL,
  student_id           TEXT    NOT NULL,
  student_name         TEXT    NOT NULL,
  message_hash         TEXT    NOT NULL CHECK (length(message_hash) = 64),
  status               TEXT    NOT NULL CHECK (status IN (
    'reserved',
    'dispatching',
    'accepted',
    'rejected',
    'unknown'
  )),
  provider_group_id    TEXT,
  provider_message_id  TEXT,
  provider_status_code TEXT,
  safe_error_code      TEXT,
  created_at           INTEGER NOT NULL,
  dispatch_started_at  INTEGER,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_parent_feedback_sends_request
  ON parent_feedback_sends(app, feedback_request_key, updated_at);

-- 원생 명단과 학생별 교재 배정. GitHub Pages에 공개되는 정적 JSON 대신 D1에만 둔다.
-- teacherIds는 Worker가 개인 링크 응답을 서버에서 담당 학생으로 제한하는 기준이다.
CREATE TABLE IF NOT EXISTS private_rosters (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  data       TEXT    NOT NULL CHECK (json_valid(data) AND length(CAST(data AS BLOB)) <= 524288),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app)
);

-- 학생별 교재 출고·인계 원장. 이름·연락처는 저장하지 않고 현재 private_rosters의
-- stable assignment/student/book ID와 학생 표시명 해시를 매 요청 다시 대조한다.
CREATE TABLE IF NOT EXISTS book_issues (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  assignment_id         TEXT    NOT NULL,
  student_id            TEXT    NOT NULL,
  book_id               TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  status                TEXT    NOT NULL CHECK (status IN ('prepared','issued','handed','cancelled')),
  cycle                 INTEGER NOT NULL CHECK (cycle >= 1),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  prepared_at           INTEGER,
  prepared_by           TEXT,
  issued_at             INTEGER,
  issued_by             TEXT,
  handed_at             INTEGER,
  handed_by             TEXT,
  cancelled_at          INTEGER,
  cancelled_by          TEXT,
  cancel_reason         TEXT,
  reissue_reason        TEXT,
  history               TEXT    NOT NULL CHECK (json_valid(history)),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (app, assignment_id)
);
CREATE INDEX IF NOT EXISTS idx_book_issues_status
  ON book_issues(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_issues_student
  ON book_issues(app, student_id, updated_at);

-- 주문 교재의 수령·배부·아카등록 원장. 표시명·연락처 대신 주문 task의 stable studentId를 저장한다.
CREATE TABLE IF NOT EXISTS book_order_fulfillments (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  task_id               TEXT    NOT NULL,
  item_index            INTEGER NOT NULL CHECK (item_index >= 0),
  book_id               TEXT    NOT NULL,
  student_ids           TEXT    NOT NULL CHECK (json_valid(student_ids)),
  status                TEXT    NOT NULL CHECK (status IN ('teacher_received','student_handed','academy_registered')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  teacher_received_at   INTEGER,
  teacher_received_by   TEXT,
  student_handed_at     INTEGER,
  student_handed_by     TEXT,
  academy_registered_at INTEGER,
  academy_registered_by TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (app, task_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_book_order_fulfillments_status
  ON book_order_fulfillments(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_order_fulfillments_task
  ON book_order_fulfillments(app, task_id, updated_at);

-- 금액 없이 생성된 기존 주문 항목에 권당 금액을 한 번만 기록하는 보조 원장.
-- 주문 task의 봉인 데이터는 변경하지 않으며 표시명·연락처·학생 정보는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS book_order_item_prices (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  task_id      TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 1 AND 128 AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  item_index   INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 49),
  unit_price   INTEGER NOT NULL CHECK (unit_price BETWEEN 1 AND 10000000),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  created_by   TEXT    NOT NULL CHECK (
    length(created_by) BETWEEN 1 AND 128 AND created_by NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  PRIMARY KEY (app, task_id, item_index)
);

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_prices_no_update
BEFORE UPDATE ON book_order_item_prices
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_prices_no_delete
BEFORE DELETE ON book_order_item_prices
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_APPEND_ONLY');
END;

-- 승인된 금액 정정을 원기록과 분리해 한 번만 남기는 불변 원장.
CREATE TABLE IF NOT EXISTS book_order_item_price_corrections (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  task_id              TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 1 AND 128 AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  item_index           INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 49),
  previous_unit_price  INTEGER NOT NULL CHECK (previous_unit_price BETWEEN 1 AND 10000000),
  corrected_unit_price INTEGER NOT NULL CHECK (
    corrected_unit_price BETWEEN 1 AND 10000000 AND corrected_unit_price <> previous_unit_price
  ),
  reason_code          TEXT    NOT NULL CHECK (reason_code = 'director_amount_correction'),
  created_at           INTEGER NOT NULL CHECK (created_at > 0),
  created_by           TEXT    NOT NULL CHECK (
    length(created_by) BETWEEN 1 AND 128 AND created_by NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  PRIMARY KEY (app, task_id, item_index)
);

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_price_corrections_no_update
BEFORE UPDATE ON book_order_item_price_corrections
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_CORRECTION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_price_corrections_no_delete
BEFORE DELETE ON book_order_item_price_corrections
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_PRICE_CORRECTION_APPEND_ONLY');
END;

-- 새 주문 생성 시점의 학생 정체성 봉인. 이름 원문은 저장하지 않으며 과거 주문은 자동 이관하지 않는다.
CREATE TABLE IF NOT EXISTS book_order_student_snapshots (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  task_id               TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 12 AND 124 AND task_id GLOB 'ord_*'
    AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  item_index            INTEGER NOT NULL CHECK (item_index >= 0),
  owner_id              TEXT    NOT NULL CHECK (
    owner_id = '' OR (length(owner_id) BETWEEN 1 AND 128 AND owner_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  book_id               TEXT    NOT NULL CHECK (
    length(book_id) BETWEEN 1 AND 128 AND book_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  public_title          TEXT    NOT NULL CHECK (public_title = '주문 교재'),
  student_id            TEXT    NOT NULL CHECK (
    length(student_id) BETWEEN 1 AND 128 AND student_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  student_identity_hash TEXT    NOT NULL CHECK (
    length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  student_set_hash      TEXT    NOT NULL CHECK (
    length(student_set_hash) = 64 AND student_set_hash NOT GLOB '*[^a-f0-9]*'
  ),
  item_identity_hash    TEXT    NOT NULL CHECK (
    length(item_identity_hash) = 64 AND item_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  task_identity_hash    TEXT    NOT NULL CHECK (
    length(task_identity_hash) = 64 AND task_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  expected_item_count   INTEGER NOT NULL CHECK (expected_item_count BETWEEN 1 AND 50),
  expected_row_count    INTEGER NOT NULL CHECK (expected_row_count BETWEEN 1 AND 200),
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (app, task_id, item_index, student_id)
);
CREATE INDEX IF NOT EXISTS idx_book_order_student_snapshots_student
  ON book_order_student_snapshots(app, student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_book_order_student_snapshots_task
  ON book_order_student_snapshots(app, task_id, item_index);

-- 같은 학생·같은 교재의 미완료 주문을 DB 수준에서 하나로 제한한다.
CREATE TABLE IF NOT EXISTS book_order_active_targets (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  book_id    TEXT    NOT NULL,
  student_id TEXT    NOT NULL,
  task_id    TEXT    NOT NULL,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  created_at INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (app, task_id, item_index, student_id)
);
CREATE INDEX IF NOT EXISTS idx_book_order_active_targets_task
  ON book_order_active_targets(app, task_id, item_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_order_one_active_target
  ON book_order_active_targets(app, book_id, student_id) WHERE active=1;

CREATE TRIGGER IF NOT EXISTS trg_book_order_active_targets_no_delete
BEFORE DELETE ON book_order_active_targets
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ACTIVE_TARGET_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_active_targets_release_only
BEFORE UPDATE ON book_order_active_targets
WHEN NOT (
  OLD.active=1 AND NEW.active=0
  AND NEW.app IS OLD.app AND NEW.book_id IS OLD.book_id AND NEW.student_id IS OLD.student_id
  AND NEW.task_id IS OLD.task_id AND NEW.item_index IS OLD.item_index AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ACTIVE_TARGET_APPEND_ONLY');
END;

CREATE TABLE IF NOT EXISTS book_order_cancellations (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  task_id      TEXT    NOT NULL,
  cancelled_at INTEGER NOT NULL,
  PRIMARY KEY (app, task_id)
);

CREATE TRIGGER IF NOT EXISTS trg_book_order_snapshots_no_update
BEFORE UPDATE ON book_order_student_snapshots
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SNAPSHOT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_snapshots_no_delete
BEFORE DELETE ON book_order_student_snapshots
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SNAPSHOT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_snapshot_activate
AFTER INSERT ON book_order_student_snapshots
BEGIN
  INSERT INTO book_order_active_targets(app,book_id,student_id,task_id,item_index,created_at,active)
  VALUES(NEW.app,NEW.book_id,NEW.student_id,NEW.task_id,NEW.item_index,NEW.created_at,1);
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_fulfillment_deactivate_insert
AFTER INSERT ON book_order_fulfillments
WHEN NEW.status IN ('student_handed','academy_registered')
  AND json_valid(NEW.student_ids)
  AND (SELECT COUNT(*) FROM book_order_student_snapshots snapshot
       WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
         AND snapshot.book_id=NEW.book_id) = json_array_length(NEW.student_ids)
  AND NOT EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
      AND snapshot.book_id=NEW.book_id
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.student_ids) student WHERE student.value=snapshot.student_id)
  )
BEGIN
  UPDATE book_order_active_targets SET active=0
  WHERE app=NEW.app AND task_id=NEW.task_id AND item_index=NEW.item_index AND active=1;
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_fulfillment_deactivate_update
AFTER UPDATE OF status ON book_order_fulfillments
WHEN NEW.status IN ('student_handed','academy_registered')
  AND OLD.status NOT IN ('student_handed','academy_registered')
  AND json_valid(NEW.student_ids)
  AND (SELECT COUNT(*) FROM book_order_student_snapshots snapshot
       WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
         AND snapshot.book_id=NEW.book_id) = json_array_length(NEW.student_ids)
  AND NOT EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
      AND snapshot.book_id=NEW.book_id
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.student_ids) student WHERE student.value=snapshot.student_id)
  )
BEGIN
  UPDATE book_order_active_targets SET active=0
  WHERE app=NEW.app AND task_id=NEW.task_id AND item_index=NEW.item_index AND active=1;
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_cancellations_no_update
BEFORE UPDATE ON book_order_cancellations
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_CANCELLATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_cancellations_no_delete
BEFORE DELETE ON book_order_cancellations
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_CANCELLATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_sealed_task_update
BEFORE UPDATE OF data ON tasks
WHEN EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=OLD.app AND snapshot.task_id=OLD.id
  )
  AND NOT (
    COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
    AND json_extract(NEW.data, '$.deleted') = 1
    AND json_extract(NEW.data, '$.orderCancelledAt') = NEW.updated_at
    AND json_remove(NEW.data, '$.deleted', '$.updatedAt', '$.lastEditBy', '$.orderCancelledAt')
        = json_remove(OLD.data, '$.deleted', '$.updatedAt', '$.lastEditBy', '$.orderCancelledAt')
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SEALED');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_sealed_task_cancel_busy
BEFORE UPDATE OF data ON tasks
WHEN EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=OLD.app AND snapshot.task_id=OLD.id
  )
  AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  AND json_extract(NEW.data, '$.deleted') = 1
  AND (
    EXISTS (
      SELECT 1 FROM book_order_dispatch_lock dispatch
      WHERE dispatch.app=OLD.app AND dispatch.owner NOT LIKE 'cancel_%'
        AND dispatch.lease_until > CAST(json_extract(NEW.data, '$.orderCancelledAt') AS INTEGER)
    )
    OR EXISTS (
      SELECT 1 FROM book_order_sends send
      LEFT JOIN book_order_batch_items item
        ON item.app=send.app AND item.send_id=send.send_id
      WHERE send.app=OLD.app
        AND (item.task_id=OLD.id OR (send.task_id=OLD.id AND send.task_id LIKE 'ord_%'))
        AND send.status IN ('reserved','dispatching','accepted','unknown')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SEND_ACTIVE');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_sealed_task_cancel
AFTER UPDATE OF data ON tasks
WHEN EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.id
  )
  AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  AND json_extract(NEW.data, '$.deleted') = 1
BEGIN
  INSERT INTO book_order_cancellations(app, task_id, cancelled_at)
  VALUES(
    NEW.app,
    NEW.id,
    CAST(json_extract(NEW.data, '$.orderCancelledAt') AS INTEGER)
  );
  UPDATE book_order_active_targets SET active=0 WHERE app=NEW.app AND task_id=NEW.id AND active=1;
END;

-- 생성과 명단 수정이 엇갈려도 봉인된 학생 ID/이름/재원 상태가 바뀌지 않게 DB에서 직렬화한다.
-- 학생 전달 후에도 아카플로우 등록까지는 같은 정체성을 유지해야 한다.
CREATE TRIGGER IF NOT EXISTS trg_book_order_roster_identity_update
BEFORE UPDATE OF data ON private_rosters
WHEN OLD.app='task' AND EXISTS (
  SELECT 1 FROM book_order_student_snapshots snapshot
  WHERE snapshot.app=OLD.app
    AND NOT EXISTS (
      SELECT 1 FROM book_order_cancellations cancellation
      WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM book_order_fulfillments fulfillment
      WHERE fulfillment.app=snapshot.app AND fulfillment.task_id=snapshot.task_id
        AND fulfillment.item_index=snapshot.item_index AND fulfillment.book_id=snapshot.book_id
        AND fulfillment.status='academy_registered' AND json_valid(fulfillment.student_ids)
        AND (SELECT COUNT(*) FROM book_order_student_snapshots expected
             WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
               AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id)
            = json_array_length(fulfillment.student_ids)
        AND NOT EXISTS (
          SELECT 1 FROM book_order_student_snapshots expected
          WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
            AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fulfillment.student_ids) selected
              WHERE selected.value=expected.student_id
            )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(OLD.data, '$.roster.students') old_student
      JOIN json_each(NEW.data, '$.roster.students') new_student
        ON CAST(json_extract(new_student.value, '$.id') AS TEXT)=snapshot.student_id
      WHERE CAST(json_extract(old_student.value, '$.id') AS TEXT)=snapshot.student_id
        AND CAST(json_extract(new_student.value, '$.name') AS TEXT)
            = CAST(json_extract(old_student.value, '$.name') AS TEXT)
        AND (
          (
            CAST(json_extract(new_student.value, '$.start') AS TEXT) <= strftime('%Y-%m','now','+9 hours')
            AND (
              COALESCE(CAST(json_extract(new_student.value, '$.end') AS TEXT),'')=''
              OR CAST(json_extract(new_student.value, '$.end') AS TEXT) > strftime('%Y-%m','now','+9 hours')
            )
          )
          OR (
            CAST(json_extract(new_student.value, '$.start') AS TEXT)
                = CAST(json_extract(old_student.value, '$.start') AS TEXT)
            AND COALESCE(CAST(json_extract(new_student.value, '$.end') AS TEXT),'')
                = COALESCE(CAST(json_extract(old_student.value, '$.end') AS TEXT),'')
          )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_BOOK_ORDER_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_roster_identity_delete
BEFORE DELETE ON private_rosters
WHEN OLD.app='task' AND EXISTS (
  SELECT 1 FROM book_order_student_snapshots snapshot
  WHERE snapshot.app=OLD.app
    AND NOT EXISTS (
      SELECT 1 FROM book_order_cancellations cancellation
      WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM book_order_fulfillments fulfillment
      WHERE fulfillment.app=snapshot.app AND fulfillment.task_id=snapshot.task_id
        AND fulfillment.item_index=snapshot.item_index AND fulfillment.book_id=snapshot.book_id
        AND fulfillment.status='academy_registered' AND json_valid(fulfillment.student_ids)
        AND (SELECT COUNT(*) FROM book_order_student_snapshots expected
             WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
               AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id)
            = json_array_length(fulfillment.student_ids)
        AND NOT EXISTS (
          SELECT 1 FROM book_order_student_snapshots expected
          WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
            AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fulfillment.student_ids) selected
              WHERE selected.value=expected.student_id
            )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_BOOK_ORDER_CONFLICT');
END;

-- 차량 노선 설정. 전화·주소·보호자 정보는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS transport_configs (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  data       TEXT    NOT NULL CHECK (json_valid(data) AND length(CAST(data AS BLOB)) <= 524288),
  updated_at INTEGER NOT NULL,
  updated_by TEXT    NOT NULL,
  PRIMARY KEY (app)
);

-- row가 없으면 scheduled. 실제 상태가 생긴 학생만 날짜·노선·stable student ID로 저장한다.
CREATE TABLE IF NOT EXISTS transport_states (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  date        TEXT    NOT NULL,
  route_id    TEXT    NOT NULL,
  student_id  TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('scheduled','boarded','dropped','absent')),
  revision    INTEGER NOT NULL CHECK (revision >= 1),
  boarded_at  INTEGER,
  boarded_by  TEXT,
  dropped_at  INTEGER,
  dropped_by  TEXT,
  absent_at   INTEGER,
  absent_by   TEXT,
  history     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(history)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app, date, route_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_transport_states_day
  ON transport_states(app, date, status, route_id);
CREATE INDEX IF NOT EXISTS idx_transport_states_student
  ON transport_states(app, student_id, date);
CREATE INDEX IF NOT EXISTS idx_transport_states_unresolved
  ON transport_states(app, status, date, updated_at);
-- 차량 승차 상태와 명단·직원·노선 설정 사이의 불변식을 DB 쓰기 시점에 보장한다.
-- API의 사전 조회만으로는 동시 요청 사이에 상태가 바뀌는 TOCTOU 경쟁을 막을 수 없으므로,
-- 최종 쓰기와 같은 SQLite 트랜잭션 안에서 중단한다.

CREATE TRIGGER IF NOT EXISTS trg_transport_boarded_insert_guard
BEFORE INSERT ON transport_states
WHEN NEW.status = 'boarded'
BEGIN
  SELECT CASE WHEN NOT (
    COALESCE(length(NEW.date) = 10 AND strftime('%Y-%m-%d', NEW.date) = NEW.date, 0) = 1
    AND EXISTS (
      SELECT 1
      FROM private_rosters AS pr, json_each(pr.data, '$.roster.students') AS student
      WHERE pr.app = NEW.app
        AND json_extract(student.value, '$.id') = NEW.student_id
        AND json_extract(student.value, '$.start') <= substr(NEW.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(NEW.date, 1, 7)
        )
    )
    AND EXISTS (
      SELECT 1
      FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
      WHERE config.app = NEW.app
        AND json_extract(route.value, '$.id') = NEW.route_id
        AND json_extract(route.value, '$.active') = 1
        AND EXISTS (
          SELECT 1 FROM json_each(route.value, '$.days') AS day
          WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', NEW.date) AS INTEGER)
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(route.value, '$.stops') AS stop,
               json_each(stop.value, '$.studentIds') AS route_student
          WHERE route_student.value = NEW.student_id
        )
        AND EXISTS (
          SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
          WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
        )
        AND EXISTS (
          SELECT 1 FROM staff AS driver
          WHERE driver.app = NEW.app
            AND driver.id = json_extract(route.value, '$.driverId')
            AND CASE WHEN json_valid(driver.data) THEN
              json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
            ELSE 0 END
        )
    )
  ) THEN RAISE(ABORT, 'BOARDING_LOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_boarded_update_guard
BEFORE UPDATE ON transport_states
WHEN NEW.status = 'boarded'
BEGIN
  SELECT CASE WHEN NOT (
    COALESCE(length(NEW.date) = 10 AND strftime('%Y-%m-%d', NEW.date) = NEW.date, 0) = 1
    AND EXISTS (
      SELECT 1
      FROM private_rosters AS pr, json_each(pr.data, '$.roster.students') AS student
      WHERE pr.app = NEW.app
        AND json_extract(student.value, '$.id') = NEW.student_id
        AND json_extract(student.value, '$.start') <= substr(NEW.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(NEW.date, 1, 7)
        )
    )
    AND EXISTS (
      SELECT 1
      FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
      WHERE config.app = NEW.app
        AND json_extract(route.value, '$.id') = NEW.route_id
        AND json_extract(route.value, '$.active') = 1
        AND EXISTS (
          SELECT 1 FROM json_each(route.value, '$.days') AS day
          WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', NEW.date) AS INTEGER)
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(route.value, '$.stops') AS stop,
               json_each(stop.value, '$.studentIds') AS route_student
          WHERE route_student.value = NEW.student_id
        )
        AND EXISTS (
          SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
          WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
        )
        AND EXISTS (
          SELECT 1 FROM staff AS driver
          WHERE driver.app = NEW.app
            AND driver.id = json_extract(route.value, '$.driverId')
            AND CASE WHEN json_valid(driver.data) THEN
              json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
            ELSE 0 END
        )
    )
  ) THEN RAISE(ABORT, 'BOARDING_LOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_roster_insert_guard
BEFORE INSERT ON private_rosters
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = NEW.app AND state.status = 'boarded'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.data, '$.roster.students') AS student
      WHERE json_extract(student.value, '$.id') = state.student_id
        AND length(state.date) = 10
        AND strftime('%Y-%m-%d', state.date) = state.date
        AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_roster_update_guard
BEFORE UPDATE OF data ON private_rosters
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = NEW.app AND state.status = 'boarded'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.data, '$.roster.students') AS student
      WHERE json_extract(student.value, '$.id') = state.student_id
        AND length(state.date) = 10
        AND strftime('%Y-%m-%d', state.date) = state.date
        AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
        AND (
          COALESCE(json_extract(student.value, '$.end'), '') = ''
          OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_roster_delete_guard
BEFORE DELETE ON private_rosters
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = OLD.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

-- 설정 변경은 미하차 기록이 하나라도 남아 있으면 보수적으로 막는다. 미하차를 하차·인계
-- 또는 사유 있는 초기화로 먼저 정리하면 정상적으로 변경할 수 있다.
CREATE TRIGGER IF NOT EXISTS trg_transport_config_insert_guard
BEFORE INSERT ON transport_configs
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = NEW.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_config_update_guard
BEFORE UPDATE ON transport_configs
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = OLD.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_config_delete_guard
BEFORE DELETE ON transport_configs
WHEN EXISTS (
  SELECT 1 FROM transport_states AS state
  WHERE state.app = OLD.app AND state.status = 'boarded'
)
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

-- 정상 노선에서는 해당 기사만 막고, 설정/차량/학생/요일/기사 중 하나라도 손상된
-- 고아 미하차 기록이 있으면 어떤 활성 직원의 비활성화도 fail-closed로 막는다.
CREATE TRIGGER IF NOT EXISTS trg_transport_staff_update_guard
BEFORE UPDATE OF data ON staff
WHEN OLD.app = 'task'
  AND CASE WHEN json_valid(OLD.data) THEN
    json_type(OLD.data) = 'object' AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  ELSE 0 END
  AND CASE WHEN json_valid(NEW.data) THEN
    json_type(NEW.data) <> 'object' OR COALESCE(json_extract(NEW.data, '$.deleted'), 0) <> 0
  ELSE 1 END
  AND EXISTS (
    SELECT 1
    FROM transport_states AS state
    WHERE state.app = OLD.app AND state.status = 'boarded'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.active') = 1
            AND EXISTS (
              SELECT 1 FROM json_each(route.value, '$.days') AS day
              WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', state.date) AS INTEGER)
            )
            AND EXISTS (
              SELECT 1
              FROM json_each(route.value, '$.stops') AS stop,
                   json_each(stop.value, '$.studentIds') AS route_student
              WHERE route_student.value = state.student_id
            )
            AND EXISTS (
              SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
              WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
            )
            AND EXISTS (
              SELECT 1 FROM staff AS driver
              WHERE driver.app = state.app
                AND driver.id = json_extract(route.value, '$.driverId')
                AND CASE WHEN json_valid(driver.data) THEN
                  json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
                ELSE 0 END
            )
            AND EXISTS (
              SELECT 1
              FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
              WHERE roster.app = state.app
                AND json_extract(student.value, '$.id') = state.student_id
                AND length(state.date) = 10
                AND strftime('%Y-%m-%d', state.date) = state.date
                AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
                AND (
                  COALESCE(json_extract(student.value, '$.end'), '') = ''
                  OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
                )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.driverId') = OLD.id
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_staff_delete_guard
BEFORE DELETE ON staff
WHEN OLD.app = 'task'
  AND CASE WHEN json_valid(OLD.data) THEN
    json_type(OLD.data) = 'object' AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  ELSE 0 END
  AND EXISTS (
    SELECT 1
    FROM transport_states AS state
    WHERE state.app = OLD.app AND state.status = 'boarded'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.active') = 1
            AND EXISTS (
              SELECT 1 FROM json_each(route.value, '$.days') AS day
              WHERE CAST(day.value AS INTEGER) = CAST(strftime('%w', state.date) AS INTEGER)
            )
            AND EXISTS (
              SELECT 1
              FROM json_each(route.value, '$.stops') AS stop,
                   json_each(stop.value, '$.studentIds') AS route_student
              WHERE route_student.value = state.student_id
            )
            AND EXISTS (
              SELECT 1 FROM json_each(config.data, '$.vehicles') AS vehicle
              WHERE json_extract(vehicle.value, '$.id') = json_extract(route.value, '$.vehicleId')
            )
            AND EXISTS (
              SELECT 1 FROM staff AS driver
              WHERE driver.app = state.app
                AND driver.id = json_extract(route.value, '$.driverId')
                AND CASE WHEN json_valid(driver.data) THEN
                  json_type(driver.data) = 'object' AND COALESCE(json_extract(driver.data, '$.deleted'), 0) = 0
                ELSE 0 END
            )
            AND EXISTS (
              SELECT 1
              FROM private_rosters AS roster, json_each(roster.data, '$.roster.students') AS student
              WHERE roster.app = state.app
                AND json_extract(student.value, '$.id') = state.student_id
                AND length(state.date) = 10
                AND strftime('%Y-%m-%d', state.date) = state.date
                AND json_extract(student.value, '$.start') <= substr(state.date, 1, 7)
                AND (
                  COALESCE(json_extract(student.value, '$.end'), '') = ''
                  OR json_extract(student.value, '$.end') > substr(state.date, 1, 7)
                )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM transport_configs AS config, json_each(config.data, '$.routes') AS route
          WHERE config.app = state.app
            AND json_extract(route.value, '$.id') = state.route_id
            AND json_extract(route.value, '$.driverId') = OLD.id
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'BOARDING_LOCK');
END;

-- 구형 Pages나 generic /sync 경로로 직원을 비활성화해도 기존 개인 링크가 나중에
-- 직원 재등록과 함께 되살아나지 않도록, 직원 tombstone과 같은 statement에서 해지한다.
CREATE TRIGGER IF NOT EXISTS trg_transport_staff_revoke_after_update
AFTER UPDATE OF data ON staff
WHEN OLD.app = 'task'
  AND CASE WHEN json_valid(OLD.data) THEN
    json_type(OLD.data) = 'object' AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  ELSE 0 END
  AND CASE WHEN json_valid(NEW.data) THEN
    json_type(NEW.data) <> 'object' OR COALESCE(json_extract(NEW.data, '$.deleted'), 0) <> 0
  ELSE 1 END
BEGIN
  UPDATE tokens SET revoked = 1 WHERE app = NEW.app AND staff_id = NEW.id;
  UPDATE bootstrap_codes SET revoked = 1 WHERE app = NEW.app AND staff_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_transport_staff_revoke_after_delete
AFTER DELETE ON staff
WHEN OLD.app = 'task'
BEGIN
  UPDATE tokens SET revoked = 1 WHERE app = OLD.app AND staff_id = OLD.id;
  UPDATE bootstrap_codes SET revoked = 1 WHERE app = OLD.app AND staff_id = OLD.id;
END;

-- 모든 학생의 결석 수업과 보강 일정을 잇는 운영 원장.
-- 이름·전화·보호자·상담 메모는 저장하지 않고 stable ID만 보관한다.
CREATE TABLE IF NOT EXISTS makeup_cases (
  app                         TEXT    NOT NULL CHECK (app = 'task'),
  case_id                     TEXT    NOT NULL,
  student_id                  TEXT    NOT NULL,
  source_task_id              TEXT    NOT NULL,
  source_date                 TEXT    NOT NULL CHECK (
    length(source_date) = 10 AND strftime('%Y-%m-%d', source_date) = source_date
  ),
  source_teacher_id           TEXT    NOT NULL,
  consumption_group_id        TEXT    NOT NULL,
  status                      TEXT    NOT NULL CHECK (status IN (
    'review_pending','reviewed','awaiting_parent','confirmed','completed','cancelled'
  )),
  revision                    INTEGER NOT NULL CHECK (revision >= 1),
  proposed_start_at           TEXT,
  proposed_end_at             TEXT,
  proposed_staff_id           TEXT,
  confirmed_start_at          TEXT,
  confirmed_end_at            TEXT,
  confirmed_staff_id          TEXT,
  completed_at                INTEGER,
  completed_by                TEXT,
  cancelled_at                INTEGER,
  cancelled_by                TEXT,
  reason                      TEXT CHECK (reason IS NULL OR reason IN (
    'policy_ineligible','already_resolved','parent_declined',
    'schedule_unavailable','student_inactive','other'
  )),
  notification_needed         INTEGER NOT NULL DEFAULT 0 CHECK (notification_needed IN (0,1)),
  notification_event          TEXT,
  notification_event_revision INTEGER NOT NULL DEFAULT 0 CHECK (notification_event_revision >= 0),
  history                     TEXT    NOT NULL CHECK (json_valid(history)),
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  PRIMARY KEY (app, case_id),
  UNIQUE (app, source_task_id, source_date),
  UNIQUE (app, consumption_group_id),
  CHECK (
    (proposed_start_at IS NULL AND proposed_end_at IS NULL AND proposed_staff_id IS NULL)
    OR (
      proposed_start_at IS NOT NULL AND proposed_end_at IS NOT NULL AND proposed_staff_id IS NOT NULL
      AND length(proposed_start_at) = 25 AND length(proposed_end_at) = 25
      AND substr(proposed_start_at, 11, 1) = 'T' AND substr(proposed_end_at, 11, 1) = 'T'
      AND substr(proposed_start_at, 20, 6) = '+09:00' AND substr(proposed_end_at, 20, 6) = '+09:00'
      AND substr(proposed_start_at, 1, 10) = substr(proposed_end_at, 1, 10)
      AND proposed_start_at < proposed_end_at
    )
  ),
  CHECK (
    (confirmed_start_at IS NULL AND confirmed_end_at IS NULL AND confirmed_staff_id IS NULL)
    OR (
      confirmed_start_at IS NOT NULL AND confirmed_end_at IS NOT NULL AND confirmed_staff_id IS NOT NULL
      AND length(confirmed_start_at) = 25 AND length(confirmed_end_at) = 25
      AND substr(confirmed_start_at, 11, 1) = 'T' AND substr(confirmed_end_at, 11, 1) = 'T'
      AND substr(confirmed_start_at, 20, 6) = '+09:00' AND substr(confirmed_end_at, 20, 6) = '+09:00'
      AND substr(confirmed_start_at, 1, 10) = substr(confirmed_end_at, 1, 10)
      AND confirmed_start_at < confirmed_end_at
    )
  ),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
  CHECK (
    notification_needed = 0 OR (
      notification_event IN ('proposal','confirmed','cancelled')
      AND notification_event_revision >= 1 AND notification_event_revision <= revision
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_makeup_status
  ON makeup_cases(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_makeup_student
  ON makeup_cases(app, student_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_makeup_staff_time
  ON makeup_cases(app, confirmed_staff_id, confirmed_start_at, confirmed_end_at);

CREATE TRIGGER IF NOT EXISTS trg_makeup_confirmed_time_insert
BEFORE INSERT ON makeup_cases
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM makeup_cases AS other
  WHERE other.app = NEW.app AND other.status = 'confirmed' AND other.case_id <> NEW.case_id
    AND other.confirmed_start_at < NEW.confirmed_end_at
    AND NEW.confirmed_start_at < other.confirmed_end_at
    AND (other.student_id = NEW.student_id OR other.confirmed_staff_id = NEW.confirmed_staff_id)
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_TIME_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_makeup_confirmed_time_update
BEFORE UPDATE OF status,confirmed_start_at,confirmed_end_at,confirmed_staff_id,student_id ON makeup_cases
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM makeup_cases AS other
  WHERE other.app = NEW.app AND other.status = 'confirmed' AND other.case_id <> NEW.case_id
    AND other.confirmed_start_at < NEW.confirmed_end_at
    AND NEW.confirmed_start_at < other.confirmed_end_at
    AND (other.student_id = NEW.student_id OR other.confirmed_staff_id = NEW.confirmed_staff_id)
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_TIME_CONFLICT');
END;

-- API 실수나 직접 쓰기로도 원장/타 담당자가 완료자로 기록될 수 없다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_complete_assignee
BEFORE UPDATE OF status,completed_by ON makeup_cases
WHEN NEW.status = 'completed' AND (
  OLD.status <> 'confirmed'
  OR NEW.confirmed_staff_id IS NOT OLD.confirmed_staff_id
  OR OLD.confirmed_staff_id IS NULL
  OR NEW.completed_by IS NULL
  OR NEW.completed_by <> OLD.confirmed_staff_id
)
BEGIN
  SELECT RAISE(ABORT, 'MAKEUP_COMPLETE_ASSIGNEE');
END;

-- 지정한 학생·수업에만 여는 회차권. 월제 수업은 행을 만들지 않는다.
-- 금액·결제·연락처·자유 메모는 저장하지 않고 수업 사용 횟수만 관리한다.
CREATE TABLE IF NOT EXISTS session_packs (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  pack_id               TEXT    NOT NULL,
  student_id            TEXT    NOT NULL,
  lesson_task_id        TEXT    NOT NULL,
  task_owner            TEXT    NOT NULL,
  lesson_assignment_key TEXT    NOT NULL CHECK (length(lesson_assignment_key) BETWEEN 1 AND 256),
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  task_identity_hash    TEXT    NOT NULL CHECK (length(task_identity_hash) = 64),
  total_sessions        INTEGER NOT NULL CHECK (total_sessions BETWEEN 1 AND 200),
  valid_from            TEXT    NOT NULL CHECK (
    length(valid_from) = 10 AND strftime('%Y-%m-%d', valid_from) = valid_from
  ),
  expires_on            TEXT    NOT NULL CHECK (
    length(expires_on) = 10 AND strftime('%Y-%m-%d', expires_on) = expires_on
    AND expires_on >= valid_from
  ),
  deduction_policy      TEXT    NOT NULL CHECK (deduction_policy = 'recommended_v1'),
  status                TEXT    NOT NULL CHECK (status IN ('active','closed')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  created_at            INTEGER NOT NULL,
  created_by            TEXT    NOT NULL,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT    NOT NULL,
  closed_at             INTEGER,
  closed_by             TEXT,
  PRIMARY KEY (app, pack_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_packs_one_active
  ON session_packs(app, student_id, lesson_task_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_session_packs_student
  ON session_packs(app, student_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_packs_owner
  ON session_packs(app, task_owner, updated_at);

CREATE TABLE IF NOT EXISTS session_pack_usage (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  entry_id             TEXT    NOT NULL,
  pack_id              TEXT    NOT NULL,
  expected_revision    INTEGER NOT NULL CHECK (expected_revision >= 1),
  source_type          TEXT    NOT NULL CHECK (source_type IN ('regular','makeup','adjustment')),
  source_ref           TEXT    NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  source_date          TEXT    CHECK (
    source_date IS NULL OR (length(source_date) = 10 AND strftime('%Y-%m-%d', source_date) = source_date)
  ),
  attendance_event     TEXT    NOT NULL CHECK (attendance_event IN (
    'present','late','approved_absence','same_day','no_show','academy_cancel',
    'makeup_completed','manual_adjustment'
  )),
  delta                INTEGER NOT NULL CHECK (delta BETWEEN -200 AND 200),
  consumption_group_id TEXT,
  reason_code          TEXT,
  actor_id             TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (app, entry_id),
  UNIQUE (app, source_type, source_ref),
  FOREIGN KEY (app, pack_id) REFERENCES session_packs(app, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_session_pack_usage_pack
  ON session_pack_usage(app, pack_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_pack_usage_one_consumption
  ON session_pack_usage(app, pack_id, consumption_group_id)
  WHERE delta > 0 AND consumption_group_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_guard
BEFORE INSERT ON session_pack_usage
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id AND pack.status = 'active'
  ) THEN RAISE(ABORT, 'SESSION_PACK_NOT_ACTIVE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND pack.revision = NEW.expected_revision
  ) THEN RAISE(ABORT, 'SESSION_PACK_REVISION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM session_packs AS pack
    JOIN tasks AS task
      ON task.app = pack.app AND task.id = pack.lesson_task_id
    JOIN staff AS teacher
      ON teacher.app = pack.app AND teacher.id = pack.task_owner
    JOIN private_rosters AS roster
      ON roster.app = pack.app
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND task.owner = pack.task_owner
      AND json_valid(task.data)
      AND json_type(task.data) = 'object'
      AND json_extract(task.data, '$.id') = pack.lesson_task_id
      AND json_extract(task.data, '$.studentId') = pack.student_id
      AND json_extract(task.data, '$.staffId') = pack.task_owner
      AND COALESCE(json_extract(task.data, '$.deleted'), 0) = 0
      AND (
        json_extract(task.data, '$.taskKind') = 'lesson_instruction'
        OR COALESCE(json_extract(task.data, '$.lessonFormVersion'), 0) <> 0
        OR COALESCE(json_extract(task.data, '$.intakeVersion'), 0) <> 0
      )
      AND CAST(COALESCE(
        NULLIF(json_extract(task.data, '$.lessonAssignmentKey'), ''),
        NULLIF(json_extract(task.data, '$.lessonDedupeKey'), ''),
        json_extract(task.data, '$.id')
      ) AS TEXT) = pack.lesson_assignment_key
      AND json_valid(teacher.data)
      AND json_type(teacher.data) = 'object'
      AND COALESCE(json_extract(teacher.data, '$.deleted'), 0) = 0
      AND json_valid(roster.data)
      AND json_type(roster.data) = 'object'
      AND EXISTS (
        SELECT 1 FROM json_each(roster.data, '$.roster.students') AS student
        WHERE json_type(student.value) = 'object'
          AND json_extract(student.value, '$.id') = pack.student_id
          AND json_extract(student.value, '$.start') <= strftime('%Y-%m', 'now', '+9 hours')
          AND (
            COALESCE(json_extract(student.value, '$.end'), '') = ''
            OR strftime('%Y-%m', 'now', '+9 hours') < json_extract(student.value, '$.end')
          )
          AND json_type(student.value, '$.teacherIds') = 'array'
          AND EXISTS (
            SELECT 1 FROM json_each(student.value, '$.teacherIds') AS assigned
            WHERE CAST(assigned.value AS TEXT) = pack.task_owner
          )
      )
  ) THEN RAISE(ABORT, 'SESSION_PACK_IDENTITY_MISMATCH') END;
  SELECT CASE WHEN NEW.source_type <> 'adjustment' AND NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND NEW.source_date BETWEEN pack.valid_from AND pack.expires_on
  ) THEN RAISE(ABORT, 'SESSION_PACK_DATE_OUT_OF_RANGE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM session_packs AS pack
    WHERE pack.app = NEW.app AND pack.pack_id = NEW.pack_id
      AND (SELECT COALESCE(SUM(delta), 0) FROM session_pack_usage
           WHERE app = NEW.app AND pack_id = NEW.pack_id) + NEW.delta
          BETWEEN 0 AND pack.total_sessions
  ) THEN RAISE(ABORT, 'SESSION_PACK_BALANCE_INVALID') END;
END;

-- 보강 완료 UPDATE 바로 다음 문장만 makeup 사용 원장을 쓸 수 있다. D1 batch에서
-- 첫 CAS가 0건이면 changes()가 0이므로 두 번째 문장이 실패하고 전체 batch가 롤백된다.
CREATE TRIGGER IF NOT EXISTS trg_session_pack_makeup_usage_guard
BEFORE INSERT ON session_pack_usage
WHEN NEW.source_type = 'makeup' AND NEW.reason_code = 'makeup_atomic_v1'
BEGIN
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'MAKEUP_REVISION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM makeup_cases AS item
    WHERE item.app = NEW.app AND item.case_id = NEW.source_ref
      AND item.status = 'completed'
      AND item.consumption_group_id = NEW.consumption_group_id
      AND item.completed_by = NEW.actor_id
  ) THEN RAISE(ABORT, 'MAKEUP_USAGE_EVIDENCE_INVALID') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_revision
AFTER INSERT ON session_pack_usage
BEGIN
  UPDATE session_packs
  SET revision = revision + 1, updated_at = NEW.created_at, updated_by = NEW.actor_id
  WHERE app = NEW.app AND pack_id = NEW.pack_id AND revision = NEW.expected_revision;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_no_update
BEFORE UPDATE ON session_pack_usage
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_usage_no_delete
BEFORE DELETE ON session_pack_usage
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_immutable
BEFORE UPDATE ON session_packs
WHEN NEW.app IS NOT OLD.app
  OR NEW.pack_id IS NOT OLD.pack_id
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.lesson_task_id IS NOT OLD.lesson_task_id
  OR NEW.task_owner IS NOT OLD.task_owner
  OR NEW.lesson_assignment_key IS NOT OLD.lesson_assignment_key
  OR NEW.student_identity_hash IS NOT OLD.student_identity_hash
  OR NEW.task_identity_hash IS NOT OLD.task_identity_hash
  OR NEW.total_sessions IS NOT OLD.total_sessions
  OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.expires_on IS NOT OLD.expires_on
  OR NEW.deduction_policy IS NOT OLD.deduction_policy
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_transition
BEFORE UPDATE ON session_packs
WHEN NEW.revision <> OLD.revision + 1
  OR NEW.updated_at < OLD.updated_at
  OR NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'active' AND NEW.status = 'closed')
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_INVALID_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_pack_no_delete
BEFORE DELETE ON session_packs
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PACK_APPEND_ONLY');
END;

-- 보호자 웹앱 초대·세션·정형 응답.
-- 원본 초대코드/세션토큰/전화번호는 저장하지 않는다. 한 세션은 한 stable studentId만 본다.
CREATE TABLE IF NOT EXISTS guardian_portal_access (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  student_id  TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  guardian_identity_hash TEXT CHECK (
    guardian_identity_hash IS NULL OR (
      length(guardian_identity_hash) = 64 AND guardian_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  accepted_at INTEGER,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT    NOT NULL,
  scope_version INTEGER NOT NULL DEFAULT 1 CHECK (scope_version >= 1),
  CHECK (enabled = 0 OR guardian_identity_hash IS NOT NULL),
  PRIMARY KEY (app, student_id)
);

CREATE TABLE IF NOT EXISTS guardian_portal_codes (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  code_hash    TEXT    NOT NULL CHECK (length(code_hash) = 71 AND code_hash LIKE 'sha256:%'),
  student_id   TEXT    NOT NULL,
  guardian_identity_hash TEXT NOT NULL CHECK (length(guardian_identity_hash) = 64),
  access_updated_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  issued_by    TEXT    NOT NULL,
  claim_id     TEXT CHECK (claim_id IS NULL OR length(claim_id) = 48),
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_guardian_portal_codes_student
  ON guardian_portal_codes(app, student_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS guardian_portal_sessions (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  token_hash   TEXT    NOT NULL CHECK (length(token_hash) = 71 AND token_hash LIKE 'sha256:%'),
  student_id   TEXT    NOT NULL,
  guardian_identity_hash TEXT NOT NULL CHECK (length(guardian_identity_hash) = 64),
  access_updated_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_guardian_portal_sessions_student
  ON guardian_portal_sessions(app, student_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS guardian_portal_responses (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  response_id  TEXT    NOT NULL,
  student_id   TEXT    NOT NULL,
  object_type  TEXT    NOT NULL CHECK (object_type = 'makeup'),
  object_id    TEXT    NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  response     TEXT    NOT NULL CHECK (response IN ('accept', 'decline')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (app, response_id),
  UNIQUE (app, object_type, object_id, student_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_guardian_portal_responses_object
  ON guardian_portal_responses(app, object_type, object_id, created_at);

-- 철회 또는 동의 대상 보호자 identity 변경은 기존 초대·세션을 같은 DB
-- 쓰기 안에서 막는다. 휴대폰 번호가 바뀌면 새 보호자에게 기존 동의를 승계하지 않는다.
CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_access_revoke
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

-- 보호자 응답의 사전 SELECT와 INSERT 사이에 관리자가 일정을 바꾸는 경합도 DB가 막는다.
CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_response_current
BEFORE INSERT ON guardian_portal_responses
WHEN NOT EXISTS (
  SELECT 1 FROM makeup_cases item
  WHERE item.app=NEW.app AND item.case_id=NEW.object_id AND item.student_id=NEW.student_id
    AND item.status='awaiting_parent' AND item.revision=NEW.revision
)
BEGIN
  SELECT RAISE(ABORT, 'PARENT_RESPONSE_STALE');
END;

-- decline이 먼저 저장됐으면 관리자 confirm이 같은 revision을 확정하지 못한다.
CREATE TRIGGER IF NOT EXISTS trg_makeup_parent_decline_confirm
BEFORE UPDATE OF status ON makeup_cases
WHEN OLD.status='awaiting_parent' AND NEW.status='confirmed' AND EXISTS (
  SELECT 1 FROM guardian_portal_responses response
  WHERE response.app=OLD.app AND response.object_type='makeup' AND response.object_id=OLD.case_id
    AND response.student_id=OLD.student_id AND response.revision=OLD.revision AND response.response='decline'
)
BEGIN
  SELECT RAISE(ABORT, 'PARENT_DECLINED');
END;

-- 보강·회차 운영 알림톡은 기존 수업 피드백 동의를 재사용하지 않는다.
CREATE TABLE IF NOT EXISTS guardian_ops_notification_consents (
  app                    TEXT    NOT NULL CHECK (app = 'task'),
  student_id             TEXT    NOT NULL,
  scope                  TEXT    NOT NULL CHECK (scope IN ('makeup','session')),
  consent                INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0,1)),
  guardian_identity_hash TEXT    NOT NULL CHECK (
    length(guardian_identity_hash) = 64 AND guardian_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at             INTEGER NOT NULL,
  updated_by             TEXT    NOT NULL,
  PRIMARY KEY (app, student_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_consents_scope
  ON guardian_ops_notification_consents(app, scope, consent, student_id);

CREATE TABLE IF NOT EXISTS guardian_ops_notification_sends (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  send_id         TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL CHECK (length(idempotency_key) = 64),
  event_type      TEXT    NOT NULL CHECK (event_type IN (
    'makeup_proposal','makeup_confirmed','makeup_cancelled','session_balance'
  )),
  source_id       TEXT    NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  student_id      TEXT    NOT NULL,
  variables_hash  TEXT    NOT NULL CHECK (length(variables_hash) = 64),
  template_id     TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL CHECK (attempt_no >= 1),
  created_at      INTEGER NOT NULL,
  created_by      TEXT    NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  UNIQUE (app, event_type, source_id, source_revision, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_sends_target
  ON guardian_ops_notification_sends(app, event_type, source_id, source_revision, attempt_no);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_sends_day
  ON guardian_ops_notification_sends(app, created_at);

CREATE TABLE IF NOT EXISTS guardian_ops_notification_send_events (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  ledger_event_id      TEXT    NOT NULL,
  send_id              TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('accepted','rejected','unknown')),
  provider_group_id    TEXT,
  provider_message_id  TEXT,
  provider_status_code TEXT,
  safe_error_code      TEXT,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (app, ledger_event_id),
  UNIQUE (app, send_id),
  FOREIGN KEY (app, send_id) REFERENCES guardian_ops_notification_sends(app, send_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_ops_events_send
  ON guardian_ops_notification_send_events(app, send_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_ops_events_provider_message
  ON guardian_ops_notification_send_events(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_sends_no_update
BEFORE UPDATE ON guardian_ops_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_sends_no_delete
BEFORE DELETE ON guardian_ops_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_events_no_update
BEFORE UPDATE ON guardian_ops_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_EVENT_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_ops_events_no_delete
BEFORE DELETE ON guardian_ops_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_OPS_EVENT_LEDGER_APPEND_ONLY');
END;

-- 차량 승·하차 알림톡은 전화번호·문구 원문 없이 예약과 결과만 append-only로 보관한다.
CREATE TABLE IF NOT EXISTS transport_notification_sends (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  send_id         TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL CHECK (length(idempotency_key) = 64),
  event_state     TEXT    NOT NULL CHECK (event_state IN ('boarded','dropped')),
  transport_date  TEXT    NOT NULL CHECK (
    COALESCE(length(transport_date) = 10 AND
      strftime('%Y-%m-%d', transport_date) = transport_date, 0) = 1
  ),
  route_id        TEXT    NOT NULL,
  student_id      TEXT    NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  variables_hash  TEXT    NOT NULL CHECK (length(variables_hash) = 64),
  template_id     TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      TEXT    NOT NULL,
  PRIMARY KEY (app, send_id),
  UNIQUE (app, idempotency_key),
  UNIQUE (app, transport_date, route_id, student_id, event_state, source_revision)
);
CREATE INDEX IF NOT EXISTS idx_transport_notification_sends_day
  ON transport_notification_sends(app, transport_date, route_id, created_at);

CREATE TABLE IF NOT EXISTS transport_notification_send_events (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  ledger_event_id      TEXT    NOT NULL,
  send_id              TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('accepted','rejected','unknown')),
  provider_group_id    TEXT,
  provider_message_id  TEXT,
  provider_status_code TEXT,
  safe_error_code      TEXT,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (app, ledger_event_id),
  UNIQUE (app, send_id),
  FOREIGN KEY (app, send_id) REFERENCES transport_notification_sends(app, send_id)
);
CREATE INDEX IF NOT EXISTS idx_transport_notification_events_send
  ON transport_notification_send_events(app, send_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_notification_events_provider_message
  ON transport_notification_send_events(app, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- 개인 링크 선생님이 자기 학생을 배정 요청하고, 원장 승인만 실제 원생 담당자 목록을 바꾼다.
CREATE TABLE IF NOT EXISTS lesson_assignment_requests (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  request_key  TEXT    NOT NULL,
  staff_id     TEXT    NOT NULL,
  student_name TEXT    NOT NULL,
  grade        TEXT    NOT NULL,
  student_id   TEXT,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  status       TEXT    NOT NULL CHECK (status IN ('approval_waiting','approved','rejected','cancelled')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  reviewed_at  INTEGER,
  reviewed_by  TEXT,
  review_note  TEXT,
  PRIMARY KEY (app, request_key)
);
CREATE INDEX IF NOT EXISTS idx_lesson_assignment_requests_staff
  ON lesson_assignment_requests(app, staff_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_lesson_assignment_requests_status
  ON lesson_assignment_requests(app, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_assignment_requests_open_student
  ON lesson_assignment_requests(app, staff_id, student_id)
  WHERE status='approval_waiting' AND student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_assignment_requests_open_legacy
  ON lesson_assignment_requests(app, staff_id, student_name, grade)
  WHERE status='approval_waiting' AND student_id IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_transport_notification_sends_no_update
BEFORE UPDATE ON transport_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_notification_sends_no_delete
BEFORE DELETE ON transport_notification_sends
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_SEND_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_notification_events_no_update
BEFORE UPDATE ON transport_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_EVENT_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_notification_events_no_delete
BEFORE DELETE ON transport_notification_send_events
BEGIN
  SELECT RAISE(ABORT, 'TRANSPORT_NOTIFICATION_EVENT_LEDGER_APPEND_ONLY');
END;

-- 보호자 공개용 숙제·준비물은 내부 checks/task 메모와 물리적으로 분리한다.
-- 현재 projection은 CAS로 고치되 모든 공개/수정/철회 이력은 append-only event로 남긴다.
CREATE TABLE IF NOT EXISTS guardian_lesson_publications (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  publication_id        TEXT    NOT NULL,
  source_task_id        TEXT    NOT NULL,
  task_owner            TEXT    NOT NULL,
  student_id            TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  task_identity_hash    TEXT    NOT NULL CHECK (length(task_identity_hash) = 64),
  lesson_date           TEXT    NOT NULL CHECK (
    COALESCE(length(lesson_date) = 10 AND strftime('%Y-%m-%d', lesson_date) = lesson_date, 0) = 1
  ),
  status                TEXT    NOT NULL CHECK (status IN ('published','withdrawn')),
  public_homework       TEXT    NOT NULL CHECK (length(public_homework) <= 500),
  public_readiness      TEXT    NOT NULL CHECK (length(public_readiness) <= 500),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT    NOT NULL,
  student_visible       INTEGER NOT NULL DEFAULT 0 CHECK (student_visible IN (0,1)),
  CHECK (
    (status = 'published' AND (length(public_homework) > 0 OR length(public_readiness) > 0))
    OR (status = 'withdrawn' AND public_homework = '' AND public_readiness = '')
  ),
  PRIMARY KEY (app, publication_id),
  UNIQUE (app, task_identity_hash, lesson_date)
);
CREATE INDEX IF NOT EXISTS idx_guardian_lesson_publications_student
  ON guardian_lesson_publications(app, student_id, lesson_date, status);
CREATE INDEX IF NOT EXISTS idx_guardian_lesson_publications_owner
  ON guardian_lesson_publications(app, task_owner, lesson_date);

CREATE TABLE IF NOT EXISTS guardian_lesson_publication_events (
  app              TEXT    NOT NULL CHECK (app = 'task'),
  event_id         TEXT    NOT NULL,
  publication_id   TEXT    NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  event_type       TEXT    NOT NULL CHECK (event_type IN ('published','updated','withdrawn')),
  public_homework  TEXT    NOT NULL CHECK (length(public_homework) <= 500),
  public_readiness TEXT    NOT NULL CHECK (length(public_readiness) <= 500),
  created_at       INTEGER NOT NULL,
  created_by       TEXT    NOT NULL,
  student_visible  INTEGER NOT NULL DEFAULT 0 CHECK (student_visible IN (0,1)),
  PRIMARY KEY (app, event_id),
  UNIQUE (app, publication_id, revision),
  FOREIGN KEY (app, publication_id) REFERENCES guardian_lesson_publications(app, publication_id)
);

CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publications_update
BEFORE UPDATE ON guardian_lesson_publications
WHEN NEW.publication_id IS NOT OLD.publication_id
  OR NEW.source_task_id IS NOT OLD.source_task_id
  OR NEW.task_owner IS NOT OLD.task_owner
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.student_identity_hash IS NOT OLD.student_identity_hash
  OR NEW.task_identity_hash IS NOT OLD.task_identity_hash
  OR NEW.lesson_date IS NOT OLD.lesson_date
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_INVALID_TRANSITION');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publications_no_delete
BEFORE DELETE ON guardian_lesson_publications
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publication_events_no_update
BEFORE UPDATE ON guardian_lesson_publication_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_lesson_publication_events_no_delete
BEFORE DELETE ON guardian_lesson_publication_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PUBLICATION_EVENT_APPEND_ONLY');
END;

-- 보호자 요청은 정해진 세 종류만 받으며 상세 자유문구·연락처·주소·첨부를 저장하지 않는다.
CREATE TABLE IF NOT EXISTS guardian_requests (
  app               TEXT    NOT NULL CHECK (app = 'task'),
  request_id        TEXT    NOT NULL,
  student_id        TEXT    NOT NULL,
  client_request_id TEXT    NOT NULL CHECK (
    length(client_request_id) BETWEEN 16 AND 64
    AND client_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_type      TEXT    NOT NULL CHECK (request_type IN (
    'consultation','schedule_check','info_correction'
  )),
  status            TEXT    NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT,
  CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status IN ('resolved','dismissed') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  ),
  PRIMARY KEY (app, request_id),
  UNIQUE (app, student_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_requests_status
  ON guardian_requests(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_guardian_requests_student
  ON guardian_requests(app, student_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_requests_open_type
  ON guardian_requests(app, student_id, request_type)
  WHERE status='open';

CREATE TABLE IF NOT EXISTS guardian_request_events (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  event_id     TEXT    NOT NULL,
  request_id   TEXT    NOT NULL,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  event_type   TEXT    NOT NULL CHECK (event_type IN ('submitted','resolved','dismissed')),
  created_at   INTEGER NOT NULL,
  created_by   TEXT    NOT NULL,
  PRIMARY KEY (app, event_id),
  UNIQUE (app, request_id, revision),
  FOREIGN KEY (app, request_id) REFERENCES guardian_requests(app, request_id)
);

CREATE TRIGGER IF NOT EXISTS trg_guardian_requests_rate_limit
BEFORE INSERT ON guardian_requests
WHEN NOT EXISTS (
    SELECT 1 FROM guardian_requests existing
    WHERE existing.app=NEW.app AND existing.student_id=NEW.student_id
      AND existing.client_request_id=NEW.client_request_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM guardian_requests existing_open
    WHERE existing_open.app=NEW.app AND existing_open.student_id=NEW.student_id
      AND existing_open.request_type=NEW.request_type AND existing_open.status='open'
  )
  AND (
    SELECT COUNT(*) FROM guardian_requests recent
    WHERE recent.app=NEW.app AND recent.student_id=NEW.student_id
      AND recent.created_at >= NEW.created_at - 86400000
  ) >= 5
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_RATE_LIMIT');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_requests_update
BEFORE UPDATE ON guardian_requests
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.client_request_id IS NOT OLD.client_request_id
  OR NEW.request_type IS NOT OLD.request_type
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'open'
  OR NEW.status NOT IN ('resolved','dismissed')
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_INVALID_TRANSITION');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_requests_no_delete
BEFORE DELETE ON guardian_requests
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_request_events_no_update
BEFORE UPDATE ON guardian_request_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_request_events_no_delete
BEFORE DELETE ON guardian_request_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_REQUEST_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_responses_no_update
BEFORE UPDATE ON guardian_portal_responses
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PORTAL_RESPONSE_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_portal_responses_no_delete
BEFORE DELETE ON guardian_portal_responses
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_PORTAL_RESPONSE_APPEND_ONLY');
END;

-- 보호자 공지는 관리자만 작성·게시·종료하고 대상 학생의 활성 세션에는 공개 필드만 보낸다.
CREATE TABLE IF NOT EXISTS guardian_announcements (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  announcement_id    TEXT    NOT NULL,
  title              TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  body               TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  publish_date       TEXT    NOT NULL CHECK (
    COALESCE(length(publish_date) = 10 AND strftime('%Y-%m-%d', publish_date) = publish_date, 0) = 1
  ),
  expires_date       TEXT    NOT NULL CHECK (
    COALESCE(length(expires_date) = 10 AND strftime('%Y-%m-%d', expires_date) = expires_date, 0) = 1
    AND expires_date >= publish_date
  ),
  target_type        TEXT    NOT NULL CHECK (target_type IN ('all','students')),
  target_students    TEXT    NOT NULL CHECK (
    CASE WHEN json_valid(target_students) THEN
      json_type(target_students) = 'array'
      AND (
        (target_type = 'all' AND json_array_length(target_students) = 0)
        OR (target_type = 'students' AND json_array_length(target_students) BETWEEN 1 AND 200)
      )
    ELSE 0 END
  ),
  status             TEXT    NOT NULL CHECK (status IN ('draft','published','ended')),
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT    NOT NULL,
  PRIMARY KEY (app, announcement_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_announcements_active
  ON guardian_announcements(app, status, publish_date, expires_date);
CREATE INDEX IF NOT EXISTS idx_guardian_announcements_updated
  ON guardian_announcements(app, updated_at);

CREATE TABLE IF NOT EXISTS guardian_announcement_events (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  event_id           TEXT    NOT NULL,
  announcement_id    TEXT    NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  event_type         TEXT    NOT NULL CHECK (event_type IN ('created','updated','published','ended')),
  status             TEXT    NOT NULL CHECK (status IN ('draft','published','ended')),
  title              TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  body               TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  publish_date       TEXT    NOT NULL CHECK (
    COALESCE(length(publish_date) = 10 AND strftime('%Y-%m-%d', publish_date) = publish_date, 0) = 1
  ),
  expires_date       TEXT    NOT NULL CHECK (
    COALESCE(length(expires_date) = 10 AND strftime('%Y-%m-%d', expires_date) = expires_date, 0) = 1
    AND expires_date >= publish_date
  ),
  target_type        TEXT    NOT NULL CHECK (target_type IN ('all','students')),
  target_students    TEXT    NOT NULL CHECK (
    CASE WHEN json_valid(target_students) THEN
      json_type(target_students) = 'array'
      AND (
        (target_type = 'all' AND json_array_length(target_students) = 0)
        OR (target_type = 'students' AND json_array_length(target_students) BETWEEN 1 AND 200)
      )
    ELSE 0 END
  ),
  created_at         INTEGER NOT NULL,
  created_by         TEXT    NOT NULL,
  PRIMARY KEY (app, event_id),
  UNIQUE (app, announcement_id, revision),
  FOREIGN KEY (app, announcement_id) REFERENCES guardian_announcements(app, announcement_id),
  CHECK (
    (event_type IN ('created','updated') AND status = 'draft')
    OR (event_type = 'published' AND status = 'published')
    OR (event_type = 'ended' AND status = 'ended')
  )
);

CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_targets_insert
BEFORE INSERT ON guardian_announcements
WHEN CASE WHEN json_valid(NEW.target_students) THEN
  EXISTS (
    SELECT 1 FROM json_each(NEW.target_students) target
    WHERE target.type <> 'object'
      OR json_type(target.value, '$.id') <> 'text'
      OR length(json_extract(target.value, '$.id')) NOT BETWEEN 1 AND 128
      OR json_extract(target.value, '$.id') GLOB '*[^A-Za-z0-9_-]*'
      OR json_type(target.value, '$.identityHash') <> 'text'
      OR length(json_extract(target.value, '$.identityHash')) <> 64
      OR json_extract(target.value, '$.identityHash') GLOB '*[^a-f0-9]*'
      OR (SELECT COUNT(*) FROM json_each(target.value)) <> 2
  ) OR (
    SELECT COUNT(*) <> COUNT(DISTINCT json_extract(value, '$.id')) FROM json_each(NEW.target_students)
  )
ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_TARGET_INVALID');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_targets_update
BEFORE UPDATE ON guardian_announcements
WHEN CASE WHEN json_valid(NEW.target_students) THEN
  EXISTS (
    SELECT 1 FROM json_each(NEW.target_students) target
    WHERE target.type <> 'object'
      OR json_type(target.value, '$.id') <> 'text'
      OR length(json_extract(target.value, '$.id')) NOT BETWEEN 1 AND 128
      OR json_extract(target.value, '$.id') GLOB '*[^A-Za-z0-9_-]*'
      OR json_type(target.value, '$.identityHash') <> 'text'
      OR length(json_extract(target.value, '$.identityHash')) <> 64
      OR json_extract(target.value, '$.identityHash') GLOB '*[^a-f0-9]*'
      OR (SELECT COUNT(*) FROM json_each(target.value)) <> 2
  ) OR (
    SELECT COUNT(*) <> COUNT(DISTINCT json_extract(value, '$.id')) FROM json_each(NEW.target_students)
  )
ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_TARGET_INVALID');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_update
BEFORE UPDATE ON guardian_announcements
WHEN NEW.announcement_id IS NOT OLD.announcement_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft','published'))
    OR (OLD.status = 'published' AND NEW.status = 'ended')
  )
  OR (
    (NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
      OR NEW.publish_date IS NOT OLD.publish_date OR NEW.expires_date IS NOT OLD.expires_date
      OR NEW.target_type IS NOT OLD.target_type
      OR NEW.target_students IS NOT OLD.target_students)
    AND NOT (OLD.status = 'draft' AND NEW.status = 'draft')
  )
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_INVALID_TRANSITION');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_no_delete
BEFORE DELETE ON guardian_announcements
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcement_events_no_update
BEFORE UPDATE ON guardian_announcement_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcement_events_no_delete
BEFORE DELETE ON guardian_announcement_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_EVENT_APPEND_ONLY');
END;

-- 학생 웹앱은 보호자 인증과 분리된 stable studentId 전용 읽기 세션을 사용한다.
CREATE TABLE IF NOT EXISTS student_portal_access (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  student_id            TEXT    NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  student_identity_hash TEXT CHECK (
    student_identity_hash IS NULL OR (
      length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  guardian_identity_hash TEXT CHECK (
    guardian_identity_hash IS NULL OR (
      length(guardian_identity_hash) = 64 AND guardian_identity_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  scope_version         INTEGER NOT NULL DEFAULT 1 CHECK (scope_version = 1),
  accepted_at           INTEGER,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT    NOT NULL,
  effective_scope_version INTEGER NOT NULL DEFAULT 1 CHECK (effective_scope_version IN (1,2)),
  scope_confirmed_at    INTEGER CHECK (scope_confirmed_at IS NULL OR scope_confirmed_at>0),
  self_check_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (self_check_enabled IN (0,1)),
  self_check_confirmed_at INTEGER CHECK (self_check_confirmed_at IS NULL OR self_check_confirmed_at>0),
  CHECK (enabled = 0 OR (
    student_identity_hash IS NOT NULL AND guardian_identity_hash IS NOT NULL
    AND scope_version = 1 AND accepted_at IS NOT NULL
  )),
  PRIMARY KEY (app, student_id)
);

CREATE TABLE IF NOT EXISTS student_portal_codes (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  code_hash             TEXT    NOT NULL CHECK (length(code_hash) = 71 AND code_hash LIKE 'sha256:%'),
  student_id            TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  guardian_identity_hash TEXT   NOT NULL CHECK (length(guardian_identity_hash) = 64),
  scope_version         INTEGER NOT NULL CHECK (scope_version = 1),
  access_updated_at     INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  revoked               INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  issued_by             TEXT    NOT NULL,
  claim_id              TEXT CHECK (claim_id IS NULL OR length(claim_id) = 48),
  effective_scope_version INTEGER NOT NULL DEFAULT 1 CHECK (effective_scope_version IN (1,2)),
  self_check_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (self_check_enabled IN (0,1)),
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_student_portal_codes_student
  ON student_portal_codes(app, student_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS student_portal_sessions (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  token_hash            TEXT    NOT NULL CHECK (length(token_hash) = 71 AND token_hash LIKE 'sha256:%'),
  student_id            TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  guardian_identity_hash TEXT   NOT NULL CHECK (length(guardian_identity_hash) = 64),
  scope_version         INTEGER NOT NULL CHECK (scope_version = 1),
  access_updated_at     INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  revoked               INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  effective_scope_version INTEGER NOT NULL DEFAULT 1 CHECK (effective_scope_version IN (1,2)),
  self_check_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (self_check_enabled IN (0,1)),
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_student_portal_sessions_student
  ON student_portal_sessions(app, student_id, revoked, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_revoke
AFTER UPDATE OF enabled, student_identity_hash, guardian_identity_hash,
  scope_version, effective_scope_version, scope_confirmed_at ON student_portal_access
WHEN NEW.enabled=0
  OR OLD.student_identity_hash IS NOT NEW.student_identity_hash
  OR OLD.guardian_identity_hash IS NOT NEW.guardian_identity_hash
  OR OLD.scope_version IS NOT NEW.scope_version
  OR OLD.effective_scope_version IS NOT NEW.effective_scope_version
  OR OLD.scope_confirmed_at IS NOT NEW.scope_confirmed_at
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_code_scope_insert
BEFORE INSERT ON student_portal_codes
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.student_identity_hash=NEW.student_identity_hash
    AND access.guardian_identity_hash=NEW.guardian_identity_hash
    AND access.updated_at=NEW.access_updated_at
    AND access.scope_version=1
    AND access.effective_scope_version=NEW.effective_scope_version
    AND (access.effective_scope_version=1 OR access.scope_confirmed_at=access.updated_at)
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_CODE_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_session_scope_insert
BEFORE INSERT ON student_portal_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.student_identity_hash=NEW.student_identity_hash
    AND access.guardian_identity_hash=NEW.guardian_identity_hash
    AND access.updated_at=NEW.access_updated_at
    AND access.scope_version=1
    AND access.effective_scope_version=NEW.effective_scope_version
    AND (access.effective_scope_version=1 OR access.scope_confirmed_at=access.updated_at)
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_SESSION_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_disable_scope
AFTER UPDATE OF enabled ON student_portal_access
WHEN NEW.enabled=0 AND NEW.effective_scope_version<>1
BEGIN
  UPDATE student_portal_access SET effective_scope_version=1,scope_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id AND effective_scope_version<>1;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_access_scope_mismatch
AFTER UPDATE OF updated_at ON student_portal_access
WHEN NEW.enabled=1 AND NEW.effective_scope_version=2
  AND NEW.scope_confirmed_at IS NOT NEW.updated_at
BEGIN
  UPDATE student_portal_access SET effective_scope_version=1,scope_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id AND effective_scope_version=2;
END;

-- v3는 기존 v2 봉인을 유지하면서 학생 자기 체크 동의를 별도로 합성한다.
CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_access_revoke
AFTER UPDATE OF self_check_enabled, self_check_confirmed_at ON student_portal_access
WHEN OLD.self_check_enabled IS NOT NEW.self_check_enabled
  OR OLD.self_check_confirmed_at IS NOT NEW.self_check_confirmed_at
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_code_scope_insert
BEFORE INSERT ON student_portal_codes
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.updated_at=NEW.access_updated_at
    AND access.effective_scope_version=NEW.effective_scope_version
    AND access.self_check_enabled=NEW.self_check_enabled
    AND (access.self_check_enabled=0 OR (
      access.effective_scope_version=2
      AND access.scope_confirmed_at=access.updated_at
      AND access.self_check_confirmed_at=access.updated_at
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_CODE_SELF_CHECK_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_session_scope_insert
BEFORE INSERT ON student_portal_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM student_portal_access access
  WHERE access.app=NEW.app AND access.student_id=NEW.student_id AND access.enabled=1
    AND access.updated_at=NEW.access_updated_at
    AND access.effective_scope_version=NEW.effective_scope_version
    AND access.self_check_enabled=NEW.self_check_enabled
    AND (access.self_check_enabled=0 OR (
      access.effective_scope_version=2
      AND access.scope_confirmed_at=access.updated_at
      AND access.self_check_confirmed_at=access.updated_at
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_PORTAL_SESSION_SELF_CHECK_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_disable_scope
AFTER UPDATE OF enabled ON student_portal_access
WHEN NEW.enabled=0 AND (NEW.self_check_enabled<>0 OR NEW.self_check_confirmed_at IS NOT NULL)
BEGIN
  UPDATE student_portal_access SET self_check_enabled=0,self_check_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_self_check_scope_mismatch
AFTER UPDATE OF updated_at ON student_portal_access
WHEN NEW.enabled=1 AND NEW.self_check_enabled=1
  AND (NEW.effective_scope_version<>2
    OR NEW.scope_confirmed_at IS NOT NEW.updated_at
    OR NEW.self_check_confirmed_at IS NOT NEW.updated_at)
BEGIN
  UPDATE student_portal_access SET self_check_enabled=0,self_check_confirmed_at=NULL
  WHERE app=NEW.app AND student_id=NEW.student_id AND self_check_enabled=1;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_roster_identity_update
AFTER UPDATE OF data ON private_rosters
WHEN NEW.app='task'
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND revoked=0 AND NOT EXISTS (
    SELECT 1
    FROM json_each(OLD.data, '$.roster.students') old_student
    JOIN json_each(NEW.data, '$.roster.students') new_student
      ON json_extract(new_student.value, '$.id')=student_portal_codes.student_id
    WHERE json_extract(old_student.value, '$.id')=student_portal_codes.student_id
      AND json_extract(new_student.value, '$.name') IS json_extract(old_student.value, '$.name')
      AND json_extract(new_student.value, '$.start') IS json_extract(old_student.value, '$.start')
      AND json_extract(new_student.value, '$.end') IS json_extract(old_student.value, '$.end')
  );
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND revoked=0 AND NOT EXISTS (
    SELECT 1
    FROM json_each(OLD.data, '$.roster.students') old_student
    JOIN json_each(NEW.data, '$.roster.students') new_student
      ON json_extract(new_student.value, '$.id')=student_portal_sessions.student_id
    WHERE json_extract(old_student.value, '$.id')=student_portal_sessions.student_id
      AND json_extract(new_student.value, '$.name') IS json_extract(old_student.value, '$.name')
      AND json_extract(new_student.value, '$.start') IS json_extract(old_student.value, '$.start')
      AND json_extract(new_student.value, '$.end') IS json_extract(old_student.value, '$.end')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_roster_delete
AFTER DELETE ON private_rosters
WHEN OLD.app='task'
BEGIN
  UPDATE student_portal_codes SET revoked=1 WHERE app=OLD.app AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1 WHERE app=OLD.app AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_guardian_identity_update
AFTER UPDATE OF student_name, phone ON guardian_contacts_by_student
WHEN NEW.app='task' AND (OLD.student_name IS NOT NEW.student_name OR OLD.phone IS NOT NEW.phone)
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=NEW.app AND student_id=NEW.student_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_student_portal_guardian_identity_delete
AFTER DELETE ON guardian_contacts_by_student
WHEN OLD.app='task'
BEGIN
  UPDATE student_portal_codes SET revoked=1
  WHERE app=OLD.app AND student_id=OLD.student_id AND revoked=0;
  UPDATE student_portal_sessions SET revoked=1
  WHERE app=OLD.app AND student_id=OLD.student_id AND revoked=0;
END;

-- 학생의 선택은 수업 지시서 체크와 분리한다. 담당 확인 전에는 최종 완료가 아니다.
CREATE TABLE IF NOT EXISTS student_lesson_self_checks (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  publication_id        TEXT    NOT NULL CHECK (length(publication_id) BETWEEN 1 AND 128),
  publication_revision  INTEGER NOT NULL CHECK (publication_revision >= 1),
  student_id            TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  student_identity_hash TEXT    NOT NULL CHECK (
    length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  response              TEXT    NOT NULL CHECK (response IN ('completed','help_needed')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  responded_at          INTEGER NOT NULL CHECK (responded_at > 0),
  confirmed_at          INTEGER CHECK (confirmed_at IS NULL OR confirmed_at > 0),
  confirmed_by          TEXT CHECK (confirmed_by IS NULL OR length(confirmed_by) BETWEEN 1 AND 128),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK ((confirmed_at IS NULL AND confirmed_by IS NULL)
    OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  PRIMARY KEY (app, publication_id),
  FOREIGN KEY (app, publication_id) REFERENCES guardian_lesson_publications(app, publication_id)
);
CREATE INDEX IF NOT EXISTS idx_student_lesson_self_checks_student
  ON student_lesson_self_checks(app, student_id, updated_at);

CREATE TABLE IF NOT EXISTS student_lesson_self_check_events (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  event_id              TEXT    NOT NULL CHECK (length(event_id)=52 AND event_id LIKE 'sce_%'),
  publication_id        TEXT    NOT NULL CHECK (length(publication_id) BETWEEN 1 AND 128),
  publication_revision  INTEGER NOT NULL CHECK (publication_revision >= 1),
  student_id            TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  student_identity_hash TEXT    NOT NULL CHECK (
    length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  event_type            TEXT    NOT NULL CHECK (event_type IN ('student_set','teacher_confirmed')),
  response              TEXT    NOT NULL CHECK (response IN ('completed','help_needed')),
  actor_type            TEXT    NOT NULL CHECK (actor_type IN ('student','staff')),
  actor_id              TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, event_id),
  UNIQUE (app, publication_id, publication_revision, revision),
  FOREIGN KEY (app, publication_id) REFERENCES guardian_lesson_publications(app, publication_id)
);
CREATE INDEX IF NOT EXISTS idx_student_lesson_self_check_events_rate
  ON student_lesson_self_check_events(app, student_id, event_type, created_at);

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_rate_insert
BEFORE INSERT ON student_lesson_self_checks
WHEN (SELECT COUNT(*) FROM student_lesson_self_check_events event
  WHERE event.app=NEW.app AND event.student_id=NEW.student_id
    AND event.event_type='student_set' AND event.created_at>NEW.updated_at-86400000) >= 30
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_RATE_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_update_guard
BEFORE UPDATE ON student_lesson_self_checks
WHEN OLD.app IS NOT NEW.app
  OR OLD.publication_id IS NOT NEW.publication_id
  OR OLD.student_id IS NOT NEW.student_id
  OR OLD.student_identity_hash IS NOT NEW.student_identity_hash
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.revision<>OLD.revision+1
  OR NEW.updated_at<=OLD.updated_at
  OR NEW.publication_revision<OLD.publication_revision
  OR NOT (
    (NEW.confirmed_at IS NULL AND NEW.confirmed_by IS NULL
      AND NEW.responded_at=NEW.updated_at
      AND NOT (OLD.response='completed' AND OLD.confirmed_at IS NOT NULL
        AND NEW.publication_revision=OLD.publication_revision)
      AND (NEW.response IS NOT OLD.response OR NEW.publication_revision>OLD.publication_revision))
    OR
    (OLD.confirmed_at IS NULL AND OLD.confirmed_by IS NULL
      AND NEW.confirmed_at IS NOT NULL AND NEW.confirmed_by IS NOT NULL
      AND NEW.publication_revision=OLD.publication_revision
      AND NEW.response=OLD.response AND NEW.responded_at=OLD.responded_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_INVALID_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_rate_update
BEFORE UPDATE OF response, publication_revision ON student_lesson_self_checks
WHEN (OLD.response IS NOT NEW.response OR OLD.publication_revision IS NOT NEW.publication_revision)
  AND (SELECT COUNT(*) FROM student_lesson_self_check_events event
    WHERE event.app=NEW.app AND event.student_id=NEW.student_id
      AND event.event_type='student_set' AND event.created_at>NEW.updated_at-86400000) >= 30
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_RATE_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_checks_no_delete
BEFORE DELETE ON student_lesson_self_checks
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_HISTORY_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_check_events_no_update
BEFORE UPDATE ON student_lesson_self_check_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_student_lesson_self_check_events_no_delete
BEFORE DELETE ON student_lesson_self_check_events
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_SELF_CHECK_EVENT_APPEND_ONLY');
END;

-- consult 학생 인증사진·질문: D1은 불변 제출 이력, JPEG 원본은 private R2에 둔다.
CREATE TABLE IF NOT EXISTS consult_submissions (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  submission_id     TEXT    NOT NULL CHECK (length(submission_id) BETWEEN 4 AND 128 AND submission_id LIKE 'cs_%'),
  client_request_id TEXT    NOT NULL CHECK (length(client_request_id) BETWEEN 1 AND 128),
  owner             TEXT    NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  kind              TEXT    NOT NULL CHECK (kind IN ('proof','question')),
  task_id           TEXT    CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 128),
  task_date         TEXT    CHECK (task_date IS NULL OR length(task_date) = 10),
  body_text         TEXT    NOT NULL CHECK (length(body_text) <= 2000),
  object_key        TEXT    CHECK (object_key IS NULL OR (length(object_key) BETWEEN 1 AND 200 AND object_key LIKE 'consult/%')),
  media_bytes       INTEGER CHECK (media_bytes IS NULL OR media_bytes BETWEEN 1 AND 2097152),
  media_expires_at  INTEGER CHECK (media_expires_at IS NULL OR media_expires_at > 0),
  status            TEXT    NOT NULL CHECK (status IN ('pending','approved','rejected','answered','cancelled')),
  answer_text       TEXT    CHECK (answer_text IS NULL OR length(answer_text) BETWEEN 1 AND 5000),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at >= created_at),
  reviewed_at       INTEGER CHECK (reviewed_at IS NULL OR reviewed_at > 0),
  reviewed_by       TEXT    CHECK (reviewed_by IS NULL OR length(reviewed_by) BETWEEN 1 AND 128),
  review_note       TEXT    CHECK (review_note IS NULL OR length(review_note) BETWEEN 1 AND 1000),
  PRIMARY KEY (app, submission_id),
  UNIQUE (app, owner, client_request_id),
  UNIQUE (app, object_key),
  CHECK ((object_key IS NULL AND media_bytes IS NULL AND media_expires_at IS NULL)
    OR (object_key IS NOT NULL AND media_bytes IS NOT NULL AND media_expires_at > created_at)),
  CHECK ((kind = 'proof' AND task_id IS NOT NULL AND task_date IS NOT NULL AND object_key IS NOT NULL
      AND status IN ('pending','approved','rejected','cancelled'))
    OR (kind = 'question' AND ((task_id IS NULL AND task_date IS NULL) OR (task_id IS NOT NULL AND task_date IS NOT NULL))
      AND (length(body_text) > 0 OR object_key IS NOT NULL)
      AND status IN ('pending','answered','rejected','cancelled'))),
  CHECK ((status IN ('pending','cancelled') AND answer_text IS NULL
      AND reviewed_at IS NULL AND reviewed_by IS NULL AND review_note IS NULL)
    OR (status = 'approved' AND answer_text IS NULL
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NULL)
    OR (status = 'rejected' AND answer_text IS NULL
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NOT NULL)
    OR (status = 'answered' AND answer_text IS NOT NULL
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_consult_submissions_owner
  ON consult_submissions(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_consult_submissions_owner_created
  ON consult_submissions(app, owner, created_at);
CREATE INDEX IF NOT EXISTS idx_consult_submissions_status
  ON consult_submissions(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_consult_submissions_task
  ON consult_submissions(app, task_id, task_date, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consult_submissions_one_pending_proof
  ON consult_submissions(app, owner, task_id, task_date)
  WHERE kind = 'proof' AND status = 'pending';

CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_daily_limit
BEFORE INSERT ON consult_submissions
WHEN (SELECT COUNT(*) FROM consult_submissions row
  WHERE row.app = NEW.app AND row.owner = NEW.owner AND row.created_at > NEW.created_at - 86400000) >= 20
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_DAILY_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_pending_limit
BEFORE INSERT ON consult_submissions
WHEN (SELECT COUNT(*) FROM consult_submissions row
  WHERE row.app = NEW.app AND row.owner = NEW.owner AND row.status = 'pending') >= 10
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_PENDING_LIMIT');
END;

-- 제출 내용과 R2 key는 고치지 않는다. pending 상태를 한 번 결정하는 CAS만 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_update_guard
BEFORE UPDATE ON consult_submissions
WHEN OLD.app IS NOT NEW.app
  OR OLD.submission_id IS NOT NEW.submission_id
  OR OLD.client_request_id IS NOT NEW.client_request_id
  OR OLD.owner IS NOT NEW.owner
  OR OLD.kind IS NOT NEW.kind
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.task_date IS NOT NEW.task_date
  OR OLD.body_text IS NOT NEW.body_text
  OR OLD.object_key IS NOT NEW.object_key
  OR OLD.media_bytes IS NOT NEW.media_bytes
  OR OLD.media_expires_at IS NOT NEW.media_expires_at
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR NOT (OLD.status = 'pending' AND (
    (OLD.kind = 'proof' AND NEW.status IN ('approved','rejected','cancelled'))
    OR (OLD.kind = 'question' AND NEW.status IN ('answered','rejected','cancelled'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_submissions_no_delete
BEFORE DELETE ON consult_submissions
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_SUBMISSION_HISTORY_REQUIRED');
END;

-- consult 보호자 읽기 전용 리포트 포털.
-- task 보호자 포털과 표·쿠키·app 범위를 완전히 분리한다.
CREATE TABLE IF NOT EXISTS consult_guardian_access (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  identity_revision TEXT    NOT NULL CHECK (
    length(identity_revision) = 64 AND identity_revision NOT GLOB '*[^a-f0-9]*'
  ),
  scope_version     INTEGER NOT NULL CHECK (scope_version >= 1),
  accepted_at       INTEGER CHECK (accepted_at IS NULL OR accepted_at > 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by        TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (enabled = 0 OR accepted_at IS NOT NULL),
  PRIMARY KEY (app, staff_id)
);

CREATE TABLE IF NOT EXISTS consult_guardian_codes (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  code_hash         TEXT    NOT NULL CHECK (length(code_hash) = 71 AND code_hash LIKE 'sha256:%'),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  identity_revision TEXT    NOT NULL CHECK (
    length(identity_revision) = 64 AND identity_revision NOT GLOB '*[^a-f0-9]*'
  ),
  scope_version     INTEGER NOT NULL CHECK (scope_version >= 1),
  access_updated_at INTEGER NOT NULL CHECK (access_updated_at > 0),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  expires_at        INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at       INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  revoked           INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  issued_by         TEXT    NOT NULL CHECK (length(issued_by) BETWEEN 1 AND 128),
  claim_id          TEXT CHECK (claim_id IS NULL OR length(claim_id) = 48),
  PRIMARY KEY (app, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_consult_guardian_codes_staff
  ON consult_guardian_codes(app, staff_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS consult_guardian_sessions (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  token_hash        TEXT    NOT NULL CHECK (length(token_hash) = 71 AND token_hash LIKE 'sha256:%'),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  identity_revision TEXT    NOT NULL CHECK (
    length(identity_revision) = 64 AND identity_revision NOT GLOB '*[^a-f0-9]*'
  ),
  scope_version     INTEGER NOT NULL CHECK (scope_version >= 1),
  access_updated_at INTEGER NOT NULL CHECK (access_updated_at > 0),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  expires_at        INTEGER NOT NULL CHECK (expires_at > created_at),
  last_seen_at      INTEGER NOT NULL CHECK (last_seen_at >= created_at),
  revoked           INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  PRIMARY KEY (app, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_consult_guardian_sessions_staff
  ON consult_guardian_sessions(app, staff_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS consult_guardian_acknowledgements (
  app               TEXT    NOT NULL CHECK (app = 'consult'),
  ack_id            TEXT    NOT NULL CHECK (length(ack_id) = 52 AND ack_id LIKE 'cga_%'),
  report_ref        TEXT    NOT NULL CHECK (length(report_ref) = 52 AND report_ref LIKE 'cgr_%'),
  source_report_id  TEXT    NOT NULL CHECK (length(source_report_id) BETWEEN 1 AND 128),
  staff_id          TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  report_revision   INTEGER NOT NULL CHECK (report_revision >= 1),
  acknowledged_at  INTEGER NOT NULL CHECK (acknowledged_at > 0),
  PRIMARY KEY (app, ack_id),
  UNIQUE (app, staff_id, report_ref, report_revision)
);
CREATE INDEX IF NOT EXISTS idx_consult_guardian_ack_staff
  ON consult_guardian_acknowledgements(app, staff_id, acknowledged_at);

-- 공유 해제나 학생 identity revision 변경은 기존 코드와 쿠키 세션을 즉시 폐기한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_access_revoke
AFTER UPDATE OF enabled, identity_revision, scope_version, updated_at ON consult_guardian_access
WHEN NEW.enabled = 0
  OR OLD.identity_revision IS NOT NEW.identity_revision
  OR OLD.scope_version IS NOT NEW.scope_version
  OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_access_delete
AFTER DELETE ON consult_guardian_access
BEGIN
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app=OLD.app AND staff_id=OLD.staff_id AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app=OLD.app AND staff_id=OLD.staff_id AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_staff_identity_update
AFTER UPDATE OF id, data ON staff
WHEN NEW.app='consult' AND (
  OLD.id IS NOT NEW.id
  OR json_extract(OLD.data,'$.id') IS NOT json_extract(NEW.data,'$.id')
  OR json_extract(OLD.data,'$.name') IS NOT json_extract(NEW.data,'$.name')
  OR COALESCE(json_extract(OLD.data,'$.deleted'),0) IS NOT COALESCE(json_extract(NEW.data,'$.deleted'),0)
  OR COALESCE(json_extract(OLD.data,'$.owner'),0) IS NOT COALESCE(json_extract(NEW.data,'$.owner'),0)
  OR COALESCE(json_extract(OLD.data,'$.manager'),0) IS NOT COALESCE(json_extract(NEW.data,'$.manager'),0)
)
BEGIN
  -- 이름·활성·역할이 원래 값으로 되돌아가도 과거 동의가 다시 살아나면 안 된다.
  -- 기존 access를 영구 비활성화하고 원장이 새 동의를 받아야만 다시 켤 수 있게 한다.
  UPDATE consult_guardian_access
  SET enabled=0, accepted_at=NULL,
      updated_at=MAX(updated_at+1, CAST(strftime('%s','now') AS INTEGER)*1000),
      updated_by='identity-change'
  WHERE app='consult' AND (staff_id=OLD.id OR staff_id=NEW.id);
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app='consult' AND (staff_id=OLD.id OR staff_id=NEW.id) AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app='consult' AND (staff_id=OLD.id OR staff_id=NEW.id) AND revoked=0;
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_staff_identity_delete
AFTER DELETE ON staff
WHEN OLD.app='consult'
BEGIN
  UPDATE consult_guardian_access
  SET enabled=0, accepted_at=NULL,
      updated_at=MAX(updated_at+1, CAST(strftime('%s','now') AS INTEGER)*1000),
      updated_by='identity-delete'
  WHERE app='consult' AND staff_id=OLD.id;
  UPDATE consult_guardian_codes SET revoked=1
  WHERE app='consult' AND staff_id=OLD.id AND revoked=0;
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app='consult' AND staff_id=OLD.id AND revoked=0;
END;

-- 보호자가 확인한 판의 내용은 이후 수정·삭제하지 않고 새 revision으로만 발행한다.
-- 동일 JSON을 다시 동기화하며 srv_at만 갱신하는 멱등 upsert는 허용한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_report_no_update
BEFORE UPDATE ON tasks
WHEN OLD.app='consult'
  AND json_valid(OLD.data)
  AND json_extract(OLD.data,'$.kind')='report_snapshot'
  AND json_extract(OLD.data,'$.origin')='admin'
  AND (
    NEW.app IS NOT OLD.app OR NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner
    OR NEW.data IS NOT OLD.data
  )
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_REPORT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_report_no_delete
BEFORE DELETE ON tasks
WHEN OLD.app='consult'
  AND json_valid(OLD.data)
  AND json_extract(OLD.data,'$.kind')='report_snapshot'
  AND json_extract(OLD.data,'$.origin')='admin'
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_REPORT_IMMUTABLE');
END;

-- 한 학생의 활성 보호자 기기는 최근 3개만 유지한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_session_max_three
AFTER INSERT ON consult_guardian_sessions
BEGIN
  UPDATE consult_guardian_sessions SET revoked=1
  WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0
    AND expires_at>=NEW.created_at AND token_hash NOT IN (
      SELECT token_hash FROM consult_guardian_sessions
      WHERE app=NEW.app AND staff_id=NEW.staff_id AND revoked=0 AND expires_at>=NEW.created_at
      ORDER BY created_at DESC, token_hash DESC LIMIT 3
    );
END;

-- 보호자가 확인하는 순간에도 해당 발행본이 그 기간의 최신 published revision인지 재검증한다.
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_ack_current_report
BEFORE INSERT ON consult_guardian_acknowledgements
WHEN NOT EXISTS (
  SELECT 1 FROM tasks current
  WHERE current.app='consult' AND current.id=NEW.source_report_id AND current.owner=NEW.staff_id
    AND json_valid(current.data) AND json_extract(current.data,'$.id')=current.id
    AND json_extract(current.data,'$.staffId')=current.owner
    AND json_extract(current.data,'$.kind')='report_snapshot'
    AND json_extract(current.data,'$.origin')='admin'
    AND json_extract(current.data,'$.reportStatus')='published'
    AND CAST(json_extract(current.data,'$.reportRevision') AS INTEGER)=NEW.report_revision
    AND COALESCE(json_extract(current.data,'$.deleted'),0)=0
    AND NOT EXISTS (
      SELECT 1 FROM tasks newer
      WHERE newer.app=current.app AND newer.owner=current.owner AND json_valid(newer.data)
        AND json_extract(newer.data,'$.kind')='report_snapshot'
        AND json_extract(newer.data,'$.origin')='admin'
        AND COALESCE(json_extract(newer.data,'$.deleted'),0)=0
        AND json_extract(newer.data,'$.reportType')=json_extract(current.data,'$.reportType')
        AND json_extract(newer.data,'$.periodKey')=json_extract(current.data,'$.periodKey')
        AND (
          CAST(json_extract(newer.data,'$.reportRevision') AS INTEGER) > NEW.report_revision
          OR (CAST(json_extract(newer.data,'$.reportRevision') AS INTEGER)=NEW.report_revision
            AND (newer.updated_at>current.updated_at
              OR (newer.updated_at=current.updated_at AND newer.id>current.id)))
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_REPORT_STALE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_ack_no_update
BEFORE UPDATE ON consult_guardian_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_ACK_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_consult_guardian_ack_no_delete
BEFORE DELETE ON consult_guardian_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_GUARDIAN_ACK_APPEND_ONLY');
END;

-- consult 영어·수학 PDF 결과지. 파일 본문은 private R2에만 저장한다.
CREATE TABLE IF NOT EXISTS consult_result_sheets (
  app          TEXT NOT NULL CHECK (app = 'consult'),
  result_id    TEXT NOT NULL CHECK (
    result_id GLOB 'crs_[0-9a-f]*' AND substr(result_id,5) NOT GLOB '*[^0-9a-f]*' AND length(result_id) = 36
  ),
  owner        TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  subject      TEXT NOT NULL CHECK (subject IN ('english','math')),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  result_date  TEXT NOT NULL CHECK (result_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  object_key   TEXT NOT NULL UNIQUE CHECK (object_key GLOB 'consult-results/*.pdf'),
  media_bytes  INTEGER NOT NULL CHECK (media_bytes BETWEEN 1 AND 10485760),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= created_at),
  uploaded_by  TEXT NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, result_id)
);

CREATE INDEX IF NOT EXISTS idx_consult_result_sheets_owner
  ON consult_result_sheets(app, owner, status, result_date DESC, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_consult_result_sheets_update_guard
BEFORE UPDATE ON consult_result_sheets
WHEN NEW.app <> OLD.app
  OR NEW.result_id <> OLD.result_id
  OR NEW.owner <> OLD.owner
  OR NEW.subject <> OLD.subject
  OR NEW.title <> OLD.title
  OR NEW.result_date <> OLD.result_date
  OR NEW.object_key <> OLD.object_key
  OR NEW.media_bytes <> OLD.media_bytes
  OR NEW.created_at <> OLD.created_at
  OR NEW.uploaded_by <> OLD.uploaded_by
  OR NOT (OLD.status = 'active' AND NEW.status = 'archived')
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_RESULT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_result_sheets_no_delete
BEFORE DELETE ON consult_result_sheets
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_RESULT_NO_DELETE');
END;

-- 토·일 예정 시간표와 분리해서 기록하는 실제 등·하원 원장.
-- 학생·수업 연결은 stable studentId와 lesson task id만 사용한다.
CREATE TABLE IF NOT EXISTS weekend_actual_visits (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  visit_id        TEXT    NOT NULL CHECK (
    visit_id GLOB 'wv_[0-9a-f]*' AND substr(visit_id,4) NOT GLOB '*[^0-9a-f]*' AND length(visit_id) = 35
  ),
  student_id      TEXT    NOT NULL CHECK (length(student_id) BETWEEN 1 AND 128),
  lesson_task_id  TEXT    NOT NULL CHECK (length(lesson_task_id) BETWEEN 1 AND 128),
  staff_id        TEXT    NOT NULL CHECK (length(staff_id) BETWEEN 1 AND 128),
  visit_date      TEXT    NOT NULL CHECK (visit_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  check_in_at     INTEGER NOT NULL CHECK (check_in_at > 0),
  check_out_at    INTEGER CHECK (check_out_at IS NULL OR check_out_at >= check_in_at),
  status          TEXT    NOT NULL CHECK (status IN ('active','completed','cancelled')),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= created_at),
  created_by      TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  updated_by      TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, visit_id),
  UNIQUE (app, student_id, lesson_task_id, visit_date)
);

CREATE INDEX IF NOT EXISTS idx_weekend_actual_visits_date_staff
  ON weekend_actual_visits(app, visit_date, staff_id, status);
CREATE INDEX IF NOT EXISTS idx_weekend_actual_visits_student
  ON weekend_actual_visits(app, student_id, visit_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekend_actual_visits_one_open
  ON weekend_actual_visits(app, student_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS weekend_actual_visit_events (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  event_id     TEXT    NOT NULL CHECK (
    event_id GLOB 'wve_[0-9a-f]*' AND substr(event_id,5) NOT GLOB '*[^0-9a-f]*' AND length(event_id) = 36
  ),
  visit_id     TEXT    NOT NULL CHECK (length(visit_id) BETWEEN 1 AND 128),
  event_type   TEXT    NOT NULL CHECK (event_type IN ('check_in','check_out','correct','cancel','reopen')),
  event_data   TEXT    NOT NULL,
  actor_id     TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (app, event_id),
  FOREIGN KEY (app, visit_id) REFERENCES weekend_actual_visits(app, visit_id)
);

CREATE INDEX IF NOT EXISTS idx_weekend_actual_visit_events_visit
  ON weekend_actual_visit_events(app, visit_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visits_update_guard
BEFORE UPDATE ON weekend_actual_visits
WHEN NEW.app <> OLD.app
  OR NEW.visit_id <> OLD.visit_id
  OR NEW.student_id <> OLD.student_id
  OR NEW.lesson_task_id <> OLD.lesson_task_id
  OR NEW.staff_id <> OLD.staff_id
  OR NEW.visit_date <> OLD.visit_date
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visits_no_delete
BEFORE DELETE ON weekend_actual_visits
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_NO_DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visit_events_no_update
BEFORE UPDATE ON weekend_actual_visit_events
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_weekend_actual_visit_events_no_delete
BEFORE DELETE ON weekend_actual_visit_events
BEGIN
  SELECT RAISE(ABORT, 'WEEKEND_VISIT_EVENT_NO_DELETE');
END;
