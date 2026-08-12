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
AFTER UPDATE OF enabled, guardian_identity_hash ON guardian_portal_access
WHEN NEW.enabled = 0 OR OLD.guardian_identity_hash IS NOT NEW.guardian_identity_hash
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
