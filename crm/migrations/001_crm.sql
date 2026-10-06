-- WB 세일즈데스크(wb-crm) D1 스키마. 배포 워크플로우가 매 배포마다 이 파일을 통째로 다시 적용하므로
-- 모든 문장이 IF NOT EXISTS 여야 한다. 컬럼 변경은 새 번호의 파일로 덧붙인다.
-- 보호자 이름·전화 같은 개인정보는 crm_documents.data(JSON) 안에만 있고 저장소·정적 파일에는 없다.
-- HubSpot 토큰은 여기 없다 — 워커 시크릿(HUBSPOT_ACCESS_TOKEN)으로만 산다.

-- 원장 계정은 하나뿐이라 id=1 로 고정한다. 비밀번호는 PBKDF2-SHA256(iterations·salt 별도 저장).
CREATE TABLE IF NOT EXISTS crm_admin (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  password_salt       TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 10000),
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL CHECK (created_at > 0)
);

-- 직원(상담 실장·데스크). 삭제 대신 active=0 — 기록의 by 가 이 id 를 가리키므로 행은 남긴다.
CREATE TABLE IF NOT EXISTS crm_staff (
  id         TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  role       TEXT    NOT NULL DEFAULT 'staff' CHECK (role = 'staff'),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- 직원 연결 코드(1회용, 7일). 원문은 링크로만 나가고 여기엔 sha256 만 남는다.
CREATE TABLE IF NOT EXISTS crm_codes (
  code_hash   TEXT    PRIMARY KEY,
  staff_id    TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL CHECK (expires_at > 0),
  consumed_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at  INTEGER NOT NULL CHECK (created_at > 0)
);
CREATE INDEX IF NOT EXISTS idx_crm_codes_staff ON crm_codes(staff_id, revoked);

-- 기기 토큰. staff_id 는 'admin' 또는 crm_staff.id. TTL 은 last_seen 기준(원장 30일·직원 180일)이라 코드가 판정한다.
CREATE TABLE IF NOT EXISTS crm_tokens (
  token_hash TEXT    PRIMARY KEY,
  staff_id   TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  last_seen  INTEGER NOT NULL CHECK (last_seen >= created_at),
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_crm_tokens_staff ON crm_tokens(staff_id, revoked);

-- 문서 저장소(leads·activities·credits·settings). 컬렉션 허용 목록은 crm-api.mjs 가 유일한 쓰기 주체로서 검사한다(CHECK 없음).
-- deleted 는 소프트 삭제 — since= 동기화로 다른 기기가 지울 수 있게 행을 남긴다.
CREATE TABLE IF NOT EXISTS crm_documents (
  collection TEXT    NOT NULL CHECK (length(collection) BETWEEN 1 AND 40),
  id         TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_crm_documents_updated ON crm_documents(collection, updated_at);

-- HubSpot Contact ↔ 리드 연결표. 가져오기(pull)가 같은 연락처를 두 번 만들지 않게 하는 열쇠. 연락처 하나 = 리드 하나.
CREATE TABLE IF NOT EXISTS crm_hs_links (
  contact_id TEXT    PRIMARY KEY CHECK (length(contact_id) BETWEEN 1 AND 40),
  lead_id    TEXT    NOT NULL UNIQUE CHECK (length(lead_id) BETWEEN 1 AND 160),
  linked_at  INTEGER NOT NULL CHECK (linked_at > 0)
);

-- HubSpot 반영 큐. 리드·기록이 바뀌면 서버가 여기 한 줄을 만들고, 원장이 승인(approved)한 것만 push 가 HubSpot 에 쓴다.
-- track: quick(연락처·노트 같은 단순값) / review(딜 단계 전이). 원장이 "빠른 입력 자동 승인"을 켜면 quick 은 approved 로 태어난다.
-- payload 는 만들 때의 값(딜은 목표 pipeline·stage) — 큐가 순서대로 처리돼야 성사→학원 트라이얼 같은 두 단계 이동이 맞게 간다.
CREATE TABLE IF NOT EXISTS crm_sync_queue (
  id         TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  lead_id    TEXT    NOT NULL CHECK (length(lead_id) BETWEEN 1 AND 160),
  kind       TEXT    NOT NULL CHECK (kind IN ('contact', 'deal', 'note')),
  track      TEXT    NOT NULL CHECK (track IN ('quick', 'review')),
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'done', 'failed', 'rejected')),
  payload    TEXT    NOT NULL,
  result     TEXT,
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  decided_at INTEGER,
  decided_by TEXT,
  done_at    INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_crm_sync_queue_status ON crm_sync_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_sync_queue_lead ON crm_sync_queue(lead_id, status);

-- 작은 상태값(가져오기 커서·마지막 상태 확인 등). 설정 문서와 달리 클라이언트에 내려가지 않는다.
CREATE TABLE IF NOT EXISTS crm_kv (
  key        TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 80),
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);
