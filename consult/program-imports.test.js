'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const imports = require('./program-imports.js');

test('기본 registry는 공급자 목록과 capability를 UI 하드코딩 없이 제공한다', () => {
  const registry = imports.createDefaultRegistry();
  assert.deepEqual(
    registry.list().map(provider => provider.id),
    ['studyforce', 'classcard', 'metamath', 'nelt']
  );
  assert.equal(registry.get('클래스 카드').capabilities.wrong_answers, true);
  assert.equal(registry.get('NELT').capabilities.assessment, true);

  registry.register({
    id: 'future-reader',
    label: '미래 독서 프로그램',
    aliases: ['FutureReader'],
    capabilities: { progress: true, book_log: true },
    fields: { book_ref: ['book_ref', '도서번호'] },
    requiredAny: [['book_ref', 'reported_status']],
    identityFields: ['external_record_id', 'book_ref']
  });

  assert.equal(registry.get('FutureReader').id, 'future-reader');
  assert.equal(registry.get('future-reader').capabilities.book_log, true);
});

test('CSV parser는 따옴표, 쉼표, 줄바꿈을 보존한다', () => {
  const rows = imports.parseCsv('student_code,memo\nSTU-001,"쉼표, 포함"\nSTU-002,"두 줄\n메모"');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].memo, '쉼표, 포함');
  assert.equal(rows[1].memo, '두 줄\n메모');
});

