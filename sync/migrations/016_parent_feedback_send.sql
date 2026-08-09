-- 학부모 피드백 실제 발송 — 보호자 연락처/동의 원장(guardian_contacts)과 발송 이력
-- (parent_feedback_sends)을 새로 추가한다. 둘 다 신규 테이블이라 기존 데이터에는
-- 영향이 없다.
--
-- guardian_contacts는 개인정보(전화번호)를 담는 유일한 테이블이다. 정적 파일
-- (roster.json)에는 절대 올리지 않는다 — GitHub Pages로 공개 서빙되는 저장소에
-- 아이들 보호자 전화번호를 커밋할 수는 없기 때문에 D1(비공개 서버 DB)에만 둔다.
-- 원장만(scope='all') 넣고 고칠 수 있다.
CREATE TABLE IF NOT EXISTS guardian_contacts (
  app          TEXT    NOT NULL,
  student_name TEXT    NOT NULL,
  phone        TEXT,
  consent      INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0, 1)),
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT,
  PRIMARY KEY (app, student_name)
);

-- 발송 이력 — book_order_sends와 같은 골격(예약→발송중→결과, 멱등키, 하루 한도).
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

-- feedback_requests에 'sent' 상태를 추가한다 — "문구 승인"과 "실제 발송"을 구분하기
-- 위함이다. SQLite/D1은 CHECK 제약을 ALTER로 못 바꾸므로 표준 절차(새 테이블 생성 →
-- 데이터 복사 → 기존 테이블 삭제 → 이름 변경)로 다시 만든다. 컬럼과 데이터는 전부
-- 그대로 유지되고, PRIMARY KEY·UNIQUE 제약도 동일하다.
CREATE TABLE feedback_requests_v2 (
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
INSERT INTO feedback_requests_v2 SELECT * FROM feedback_requests;
DROP TABLE feedback_requests;
ALTER TABLE feedback_requests_v2 RENAME TO feedback_requests;
CREATE INDEX IF NOT EXISTS idx_feedback_requests_owner
  ON feedback_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_status
  ON feedback_requests(app, status, updated_at);
