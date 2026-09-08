-- 기존 번호 소유자는 추측하지 않고, 다음 확인 때 학생 본인 또는 엄마로 명시한다.
ALTER TABLE consult_link_contacts
ADD COLUMN phone_owner TEXT NOT NULL DEFAULT 'unknown'
CHECK (phone_owner IN ('unknown','student','mother'));