test('StudyForce CSV는 preview→validated→confirm_candidate를 거쳐도 자동 확정되지 않는다', async () => {
  const input = [
    '학생코드,외부학생ID,확인일,훈련회차,수행률,상태',
    'STU-001,SF-100,2026-08-03,12,100%,완료'
  ].join('\n');
  const preview = await imports.previewImport({
    providerId: 'StudyForce',
    format: 'csv',
    input,
    sourceRef: 'manual-export-20260803',
    studentDirectory: [{
      student_code: 'STU-001',
      external_ids: { studyforce: 'SF-100' }
    }]
  });

  assert.equal(preview.stage, 'preview');
  assert.match(preview.source.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(preview.candidates[0].student_code, 'STU-001');
  assert.equal(preview.candidates[0].candidate_status, '완료');
  assert.equal(preview.candidates[0].confirmed_status, null);
  assert.equal(preview.candidates[0].data.progress_pct, 100);

  const validated = imports.validatePreview(preview);
  assert.equal(validated.stage, 'validated');
  assert.equal(validated.summary.valid, 1);

  const confirmedCandidates = imports.createConfirmCandidates(validated, {
    requestedBy: 'WB-ADMIN'
  });
  const candidate = confirmedCandidates.candidates[0];
  assert.equal(confirmedCandidates.stage, 'confirm_candidate');
  assert.equal(candidate.candidate_status, '완료');
  assert.equal(candidate.confirmed_status, null);
  assert.equal(candidate.final_status, null);
  assert.equal(candidate.confirmed, false);
  assert.equal(candidate.approval_required, true);
  assert.equal(candidate.approval_status, 'pending');
  assert.equal(candidate.external_change_allowed, false);
  assert.equal(candidate.ledger_write_allowed, false);
  assert.equal(confirmedCandidates.summary.auto_confirmed, 0);
});

test('ClassCard JSON은 세트·점수·오답·복습·구두테스트 capability를 정규화한다', async () => {
  const preview = await imports.previewImport({
    providerId: '클래스카드',
    format: 'json',
    input: {
      rows: [{
        external_student_id: 'CC-200',
        check_date: '2026-08-03',
        set_name: '중등 Day 12',
        score: '85',
        target_score: '90',
        wrong_answer_count: '3',
        review_status: '미완료',
        oral_test_required: '예',
        status: '점수미달'
      }]
    },
    studentMappings: [{
      provider_id: 'classcard',
      external_student_id: 'CC-200',
      student_code: 'STU-002'
    }]
  });

  const row = preview.candidates[0];
  assert.equal(row.student_code, 'STU-002');
  assert.equal(row.data.set_name, '중등 Day 12');
  assert.equal(row.data.score, 85);
  assert.equal(row.data.target_score, 90);
  assert.equal(row.data.wrong_answer_count, 3);
  assert.equal(row.data.oral_test_required, true);

  const output = imports.createConfirmCandidates(imports.validatePreview(preview));
  assert.equal(output.candidates[0].output_type, 'classcard_state_candidate');
  assert.equal(output.candidates[0].carryover_candidate_required, true);
  assert.equal(output.candidates[0].external_send_allowed, false);
});

test('MetaMath와 NELT도 같은 registry 파이프라인으로 처리된다', async () => {
  const metamath = await imports.previewImport({
    providerId: '메타 수학',
    input: [{
      student_code: 'STU-003',
      check_date: '2026-08-03',
      assessment_type: 'KMT',
      weak_unit: '분수의 나눗셈',
      wrong_answer_status: '오답복습필요',
      supplementary_sheet_ref: 'SHEET-12'
    }]
  });
  assert.equal(imports.validatePreview(metamath).summary.valid, 1);
  assert.equal(metamath.candidates[0].data.assessment_type, 'KMT');
  assert.equal(metamath.candidates[0].data.supplementary_sheet_ref, 'SHEET-12');

  const nelt = await imports.previewImport({
    providerId: 'NELT',
    input: JSON.stringify([{ student_code: 'STU-004', check_date: '2026-08-03', level: '4', status: '완료' }])
  });
  const output = imports.createConfirmCandidates(imports.validatePreview(nelt));
  assert.equal(nelt.provider.id, 'nelt');
  assert.equal(output.candidates[0].confirmed, false);
  assert.equal(output.candidates[0].candidate_status, '완료');
});

test('미래 provider도 별도 분기 없이 CSV를 정규화한다', async () => {
  const registry = imports.createDefaultRegistry([{
    id: 'future-math',
    label: '미래수학',
    capabilities: { progress: true, custom_module: true },
    fields: { module_ref: ['module_ref', '모듈'] },
    requiredAny: [['module_ref', 'reported_status']],
    identityFields: ['external_record_id', 'module_ref']
  }]);
  const preview = await imports.previewImport({
    registry,
    providerId: 'future-math',
    input: 'student_code,check_date,module_ref,status\nSTU-005,2026-08-03,M-7,partial'
  });

  assert.equal(preview.candidates[0].data.module_ref, 'M-7');
  assert.equal(preview.candidates[0].candidate_status, '부분완료');
  assert.equal(imports.validatePreview(preview).summary.valid, 1);
});

test('비밀번호·토큰 필드는 재귀적으로 제거되고 행은 차단된다', async () => {
  const secretMarker = 'DO-NOT-STORE-THIS';
  const preview = await imports.previewImport({
    providerId: 'studyforce',
    input: [{
      student_code: 'STU-006',
      check_date: '2026-08-03',
      current_unit: '13회',
      status: '완료',
      password: secretMarker,
      profile: { access_token: secretMarker }
    }]
  });

  assert.equal(JSON.stringify(preview).includes(secretMarker), false);
  assert.equal(
    preview.candidates[0].issues.some(item => item.code === 'FORBIDDEN_CREDENTIAL_FIELD'),
    true
  );
  const validated = imports.validatePreview(preview);
  assert.equal(validated.summary.valid, 0);
  assert.equal(validated.program_check_needed[0].status, '확인필요');
});

test('비밀번호 값은 source hash에도 영향을 주지 않는다', async () => {
  const base = {
    student_code: 'STU-007',
    check_date: '2026-08-03',
    current_unit: '14회',
    status: '미완료'
  };
  const first = await imports.previewImport({
    providerId: 'studyforce',
    input: [{ ...base, password: 'FIRST-SECRET' }]
  });
  const second = await imports.previewImport({
    providerId: 'studyforce',
    input: [{ ...base, password: 'SECOND-SECRET' }]
  });
  assert.equal(first.source.source_hash, second.source.source_hash);
});

test('student_code와 외부 ID가 다른 학생을 가리키면 매핑 충돌로 차단한다', async () => {
  const preview = await imports.previewImport({
    providerId: 'classcard',
    input: [{
      student_code: 'STU-010',
      external_student_id: 'CC-X',
      check_date: '2026-08-03',
      set_name: 'Day 1',
      status: '완료'
    }],
    studentDirectory: [
      { student_code: 'STU-010', external_ids: {} },
      { student_code: 'STU-011', external_ids: { classcard: 'CC-X' } }
    ]
  });

  const validated = imports.validatePreview(preview);
  assert.equal(validated.summary.invalid, 1);
  assert.equal(
    validated.invalid_candidates[0].issues.some(item => item.code === 'STUDENT_MAPPING_CONFLICT'),
    true
  );
  assert.equal(validated.program_check_needed[0].output_type, 'classcard_check_needed');
});

test('같은 외부 ID가 배치에서 여러 student_code로 나타나면 모두 확인필요다', async () => {
  const preview = await imports.previewImport({
    providerId: 'studyforce',
    input: [
      { student_code: 'STU-020', external_student_id: 'SF-Z', check_date: '2026-08-03', current_unit: '1' },
      { student_code: 'STU-021', external_student_id: 'SF-Z', check_date: '2026-08-04', current_unit: '2' }
    ]
  });
  const validated = imports.validatePreview(preview);
  assert.equal(validated.summary.invalid, 2);
  validated.invalid_candidates.forEach(row => {
    assert.equal(row.issues.some(item => item.code === 'BATCH_EXTERNAL_ID_CONFLICT'), true);
  });
});

test('source hash와 idempotency key는 동일 입력에 대해 안정적이며 재가져오기를 막는다', async () => {
  const options = {
    providerId: 'studyforce',
    input: [{ student_code: 'STU-030', check_date: '2026-08-03', current_unit: '10', status: '부분완료' }]
  };
  const first = await imports.previewImport(options);
  const second = await imports.previewImport(options);
  assert.equal(first.source.source_hash, second.source.source_hash);
  assert.equal(first.candidates[0].idempotency_key, second.candidates[0].idempotency_key);

  const validated = imports.validatePreview(second, {
    existingIdempotencyKeys: [first.candidates[0].idempotency_key]
  });
  assert.equal(validated.summary.valid, 0);
  assert.equal(validated.invalid_candidates[0].issues.some(item => item.code === 'ALREADY_IMPORTED'), true);
});

test('같은 식별키에 결과가 다르면 idempotency conflict로 두 행 모두 차단한다', async () => {
  const preview = await imports.previewImport({
    providerId: 'studyforce',
    input: [
      { student_code: 'STU-040', check_date: '2026-08-03', current_unit: '9회', progress_pct: 40 },
      { student_code: 'STU-040', check_date: '2026-08-03', current_unit: '9회', progress_pct: 80 }
    ]
  });
  const validated = imports.validatePreview(preview);
  assert.equal(validated.summary.invalid, 2);
  validated.invalid_candidates.forEach(row => {
    assert.equal(row.issues.some(item => item.code === 'IDEMPOTENCY_CONFLICT'), true);
  });
});

test('알 수 없는 상태는 미확인 후보가 되며 자동 완료되지 않는다', async () => {
  const preview = await imports.previewImport({
    providerId: 'nelt',
    input: [{ student_code: 'STU-050', check_date: '2026-08-03', level: 'L3', status: '아마완료' }]
  });
  assert.equal(preview.candidates[0].candidate_status, '미확인');
  assert.equal(preview.candidates[0].issues.some(item => item.code === 'UNKNOWN_STATUS'), true);
  const output = imports.createConfirmCandidates(imports.validatePreview(preview));
  assert.equal(output.candidates[0].confirmed, false);
});

test('브라우저에서는 전역 WBProgramImports로 노출된다', () => {
  const filename = path.join(__dirname, 'program-imports.js');
  const source = fs.readFileSync(filename, 'utf8');
  const sandbox = { console, TextEncoder, crypto: webcrypto };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename });
  assert.equal(typeof sandbox.WBProgramImports.previewImport, 'function');
  assert.equal(typeof sandbox.WBProgramImports.createDefaultRegistry, 'function');
});


