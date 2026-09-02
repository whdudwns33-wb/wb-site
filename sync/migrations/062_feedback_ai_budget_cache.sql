-- 학부모 피드백 AI 다듬기의 호출 상한과 개인정보 비노출 결과 캐시.
-- 캐시 키는 Worker secret으로 HMAC 처리하며 원문·학생명·학생/수업 ID를 저장하지 않는다.

CREATE TABLE IF NOT EXISTS feedback_polish_daily_usage (
  app           TEXT    NOT NULL CHECK (app = 'task'),
  usage_day_utc TEXT    NOT NULL CHECK (
    length(usage_day_utc) = 10
    AND strftime('%Y-%m-%d', usage_day_utc) = usage_day_utc
  ),
  ai_calls      INTEGER NOT NULL CHECK (ai_calls BETWEEN 1 AND 150),
  updated_at    INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (app, usage_day_utc)
);

CREATE TABLE IF NOT EXISTS feedback_polish_cache (
  app            TEXT    NOT NULL CHECK (app = 'task'),
  cache_key      TEXT    NOT NULL CHECK (
    length(cache_key) = 64 AND cache_key NOT GLOB '*[^0-9a-f]*'
  ),
  prompt_version TEXT    NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 32),
  state          TEXT    NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
  result_text    TEXT,
  failure_reason TEXT,
  claim_token    TEXT,
  lease_until    INTEGER,
  max_chars      INTEGER NOT NULL CHECK (max_chars BETWEEN 20 AND 600),
  created_at     INTEGER NOT NULL CHECK (created_at > 0),
  updated_at     INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at     INTEGER NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (app, cache_key),
  CHECK (
    (state = 'pending'
      AND result_text IS NULL
      AND failure_reason IS NULL
      AND claim_token IS NOT NULL
      AND length(claim_token) = 64
      AND claim_token NOT GLOB '*[^0-9a-f]*'
      AND lease_until IS NOT NULL
      AND lease_until > created_at)
    OR
    (state = 'ready'
      AND result_text IS NOT NULL
      AND length(result_text) BETWEEN 20 AND max_chars
      AND failure_reason IS NULL
      AND claim_token IS NULL
      AND lease_until IS NULL)
    OR
    (state = 'failed'
      AND result_text IS NULL
      AND failure_reason IN ('busy', 'ai_failed', 'ai_invalid')
      AND claim_token IS NULL
      AND lease_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_feedback_polish_cache_expiry
  ON feedback_polish_cache(app, expires_at);
