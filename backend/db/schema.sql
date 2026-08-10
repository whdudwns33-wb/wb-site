-- 그림검사 AI 해석 웹 · 백엔드 DB 스키마 (PostgreSQL, 프로덕션 대상)
-- 개발 서버는 인메모리 store.mjs가 이 구조를 그대로 미러링합니다.
-- 아동 민감정보: 민감 컬럼 암호화 + 한국 리전 + 접근 최소화 전제.

CREATE TYPE test_type   AS ENUM ('HTP','KFD','DAP','FREE');
CREATE TYPE sub_status  AS ENUM ('created','consent_pending','uploaded','processing',
                                 'reviewing','escalated','confirmed','published',
                                 'rejected','expired','purged');
CREATE TYPE conf_level  AS ENUM ('high','mid','low');
CREATE TYPE hyp_status  AS ENUM ('ai_suggested','accepted','edited','rejected');
CREATE TYPE user_role   AS ENUM ('parent','expert','admin');

-- 아동(식별 최소화: 실명 대신 별명)
CREATE TABLE child (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias              TEXT NOT NULL,
  birth_year         INT,
  sex                TEXT,
  context_note       TEXT,
  guardian_contact_enc BYTEA,          -- 암호화 저장
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 동의(범위·버전 분리)
CREATE TABLE consent (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_verified  BOOLEAN NOT NULL DEFAULT false,
  scope              JSONB NOT NULL,   -- {analysis,store,improve}
  policy_version     TEXT NOT NULL,
  signed_at          TIMESTAMPTZ,
  ip_hash            TEXT
);

-- 제출
CREATE TABLE submission (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id           UUID REFERENCES child(id),
  test_type          test_type NOT NULL,
  status             sub_status NOT NULL DEFAULT 'created',
  image_key          TEXT,             -- 비공개 스토리지 키
  meta               JSONB NOT NULL DEFAULT '{}',
  consent_id         UUID REFERENCES consent(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_at           TIMESTAMPTZ       -- 도래 시 배치 파기
);

-- S1 관찰
CREATE TABLE observation (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      UUID REFERENCES submission(id) ON DELETE CASCADE,
  element            TEXT NOT NULL,
  attributes         JSONB NOT NULL DEFAULT '{}',
  note               TEXT,
  source             TEXT NOT NULL DEFAULT 'ai',   -- ai/expert
  vision_confidence  conf_level
);

-- S2 가설 (콘솔이 직접 사용)
CREATE TABLE hypothesis (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      UUID REFERENCES submission(id) ON DELETE CASCADE,
  element            TEXT NOT NULL,
  observation        TEXT NOT NULL,
  text               TEXT NOT NULL,
  confidence         conf_level NOT NULL,
  age_adjustment     TEXT,
  caveats            JSONB NOT NULL DEFAULT '[]',
  status             hyp_status NOT NULL DEFAULT 'ai_suggested',
  edited_text        TEXT,
  expert_note        TEXT,
  needs_expert_check BOOLEAN NOT NULL DEFAULT true
);

-- S3 해석
CREATE TABLE interpretation (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      UUID REFERENCES submission(id) ON DELETE CASCADE,
  expert_id          UUID,
  summary_expert     TEXT,
  parent_preview     TEXT,
  summary_parent     TEXT,
  confirmed_at       TIMESTAMPTZ
);

-- 학부모 리포트(접근 제어)
CREATE TABLE parent_report (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      UUID REFERENCES submission(id) ON DELETE CASCADE,
  share_token        TEXT UNIQUE NOT NULL,
  expires_at         TIMESTAMPTZ,
  viewed_at          TIMESTAMPTZ,
  cta_clicked        BOOLEAN NOT NULL DEFAULT false
);

-- 위기 이벤트
CREATE TABLE crisis_event (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      UUID REFERENCES submission(id) ON DELETE CASCADE,
  level              TEXT NOT NULL,    -- watch/urgent
  flags              JSONB NOT NULL DEFAULT '[]',
  handled_by         UUID,
  action_taken       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 사용자(전문가/관리자)
CREATE TABLE app_user (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role               user_role NOT NULL,
  name               TEXT,
  email              TEXT UNIQUE,
  auth_ref           TEXT,
  active             BOOLEAN NOT NULL DEFAULT true
);

-- 감사로그(불변)
CREATE TABLE audit_log (
  id                 BIGSERIAL PRIMARY KEY,
  actor_id           UUID,
  action             TEXT NOT NULL,
  target_type        TEXT,
  target_id          UUID,
  meta               JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 파이프라인 잡
CREATE TABLE job (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      UUID REFERENCES submission(id) ON DELETE CASCADE,
  stage              TEXT NOT NULL,    -- S0/S1/S2/S3a/S3c
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INT NOT NULL DEFAULT 0,
  error              TEXT,
  run_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_submission_status ON submission(status);
CREATE INDEX idx_hypothesis_sub    ON hypothesis(submission_id);
CREATE INDEX idx_observation_sub   ON observation(submission_id);
