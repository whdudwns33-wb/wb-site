-- 원장 지시(2026-08)로 학부모 피드백은 이제 원장 승인 클릭 없이 제출 즉시 카카오 알림톡
-- 실발송을 시도한다. 자유 문구 한 덩어리 대신, 알림톡 템플릿의 항목별 변수
-- (선생님/학생명/학습내용/잘한점/보완점)에 정확히 대응하는 값을 따로 저장해야 해서
-- 컬럼을 추가한다. 전부 NULL 허용 컬럼이라 기존 행에는 영향이 없다(단순 ADD COLUMN).
ALTER TABLE feedback_requests ADD COLUMN teacher_name TEXT;
ALTER TABLE feedback_requests ADD COLUMN student_name TEXT;
ALTER TABLE feedback_requests ADD COLUMN content_text TEXT;
ALTER TABLE feedback_requests ADD COLUMN plus_text TEXT;
ALTER TABLE feedback_requests ADD COLUMN minus_text TEXT;
