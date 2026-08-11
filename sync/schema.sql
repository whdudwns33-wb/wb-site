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
  changes      TEXT    NOT NULL,          -- JSON. 허용된 필드만: days,time,repeat,detail,guide,target,unit
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

-- 학부모 피드백 실제 발송 이력 — book_order_sends와 같은 골격
-- (예약→발송중→결과, 멱등키로 중복 발송 방지, 하루 발송 한도).
CREATE TABLE IF NOT EXISTS parent_feedback_sends (
  app                  TEXT    NOT NULL CHECK (app = 'task'),
  send_id              TEXT    NOT NULL,
  idempotency_key      TEXT    NOT NULL,
  feedback_request_key TEXT    NOT NULL,
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
