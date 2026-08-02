import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const moduleSource = await readFile(new URL('./learning-v2.js', import.meta.url), 'utf8');
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64');
const { createLearningV2Handler, isLearningV2Request } = await import(moduleUrl);
const migration = await readFile(new URL('./migrations/002_learning_platform_v2.sql', import.meta.url), 'utf8');

class D1StatementMock {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1StatementMock(this.database, this.sql, bindings);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.bindings);
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0)
      }
    };
  }
}

class D1DatabaseMock {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementMock(this.database, sql);
  }

  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  database.exec(`
    INSERT INTO lp_tenants(id,name,timezone,status,created_at,updated_at)
    VALUES('tenant:test','Test Center','Asia/Seoul','active',1,1);

    INSERT INTO lp_principals(
      id,tenant_id,principal_type,legacy_staff_id,display_name,status,revision,created_at,updated_at
    ) VALUES
      ('principal:owner','tenant:test','owner',NULL,'Owner','active',1,1,1),
      ('student:one','tenant:test','student','legacy-1','Student One','active',1,1,1),
      ('student:two','tenant:test','student','legacy-2','Student Two','active',1,1,1);

    INSERT INTO lp_skill_registry(
      id,provider_id,taxonomy_version,skill_code,parent_skill_id,subject_code,display_name
    ) VALUES(
      'skill:fraction-add','provider-wb-manual','mvp-1','fraction.add',NULL,'math','분수 덧셈'
    );
  `);
  return database;
}

function ownerActor() {
  return {
    tenantId: 'tenant:test',
    principalId: 'principal:owner',
    principalType: 'owner',
    grants: [{ permission: '*', scopeType: 'tenant', scopeId: '*' }]
  };
}

function createHarness(actor = ownerActor()) {
  const database = createDatabase();
  const env = {
    DB: new D1DatabaseMock(database),
    ALLOW_ORIGIN: 'https://app.example.test',
    LEARNING_V2_ENABLED: 'true'
  };
  let idSequence = 0;
  const handler = createLearningV2Handler({
    authenticate: async () => actor,
    now: () => 1_700_000_000_000,
    makeId: prefix => `${prefix}:test-${++idSequence}`
  });
  return { database, env, handler };
}

async function call(handler, env, path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.ifMatch !== undefined) headers.set('If-Match', String(options.ifMatch));
  const request = new Request('https://worker.example.test' + path, {
    method: options.method || 'GET', headers, body
  });
  const response = await handler(request, env, {});
  const data = response ? await response.json() : null;
  return { response, data };
}

test('migration creates the minimum v2 model without plaintext secret or problem-body columns', () => {
  const database = createDatabase();
  const tables = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lp_%'"
  ).all().map(row => row.name));
  const required = [
    'lp_provider_registry', 'lp_student_programs', 'lp_planner_items', 'lp_planner_transitions',
    'lp_assessment_registry', 'lp_assessment_templates', 'lp_assessment_template_versions',
    'lp_assessment_occurrences', 'lp_assessment_results', 'lp_prep_campaigns',
    'lp_prep_campaign_options', 'lp_prep_selection_events', 'lp_wrong_answers',
    'lp_twin_problems', 'lp_twin_attempts', 'lp_mastery_evidence', 'lp_student_mastery',
    'lp_integration_events', 'lp_change_feed', 'lp_audit_events', 'lp_role_bindings',
    'lp_legacy_links'
  ];
  required.forEach(name => assert.ok(tables.has(name), `${name} missing`));

  const forbiddenColumn = /^(secret|password|api_key|access_token|refresh_token|raw_payload|raw_html|question_content|problem_content|answer)$/i;
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    columns.forEach(column => assert.equal(forbiddenColumn.test(column.name), false,
      `${table}.${column.name} must not store plaintext sensitive content`));
  }

  const providers = database.prepare(
    'SELECT provider_key,status FROM lp_provider_registry ORDER BY provider_key'
  ).all();
  assert.deepEqual(providers.map(row => row.provider_key), ['classcard', 'metamath', 'nelt', 'studyforce', 'wb_manual']);
  assert.equal(providers.find(row => row.provider_key === 'metamath').status, 'candidate');
  database.close();
});

test('router is side-effect free for unrelated paths and exposes a public capability health check', async () => {
  const { env, handler, database } = createHarness();
  const unrelated = new Request('https://worker.example.test/sync');
  assert.equal(isLearningV2Request(unrelated), false);
  assert.equal(await handler(unrelated, env, {}), null);

  const { response, data } = await call(handler, env, '/api/v2/learning/health');
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.capabilities.providerMode, 'manual-candidate-only');
  assert.equal(data.capabilities.storesSecrets, false);
  assert.equal(data.capabilities.storesQuestionBodies, false);
  database.close();
});