test('유효 행 상세를 검토하고 선택한 pending 후보만 승인한다', async () => {
  const preview = await imports.previewImport({
    providerId: 'classcard',
    input: [
      { student_code: 'STU-060', check_date: '2026-08-03', set_name: 'Day 1', score: 80, progress_pct: 50, status: '부분완료' },
      { student_code: 'STU-060', check_date: '2026-08-04', set_name: 'Day 2', score: 95, progress_pct: 100, status: '완료' }
    ]
  });
  const validation = imports.validatePreview(preview);
  const reviewRows = imports.createReviewRows(validation);
  assert.deepEqual(reviewRows.map(row => ({
    student: row.student_code, date: row.check_date, status: row.status,
    progress: row.progress_pct, score: row.score, selected: row.selected
  })), [
    { student: 'STU-060', date: '2026-08-03', status: '부분완료', progress: 50, score: 80, selected: true },
    { student: 'STU-060', date: '2026-08-04', status: '완료', progress: 100, score: 95, selected: true }
  ]);

  const pending = imports.createConfirmCandidates(validation, { requestedBy: 'MANAGER-1' });
  assert.throws(() => imports.approveConfirmCandidates(pending, {
    approvedBy: 'MANAGER-1', approvedAt: '2026-08-03T09:00:00.000Z'
  }), error => error.code === 'SELECTION_REQUIRED');

  const approved = imports.approveConfirmCandidates(pending, {
    selectedRowIds: [reviewRows[1].row_id],
    approvedBy: 'MANAGER-1', approvedAt: '2026-08-04T09:00:00+09:00'
  });
  assert.equal(approved.stage, 'approved');
  assert.equal(approved.approved_candidates.length, 1);
  assert.equal(approved.pending_candidates.length, 1);
  assert.equal(approved.approved_candidates[0].approval_status, 'approved');
  assert.equal(approved.approved_candidates[0].approved_by, 'MANAGER-1');
  assert.equal(approved.approved_candidates[0].approved_at, '2026-08-04T00:00:00.000Z');
  assert.equal(approved.approved_candidates[0].ledger_write_allowed, true);
  assert.equal(approved.pending_candidates[0].ledger_write_allowed, false);
});

test('자격정보 변형은 재귀 차단하고 accountIdRef는 opaque ID만 허용한다', async () => {
  const marker = 'NEVER-STORE-CLIENT-SECRET';
  const preview = await imports.previewImport({
    providerId: 'studyforce',
    input: [{
      student_code: 'STU-061', check_date: '2026-08-03', current_unit: '15회',
      account_id_ref: 'not an opaque reference',
      profile: { client_secret_value: marker }, status: '완료'
    }]
  });
  assert.equal(JSON.stringify(preview).includes(marker), false);
  assert.equal(preview.candidates[0].account_id_ref, '');
  assert.equal(preview.candidates[0].issues.some(issue => issue.code === 'FORBIDDEN_CREDENTIAL_FIELD'), true);
  assert.equal(preview.candidates[0].issues.some(issue => issue.code === 'INVALID_ACCOUNT_ID_REF'), true);
  assert.equal(imports.validatePreview(preview).summary.valid, 0);
  assert.equal(imports.isOpaqueAccountRef('student-ref:061'), true);
  assert.equal(imports.isOpaqueAccountRef('student password'), false);
});
