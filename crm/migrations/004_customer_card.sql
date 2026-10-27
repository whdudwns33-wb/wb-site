-- 조회 연결만 보관한다. 원본 고객·HubSpot 쓰기 소유권은 바꾸지 않는다.
CREATE TABLE IF NOT EXISTS crm_customer_members (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('child','adult')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_customer_sources (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES crm_customer_members(id),
  app_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE(app_id,source_id)
);
CREATE INDEX IF NOT EXISTS crm_customer_members_lead ON crm_customer_members(lead_id);
CREATE INDEX IF NOT EXISTS crm_customer_sources_lead ON crm_customer_sources(lead_id);
