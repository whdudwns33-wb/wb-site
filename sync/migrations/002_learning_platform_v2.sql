-- WB learning platform v2 foundation (D1 / SQLite)
--
-- This migration only expands the schema. The legacy staff/tasks/checks tables
-- remain untouched and can coexist through lp_legacy_links.
--
-- Security boundaries:
--   * provider credentials and bearer tokens are never stored in plaintext;
--   * question/problem/answer bodies are not stored in D1;
--   * external identifiers are stored as keyed hashes only;
--   * mutable rows use server-controlled revisions;
--   * events, results and transitions are append-only.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lp_schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Seoul',
  status        TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_principals (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES lp_tenants(id),
  principal_type  TEXT NOT NULL CHECK (
    principal_type IN ('owner', 'staff', 'student', 'guardian', 'service')
  ),
  legacy_staff_id TEXT,
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, legacy_staff_id)
);

CREATE INDEX IF NOT EXISTS idx_lp_principals_tenant_type
  ON lp_principals(tenant_id, principal_type, status);

CREATE TABLE IF NOT EXISTS lp_roles (
  code          TEXT PRIMARY KEY,
  description   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_role_permissions (
  role_code       TEXT NOT NULL REFERENCES lp_roles(code),
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS lp_role_bindings (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES lp_tenants(id),
  principal_id  TEXT NOT NULL REFERENCES lp_principals(id),
  role_code     TEXT NOT NULL REFERENCES lp_roles(code),
  scope_type    TEXT NOT NULL CHECK (
    scope_type IN ('tenant', 'student', 'program', 'campaign')
  ),
  scope_id      TEXT NOT NULL DEFAULT '*',
  valid_from    INTEGER,
  valid_until   INTEGER,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at    INTEGER NOT NULL,
  UNIQUE (tenant_id, principal_id, role_code, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_lp_role_bindings_principal
  ON lp_role_bindings(tenant_id, principal_id, valid_until);

CREATE TABLE IF NOT EXISTS lp_sessions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES lp_tenants(id),
  principal_id  TEXT NOT NULL REFERENCES lp_principals(id),
  token_hash    TEXT NOT NULL UNIQUE,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_seen_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_lp_sessions_principal
  ON lp_sessions(tenant_id, principal_id, expires_at);

CREATE TABLE IF NOT EXISTS lp_provider_registry (
  id                 TEXT PRIMARY KEY,
  provider_key       TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  adapter_version    INTEGER NOT NULL DEFAULT 1 CHECK (adapter_version > 0),
  capabilities_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  status             TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'disabled')),
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_student_programs (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES lp_tenants(id),
  student_id             TEXT NOT NULL REFERENCES lp_principals(id),
  provider_id            TEXT NOT NULL REFERENCES lp_provider_registry(id),
  program_code           TEXT NOT NULL,
  external_subject_hash  TEXT,
  level_code             TEXT,
  status                 TEXT NOT NULL CHECK (
    status IN ('candidate', 'planned', 'active', 'paused', 'completed', 'cancelled')
  ),
  starts_on              TEXT,
  ends_on                TEXT,
  settings_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  idempotency_key        TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  deleted_at             INTEGER,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lp_student_programs_student
  ON lp_student_programs(tenant_id, student_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_student_programs_external
  ON lp_student_programs(tenant_id, provider_id, external_subject_hash, program_code)
  WHERE external_subject_hash IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS lp_planner_items (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES lp_tenants(id),
  student_id      TEXT NOT NULL REFERENCES lp_principals(id),
  source_type     TEXT NOT NULL CHECK (
    source_type IN ('manual', 'assessment', 'prep_campaign', 'twin_problem', 'legacy')
  ),
  source_id       TEXT,
  source_version  INTEGER,
  title           TEXT NOT NULL,
  detail          TEXT,
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status          TEXT NOT NULL CHECK (status IN (
    'planned', 'available', 'in_progress', 'submitted', 'completed',
    'blocked', 'skipped', 'cancelled', 'expired'
  )),
  available_at    INTEGER,
  due_at          INTEGER,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Seoul',
  idempotency_key TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by      TEXT REFERENCES lp_principals(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_planner_items_source
  ON lp_planner_items(tenant_id, student_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lp_planner_items_due
  ON lp_planner_items(tenant_id, student_id, status, due_at);

CREATE TABLE IF NOT EXISTS lp_planner_transitions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES lp_tenants(id),
  planner_item_id  TEXT NOT NULL REFERENCES lp_planner_items(id),
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor_type       TEXT NOT NULL CHECK (
    actor_type IN ('user', 'system', 'manual_import', 'legacy_bridge')
  ),
  actor_id         TEXT,
  reason_code      TEXT,
  metadata_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  idempotency_key  TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL,
  UNIQUE (planner_item_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lp_assessment_registry (
  id                     TEXT PRIMARY KEY,
  provider_id            TEXT NOT NULL REFERENCES lp_provider_registry(id),
  registry_key           TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  subject_code           TEXT,
  grade_band             TEXT,
  assessment_type        TEXT NOT NULL,
  result_schema_version  INTEGER NOT NULL DEFAULT 1 CHECK (result_schema_version > 0),
  metadata_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  status                 TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'retired')),
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (provider_id, registry_key)
);

CREATE TABLE IF NOT EXISTS lp_assessment_templates (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES lp_tenants(id),
  template_key    TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  active_version  INTEGER NOT NULL DEFAULT 1 CHECK (active_version > 0),
  status          TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by      TEXT REFERENCES lp_principals(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, template_key)
);

CREATE TABLE IF NOT EXISTS lp_assessment_template_versions (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES lp_tenants(id),
  template_id              TEXT NOT NULL REFERENCES lp_assessment_templates(id),
  version_no               INTEGER NOT NULL CHECK (version_no > 0),
  assessment_registry_id   TEXT NOT NULL REFERENCES lp_assessment_registry(id),
  schedule_schema_version  INTEGER NOT NULL DEFAULT 1,
  schedule_rule_json       TEXT NOT NULL CHECK (json_valid(schedule_rule_json)),
  timezone                 TEXT NOT NULL DEFAULT 'Asia/Seoul',
  window_open_offset_min   INTEGER NOT NULL DEFAULT 0,
  window_close_offset_min  INTEGER NOT NULL DEFAULT 1440,
  instructions             TEXT,
  config_json              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_by               TEXT REFERENCES lp_principals(id),
  created_at               INTEGER NOT NULL,
  UNIQUE (template_id, version_no)
);

CREATE TABLE IF NOT EXISTS lp_assessment_occurrences (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES lp_tenants(id),
  student_id              TEXT NOT NULL REFERENCES lp_principals(id),
  student_program_id      TEXT REFERENCES lp_student_programs(id),
  template_version_id     TEXT NOT NULL REFERENCES lp_assessment_template_versions(id),
  cycle_key               TEXT NOT NULL,
  scheduled_for           INTEGER NOT NULL,
  window_opens_at         INTEGER NOT NULL,
  window_closes_at        INTEGER NOT NULL,
  due_at                  INTEGER NOT NULL,
  schedule_snapshot_json  TEXT NOT NULL CHECK (json_valid(schedule_snapshot_json)),
  status                  TEXT NOT NULL CHECK (status IN (
    'scheduled', 'available', 'started', 'submitted', 'scored',
    'released', 'missed', 'cancelled'
  )),
  idempotency_key         TEXT NOT NULL,
  revision                INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (student_id, template_version_id, cycle_key)
);

CREATE INDEX IF NOT EXISTS idx_lp_assessment_occurrences_due
  ON lp_assessment_occurrences(tenant_id, student_id, status, due_at);

CREATE TABLE IF NOT EXISTS lp_assessment_results (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES lp_tenants(id),
  occurrence_id      TEXT NOT NULL REFERENCES lp_assessment_occurrences(id),
  revision_no        INTEGER NOT NULL CHECK (revision_no > 0),
  schema_version     INTEGER NOT NULL CHECK (schema_version > 0),
  validation_status  TEXT NOT NULL CHECK (
    validation_status IN ('pending', 'valid', 'invalid', 'superseded')
  ),
  release_status     TEXT NOT NULL CHECK (
    release_status IN ('private', 'reviewed', 'released')
  ),
  overall_score      REAL,
  score_scale        TEXT,
  level_code         TEXT,
  percentile         REAL,
  metrics_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(metrics_json)),
  source_event_id    TEXT,
  idempotency_key    TEXT NOT NULL,
  created_by         TEXT,
  created_at         INTEGER NOT NULL,
  reviewed_by        TEXT REFERENCES lp_principals(id),
  reviewed_at        INTEGER,
  released_at        INTEGER,
  UNIQUE (occurrence_id, revision_no),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lp_assessment_results_occurrence
  ON lp_assessment_results(tenant_id, occurrence_id, release_status);

CREATE TABLE IF NOT EXISTS lp_prep_campaigns (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES lp_tenants(id),
  campaign_type         TEXT NOT NULL CHECK (
    campaign_type IN ('general', 'elementary_choice_exam')
  ),
  name                  TEXT NOT NULL,
  target_assessment_id  TEXT REFERENCES lp_assessment_registry(id),
  starts_at             INTEGER NOT NULL,
  selection_closes_at   INTEGER,
  ends_at               INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (
    status IN ('draft', 'selection_open', 'active', 'completed', 'cancelled')
  ),
  config_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  idempotency_key       TEXT NOT NULL,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by            TEXT REFERENCES lp_principals(id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lp_prep_campaign_options (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES lp_prep_campaigns(id),
  template_version_id  TEXT NOT NULL REFERENCES lp_assessment_template_versions(id),
  option_code          TEXT NOT NULL,
  label                TEXT NOT NULL,
  sort_order           INTEGER NOT NULL,
  eligibility_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(eligibility_json)),
  capacity             INTEGER,
  UNIQUE (campaign_id, option_code)
);

CREATE TABLE IF NOT EXISTS lp_prep_campaign_members (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES lp_prep_campaigns(id),
  student_id          TEXT NOT NULL REFERENCES lp_principals(id),
  selected_option_id  TEXT REFERENCES lp_prep_campaign_options(id),
  selection_status    TEXT NOT NULL CHECK (
    selection_status IN ('unselected', 'selected', 'locked', 'waived')
  ),
  revision            INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (campaign_id, student_id)
);

CREATE TABLE IF NOT EXISTS lp_prep_selection_events (
  id               TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES lp_prep_campaigns(id),
  student_id       TEXT NOT NULL REFERENCES lp_principals(id),
  option_id        TEXT REFERENCES lp_prep_campaign_options(id),
  action           TEXT NOT NULL CHECK (action IN ('select', 'change', 'lock', 'waive')),
  actor_id         TEXT REFERENCES lp_principals(id),
  idempotency_key  TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL,
  UNIQUE (campaign_id, student_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lp_skill_registry (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT REFERENCES lp_provider_registry(id),
  taxonomy_version  TEXT NOT NULL,
  skill_code        TEXT NOT NULL,
  parent_skill_id   TEXT REFERENCES lp_skill_registry(id),
  subject_code      TEXT,
  display_name      TEXT NOT NULL,
  UNIQUE (provider_id, taxonomy_version, skill_code)
);

CREATE TABLE IF NOT EXISTS lp_wrong_answers (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES lp_tenants(id),
  student_id             TEXT NOT NULL REFERENCES lp_principals(id),
  occurrence_id          TEXT REFERENCES lp_assessment_occurrences(id),
  result_id              TEXT REFERENCES lp_assessment_results(id),
  skill_id               TEXT REFERENCES lp_skill_registry(id),
  provider_question_hash TEXT,
  question_ref           TEXT,
  error_code             TEXT,
  status                 TEXT NOT NULL CHECK (
    status IN ('open', 'practicing', 'mastered', 'dismissed')
  ),
  idempotency_key        TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  first_seen_at          INTEGER NOT NULL,
  last_seen_at           INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lp_wrong_answers_student
  ON lp_wrong_answers(tenant_id, student_id, status, last_seen_at);

CREATE TABLE IF NOT EXISTS lp_twin_problems (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES lp_tenants(id),
  wrong_answer_id      TEXT NOT NULL REFERENCES lp_wrong_answers(id),
  variant_no           INTEGER NOT NULL CHECK (variant_no > 0),
  generator_key        TEXT NOT NULL,
  generator_version    TEXT NOT NULL,
  problem_ref          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (
    status IN ('candidate', 'assigned', 'retired', 'invalid')
  ),
  idempotency_key      TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  UNIQUE (wrong_answer_id, variant_no, generator_version),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lp_twin_attempts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES lp_tenants(id),
  twin_problem_id  TEXT NOT NULL REFERENCES lp_twin_problems(id),
  student_id       TEXT NOT NULL REFERENCES lp_principals(id),
  attempt_no       INTEGER NOT NULL CHECK (attempt_no > 0),
  outcome          TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect', 'partial')),
  score            REAL,
  idempotency_key  TEXT NOT NULL,
  submitted_at     INTEGER NOT NULL,
  UNIQUE (twin_problem_id, student_id, attempt_no),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lp_mastery_evidence (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES lp_tenants(id),
  student_id       TEXT NOT NULL REFERENCES lp_principals(id),
  skill_id         TEXT NOT NULL REFERENCES lp_skill_registry(id),
  source_type      TEXT NOT NULL CHECK (
    source_type IN ('assessment_result', 'twin_attempt', 'manual_import')
  ),
  source_id        TEXT NOT NULL,
  outcome          REAL NOT NULL,
  weight           REAL NOT NULL DEFAULT 1,
  model_version    TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lp_student_mastery (
  tenant_id         TEXT NOT NULL REFERENCES lp_tenants(id),
  student_id        TEXT NOT NULL REFERENCES lp_principals(id),
  skill_id          TEXT NOT NULL REFERENCES lp_skill_registry(id),
  model_version     TEXT NOT NULL,
  mastery_score     REAL NOT NULL,
  confidence        REAL NOT NULL,
  evidence_count    INTEGER NOT NULL,
  last_evidence_at  INTEGER NOT NULL,
  revision          INTEGER NOT NULL CHECK (revision > 0),
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, student_id, skill_id, model_version)
);

CREATE TABLE IF NOT EXISTS lp_integration_events (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES lp_tenants(id),
  provider_id       TEXT NOT NULL REFERENCES lp_provider_registry(id),
  source_mode       TEXT NOT NULL CHECK (source_mode IN ('manual_candidate', 'manual_import')),
  idempotency_key   TEXT NOT NULL,
  provider_event_id TEXT,
  event_type        TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  candidate_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(candidate_json)),
  status            TEXT NOT NULL CHECK (
    status IN ('candidate', 'validated', 'applied', 'rejected')
  ),
  received_by       TEXT REFERENCES lp_principals(id),
  received_at       INTEGER NOT NULL,
  processed_at      INTEGER,
  error_code        TEXT,
  UNIQUE (tenant_id, provider_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lp_integration_events_status
  ON lp_integration_events(tenant_id, provider_id, status, received_at);

CREATE TABLE IF NOT EXISTS lp_change_feed (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL REFERENCES lp_tenants(id),
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  operation    TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  revision     INTEGER NOT NULL,
  changed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lp_change_feed_tenant_seq
  ON lp_change_feed(tenant_id, seq);

CREATE TABLE IF NOT EXISTS lp_audit_events (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES lp_tenants(id),
  actor_id       TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  request_id     TEXT,
  before_hash    TEXT,
  after_hash     TEXT,
  metadata_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lp_audit_entity
  ON lp_audit_events(tenant_id, entity_type, entity_id, occurred_at);

CREATE TABLE IF NOT EXISTS lp_legacy_links (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES lp_tenants(id),
  v2_entity_type      TEXT NOT NULL,
  v2_entity_id        TEXT NOT NULL,
  legacy_table        TEXT NOT NULL CHECK (legacy_table IN ('staff', 'tasks', 'checks')),
  legacy_key          TEXT NOT NULL,
  sync_direction      TEXT NOT NULL CHECK (
    sync_direction IN ('v2_to_v1', 'v1_to_v2', 'both', 'frozen')
  ),
  bridge_version      INTEGER NOT NULL DEFAULT 1,
  last_v1_updated_at  INTEGER,
  last_v2_revision    INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (tenant_id, legacy_table, legacy_key),
  UNIQUE (tenant_id, v2_entity_type, v2_entity_id, legacy_table)
);

INSERT OR IGNORE INTO lp_roles(code, description) VALUES
  ('owner', '센터 전체 관리'),
  ('counselor', '지정 학생 평가 및 상담 관리'),
  ('teacher', '지정 학생 플래너 관리'),
  ('student', '본인 플래너와 공개 결과 이용'),
  ('guardian', '연결 학생 공개 결과 열람'),
  ('integration_service', '정규화된 연동 후보 등록');

INSERT OR IGNORE INTO lp_role_permissions(role_code, permission_code) VALUES
  ('owner', '*'),
  ('counselor', 'provider.read'),
  ('counselor', 'program.read'),
  ('counselor', 'program.write'),
  ('counselor', 'planner.read'),
  ('counselor', 'planner.write'),
  ('counselor', 'assessment.read'),
  ('counselor', 'assessment.write'),
  ('counselor', 'assessment.result.write'),
  ('counselor', 'assessment.result.review'),
  ('counselor', 'prep.write'),
  ('counselor', 'practice.write'),
  ('counselor', 'mastery.read'),
  ('counselor', 'mastery.write'),
  ('counselor', 'integration.candidate.write'),
  ('teacher', 'program.read'),
  ('teacher', 'planner.read'),
  ('teacher', 'planner.write'),
  ('teacher', 'assessment.read'),
  ('teacher', 'prep.select'),
  ('teacher', 'practice.write'),
  ('teacher', 'mastery.read'),
  ('teacher', 'mastery.write'),
  ('student', 'planner.read'),
  ('student', 'planner.write'),
  ('student', 'assessment.read'),
  ('student', 'prep.select'),
  ('student', 'practice.write'),
  ('student', 'mastery.read'),
  ('guardian', 'assessment.read'),
  ('guardian', 'planner.read'),
  ('integration_service', 'integration.candidate.write');

INSERT OR IGNORE INTO lp_provider_registry(
  id, provider_key, display_name, adapter_version, capabilities_json,
  status, revision, created_at, updated_at
) VALUES
  ('provider-wb-manual', 'wb_manual', 'WB 수동 등록', 1,
   '{"manualCandidate":true}', 'active', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('provider-studyforce', 'studyforce', 'StudyForce', 1,
   '{"manualCandidate":true,"csv":true,"progress":true,"externalSync":false}', 'candidate', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('provider-classcard', 'classcard', 'ClassCard', 1,
   '{"manualCandidate":true,"csv":true,"json":true,"score":true,"review":true,"externalSync":false}', 'candidate', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('provider-metamath', 'metamath', 'MetaMath', 1,
   '{"manualCandidate":true,"assessment":true,"twinProblemReference":true,"externalSync":false}', 'candidate', 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('provider-nelt', 'nelt', 'NELT', 1,
   '{"manualCandidate":true,"assessment":true,"quarterly":true,"externalSync":false}', 'candidate', 1, unixepoch('now') * 1000, unixepoch('now') * 1000);

INSERT OR IGNORE INTO lp_schema_migrations(version, name, applied_at)
VALUES (2, 'learning_platform_v2', unixepoch('now') * 1000);

UPDATE lp_schema_migrations
SET applied_at = unixepoch('now') * 1000
WHERE version = 2 AND applied_at = 0;
