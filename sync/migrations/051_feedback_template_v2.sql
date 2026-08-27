-- 학부모 수업 피드백 알림톡 v2의 승인 템플릿 변수 스냅샷.
-- 기존 v1 행과 발송 이력은 그대로 두고 신규 v2 요청만 아래 세 필드를 사용한다.
ALTER TABLE feedback_requests ADD COLUMN subject_text TEXT;
ALTER TABLE feedback_requests ADD COLUMN homework_text TEXT;
ALTER TABLE feedback_requests ADD COLUMN comment_text TEXT;
