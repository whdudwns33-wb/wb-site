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
-- 이 테이블은 "문구 승인"까지만 다루며 실제 외부 발송 정보나 발송 결과를 저장하지 않는다.
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
