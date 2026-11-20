-- 점검 세션은 직원 기기·출퇴근 정보와 분리한다. 원문 토큰은 쿠키에만 둔다.
CREATE TABLE IF NOT EXISTS task_checker_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
