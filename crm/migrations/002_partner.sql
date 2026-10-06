-- 002 — 파트너 학원 연계. 파트너 포털(외부 사용자)의 연결 코드·기기 토큰을 직원 표와 분리해 둔다 —
-- 나중에 파트너 기능을 별도 워커로 떼어낼 때 crm_partner_* 표만 옮기면 되게(파트너 명단·소개 기록은 crm_documents 의
-- partners·referrals 컬렉션, 리드와의 연결은 leads.partnerId 뿐). 전부 IF NOT EXISTS.

-- 파트너 연결 코드(1회용, 7일). 원문은 링크로만 나가고 여기엔 sha256 만 남는다. partner_id 는 partners 문서 id.
CREATE TABLE IF NOT EXISTS crm_partner_codes (
  code_hash   TEXT    PRIMARY KEY,
  partner_id  TEXT    NOT NULL CHECK (length(partner_id) BETWEEN 1 AND 160),
  expires_at  INTEGER NOT NULL CHECK (expires_at > 0),
  consumed_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at  INTEGER NOT NULL CHECK (created_at > 0)
);
CREATE INDEX IF NOT EXISTS idx_crm_partner_codes_partner ON crm_partner_codes(partner_id, revoked);

-- 파트너 기기 토큰. TTL 은 last_seen 기준 180일(코드가 판정). 파트너를 일시 중지하면 토큰이 살아 있어도 막힌다.
CREATE TABLE IF NOT EXISTS crm_partner_tokens (
  token_hash TEXT    PRIMARY KEY,
  partner_id TEXT    NOT NULL CHECK (length(partner_id) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  last_seen  INTEGER NOT NULL CHECK (last_seen >= created_at),
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_crm_partner_tokens_partner ON crm_partner_tokens(partner_id, revoked);
