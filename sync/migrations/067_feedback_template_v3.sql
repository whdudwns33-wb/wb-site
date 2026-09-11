-- 학부모 수업 피드백 알림톡 v3의 안내사항 변수 스냅샷.
-- v2 요청은 이 값을 NULL로 유지하며, v3에서만 필수로 검증한다.
ALTER TABLE feedback_requests ADD COLUMN notice_text TEXT;