test('v2 MVP flows enforce idempotency, revisions, normalized imports, and reference-only practice data', async () => {
  const { env, handler, database } = createHarness();

  const providers = await call(handler, env, '/api/v2/learning/providers');
  assert.equal(providers.response.status, 200);
  assert.equal(providers.data.items.length, 5);

  const programRequest = {
    method: 'POST', idempotencyKey: 'program:test-0001',
    body: {
      studentId: 'student:one', providerKey: 'metamath', programCode: 'math-core',
      externalSubjectHash: 'a'.repeat(64), status: 'candidate', settings: { grade: 5 }
    }
  };
  const program = await call(handler, env, '/api/v2/learning/student-programs', programRequest);
  assert.equal(program.response.status, 201);
  const programReplay = await call(handler, env, '/api/v2/learning/student-programs', programRequest);
  assert.equal(programReplay.response.status, 200);
  assert.equal(programReplay.data.replayed, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM lp_student_programs').get().n, 1);

  const planner = await call(handler, env, '/api/v2/learning/planner/items', {
    method: 'POST', idempotencyKey: 'planner:test-0001',
    body: {
      studentId: 'student:one', sourceType: 'manual', title: '진단평가 준비',
      status: 'planned', availableAt: 1_699_999_000_000, dueAt: 1_700_001_000_000
    }
  });
  assert.equal(planner.response.status, 201);
  assert.equal(planner.data.item.revision, 1);

  const transitioned = await call(handler, env,
    `/api/v2/learning/planner/items/${planner.data.item.id}/transitions`, {
      method: 'POST', idempotencyKey: 'transition:test-0001', ifMatch: 1,
      body: { toStatus: 'available', reasonCode: 'window_open' }
    });
  assert.equal(transitioned.response.status, 200);
  assert.equal(transitioned.data.item.status, 'available');
  assert.equal(transitioned.data.item.revision, 2);

  const transitionReplay = await call(handler, env,
    `/api/v2/learning/planner/items/${planner.data.item.id}/transitions`, {
      method: 'POST', idempotencyKey: 'transition:test-0001', ifMatch: 1,
      body: { toStatus: 'available' }
    });
  assert.equal(transitionReplay.response.status, 200);
  assert.equal(transitionReplay.data.replayed, true);

  const staleTransition = await call(handler, env,
    `/api/v2/learning/planner/items/${planner.data.item.id}/transitions`, {
      method: 'POST', idempotencyKey: 'transition:test-0002', ifMatch: 1,
      body: { toStatus: 'in_progress' }
    });
  assert.equal(staleTransition.response.status, 409);
  assert.equal(staleTransition.data.error.code, 'revision_conflict');

  const registry = await call(handler, env, '/api/v2/learning/assessments/registry', {
    method: 'POST', idempotencyKey: 'registry:test-0001',
    body: {
      providerKey: 'metamath', registryKey: 'diagnostic-v1', displayName: 'MetaMath 진단',
      subjectCode: 'math', gradeBand: 'elementary', assessmentType: 'diagnostic',
      resultSchemaVersion: 1
    }
  });
  assert.equal(registry.response.status, 201);

  const template = await call(handler, env, '/api/v2/learning/assessments/templates', {
    method: 'POST', idempotencyKey: 'template:test-0001',
    body: {
      assessmentRegistryId: registry.data.id, templateKey: 'weekly-math',
      displayName: '주간 수학 진단',
      scheduleRule: { frequency: 'weekly', interval: 1, weekdays: [1] },
      windowOpenOffsetMin: -60, windowCloseOffsetMin: 1440
    }
  });
  assert.equal(template.response.status, 201);

  const occurrence = await call(handler, env, '/api/v2/learning/assessments/occurrences', {
    method: 'POST', idempotencyKey: 'occurrence:test-0001',
    body: {
      studentId: 'student:one', studentProgramId: program.data.item.id,
      templateVersionId: template.data.versionId, cycleKey: '2026-W32',
      windowOpensAt: 1_699_999_000_000, scheduledFor: 1_700_000_000_000,
      dueAt: 1_700_001_000_000, windowClosesAt: 1_700_002_000_000
    }
  });
  assert.equal(occurrence.response.status, 201);
  assert.ok(occurrence.data.plannerItemId);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS n FROM lp_planner_items WHERE source_type='assessment'"
  ).get().n, 1);

  const rejectedResult = await call(handler, env, '/api/v2/learning/assessments/results', {
    method: 'POST', idempotencyKey: 'result:test-bad1',
    body: {
      occurrenceId: occurrence.data.item.id, schemaVersion: 1,
      questionContent: 'raw problem text must never be stored'
    }
  });
  assert.equal(rejectedResult.response.status, 400);
  assert.equal(rejectedResult.data.error.code, 'sensitive_field_rejected');

  const result = await call(handler, env, '/api/v2/learning/assessments/results', {
    method: 'POST', idempotencyKey: 'result:test-0001',
    body: {
      occurrenceId: occurrence.data.item.id, schemaVersion: 1,
      overallScore: 82, scoreScale: '0-100', levelCode: 'L4', percentile: 71,
      metrics: [{ code: 'algebra', domain: 'math', valueNumber: 0.78, unit: 'ratio' }]
    }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.revisionNo, 1);
  assert.equal(database.prepare('SELECT release_status FROM lp_assessment_results WHERE id=?')
    .get(result.data.id).release_status, 'private');

  const campaign = await call(handler, env, '/api/v2/learning/prep-campaigns', {
    method: 'POST', idempotencyKey: 'campaign:test-0001',
    body: {
      campaignType: 'elementary_choice_exam', name: '초등 선택형 시험',
      targetAssessmentId: registry.data.id, startsAt: 1_699_990_000_000,
      selectionClosesAt: 1_700_001_000_000, endsAt: 1_700_010_000_000
    }
  });
  assert.equal(campaign.response.status, 201);
  const option = await call(handler, env,
    `/api/v2/learning/prep-campaigns/${campaign.data.id}/options`, {
      method: 'POST', idempotencyKey: 'campaign-option:test-0001',
      body: { templateVersionId: template.data.versionId, optionCode: 'math-a', label: '수학 A형', sortOrder: 1 }
    });
  assert.equal(option.response.status, 201);
  const selection = await call(handler, env,
    `/api/v2/learning/prep-campaigns/${campaign.data.id}/selections`, {
      method: 'POST', idempotencyKey: 'campaign-select:test-0001',
      body: { studentId: 'student:one', optionId: option.data.id, action: 'select' }
    });
  assert.equal(selection.response.status, 201);
  assert.equal(selection.data.status, 'selected');

  const rejectedWrongAnswer = await call(handler, env, '/api/v2/learning/wrong-answers', {
    method: 'POST', idempotencyKey: 'wrong:test-bad01',
    body: { studentId: 'student:one', questionText: 'raw question' }
  });
  assert.equal(rejectedWrongAnswer.response.status, 400);

  const wrongAnswer = await call(handler, env, '/api/v2/learning/wrong-answers', {
    method: 'POST', idempotencyKey: 'wrong:test-00001',
    body: {
      studentId: 'student:one', occurrenceId: occurrence.data.item.id,
      resultId: result.data.id, skillId: 'skill:fraction-add',
      providerQuestionHash: 'b'.repeat(64), questionRef: 'metamath:q-100', errorCode: 'concept'
    }
  });
  assert.equal(wrongAnswer.response.status, 201);

  const rejectedTwin = await call(handler, env,
    `/api/v2/learning/wrong-answers/${wrongAnswer.data.id}/twins`, {
      method: 'POST', idempotencyKey: 'twin:test-bad001',
      body: { problemContent: 'raw twin problem', generatorKey: 'manual' }
    });
  assert.equal(rejectedTwin.response.status, 400);

  const twin = await call(handler, env,
    `/api/v2/learning/wrong-answers/${wrongAnswer.data.id}/twins`, {
      method: 'POST', idempotencyKey: 'twin:test-000001',
      body: { problemRef: 'manual:twin-100', generatorKey: 'manual', generatorVersion: '1' }
    });
  assert.equal(twin.response.status, 201);

  const twinAttempt = await call(handler, env,
    `/api/v2/learning/twin-problems/${twin.data.id}/attempts`, {
      method: 'POST', idempotencyKey: 'twin-attempt:test-01',
      body: { outcome: 'correct', score: 100 }
    });
  assert.equal(twinAttempt.response.status, 201);

  const masteryEvidence = await call(handler, env, '/api/v2/learning/mastery/evidence', {
    method: 'POST', idempotencyKey: 'mastery:test-0001',
    body: {
      studentId: 'student:one', skillId: 'skill:fraction-add', sourceType: 'twin_attempt',
      sourceId: twinAttempt.data.id, outcome: 1, weight: 1, modelVersion: 'mvp-1'
    }
  });
  assert.equal(masteryEvidence.response.status, 201);
  const mastery = await call(handler, env, '/api/v2/learning/mastery?studentId=student:one');
  assert.equal(mastery.response.status, 200);
  assert.equal(mastery.data.items[0].masteryScore, 1);

  const rejectedIntegration = await call(handler, env, '/api/v2/learning/integration-events/manual', {
    method: 'POST', idempotencyKey: 'integration:test-bad1',
    body: {
      providerKey: 'nelt', eventType: 'score_candidate', studentId: 'student:one',
      occurredAt: 1_700_000_000_000, apiKey: 'x', summary: { overallScore: 70 }
    }
  });
  assert.equal(rejectedIntegration.response.status, 400);
  assert.equal(rejectedIntegration.data.error.code, 'sensitive_field_rejected');

  const integrationRequest = {
    method: 'POST', idempotencyKey: 'integration:test-001',
    body: {
      mode: 'manual_candidate', providerKey: 'nelt', eventType: 'score_candidate',
      studentId: 'student:one', externalSubjectHash: 'c'.repeat(64),
      assessmentKey: 'nelt-level', occurredAt: 1_700_000_000_000,
      summary: { overallScore: 74, scoreScale: '0-100', levelCode: 'N3', percentile: 60 }
    }
  };
  const integration = await call(handler, env, '/api/v2/learning/integration-events/manual', integrationRequest);
  assert.equal(integration.response.status, 201);
  assert.equal(integration.data.status, 'candidate');
  const integrationReplay = await call(handler, env, '/api/v2/learning/integration-events/manual', integrationRequest);
  assert.equal(integrationReplay.response.status, 200);
  assert.equal(integrationReplay.data.replayed, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM lp_integration_events').get().n, 1);

  const changes = await call(handler, env, '/api/v2/learning/changes?afterSeq=0&limit=500');
  assert.equal(changes.response.status, 200);
  assert.ok(changes.data.items.length >= 10);
  for (let index = 1; index < changes.data.items.length; index++) {
    assert.ok(changes.data.items[index].seq > changes.data.items[index - 1].seq);
  }

  database.close();
});

test('student-scoped RBAC cannot read another student planner', async () => {
  const actor = {
    tenantId: 'tenant:test',
    principalId: 'student:one',
    principalType: 'student',
    grants: [{ permission: 'planner.read', scopeType: 'student', scopeId: 'student:one' }]
  };
  const { env, handler, database } = createHarness(actor);
  const own = await call(handler, env, '/api/v2/learning/planner/items?studentId=student:one');
  assert.equal(own.response.status, 200);
  const other = await call(handler, env, '/api/v2/learning/planner/items?studentId=student:two');
  assert.equal(other.response.status, 403);
  assert.equal(other.data.error.code, 'forbidden');
  database.close();
});


test('student program settings는 중첩된 인증 키 이름도 저장 전에 거부한다', async () => {
  const { env, handler, database } = createHarness();
  for (const [index, field] of ['apiToken', 'clientSecret', 'sessionCookie', 'authCookie', 'passcode', 'pin', 'stem', 'solution', 'question'].entries()) {
    const rejected = await call(handler, env, '/api/v2/learning/student-programs', {
      method: 'POST', idempotencyKey: 'sensitive-settings:' + index,
      body: {
        studentId: 'student:one', providerKey: 'metamath', programCode: 'blocked-' + index,
        settings: { integration: { [field]: 'must-not-be-stored' } }
      }
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.data.error.code, 'sensitive_field_rejected');
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM lp_student_programs').get().n, 0);
  database.close();
});


test('운영 비활성 flag는 health만 열고 쓰기 API를 503으로 차단한다', async () => {
  const { env, database, handler } = createHarness();
  env.LEARNING_V2_ENABLED = 'false';
  const health = await call(handler, env, '/api/v2/learning/health', { method: 'GET' });
  assert.equal(health.response.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.enabled, false);
  const blocked = await call(handler, env, '/api/v2/learning/student-programs', {
    method: 'POST', idempotencyKey: 'disabled-write',
    body: { studentId: 'student:one', providerKey: 'wb_manual', programCode: 'P1' }
  });
  assert.equal(blocked.response.status, 503);
  assert.equal(blocked.data.error.code, 'learning_v2_disabled');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM lp_student_programs').get().n, 0);
  database.close();
});

test('v2 flag는 누락되거나 정확한 문자열 true가 아니면 fail-closed다', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true ', '1', true]) {
    const { env, database, handler } = createHarness();
    if (value === undefined) delete env.LEARNING_V2_ENABLED;
    else env.LEARNING_V2_ENABLED = value;

    const health = await call(handler, env, '/api/v2/learning/health', { method: 'GET' });
    assert.equal(health.response.status, 200);
    assert.equal(health.data.enabled, false);

    const blocked = await call(handler, env, '/api/v2/learning/student-programs', {
      method: 'POST', idempotencyKey: 'fail-closed-' + String(value),
      body: { studentId: 'student:one', providerKey: 'wb_manual', programCode: 'P1' }
    });
    assert.equal(blocked.response.status, 503);
    assert.equal(blocked.data.error.code, 'learning_v2_disabled');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM lp_student_programs').get().n, 0);
    database.close();
  }
});
