-- 센터앱 family.id 는 아동별 고객번호다. 같은 보호자의 형제를 전화번호로 합치지 않는다.
CREATE TABLE IF NOT EXISTS crm_portal_links (
  lead_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL UNIQUE,
  snapshot TEXT,
  checked_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- 포털 연결과 이미 진행 중인 HubSpot 쓰기가 겹치지 않게 한다.
CREATE TABLE IF NOT EXISTS crm_hs_inflight (
  lead_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
