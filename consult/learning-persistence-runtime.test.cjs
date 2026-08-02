"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const persistence = require("./learning-persistence.js");
const platform = require("./learning-platform.js");
const shell = require("./learning-shell.js");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("candidate storage failure leaves caller state and sync untouched", () => {
  const original = { checks: { old: { done: false } } };
  const candidate = { checks: { old: { done: false }, claim: { done: true } } };
  let current = original;
  let syncCalls = 0;
  let writes = 0;
  const storage = {
    setItem() {
      writes += 1;
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
  };

  assert.throws(() => {
    persistence.commitCandidate(storage, "learning", candidate, {
      writeErrorMessage: "브라우저 저장 공간이 부족해 완료 요청을 저장하지 않았습니다"
    });
    current = candidate;
    syncCalls += 1;
  }, /저장 공간이 부족/);

  assert.equal(writes, 1);
  assert.strictEqual(current, original);
  assert.equal(syncCalls, 0);
  assert.deepEqual(original, { checks: { old: { done: false } } });
});

test("candidate is serialized, size-checked, and written exactly once", () => {
  const candidate = { checks: { claim: { done: true } } };
  const calls = [];
  const result = persistence.commitCandidate({
    setItem(key, value) { calls.push([key, value]); }
  }, "learning", candidate, { maxBytes: 1024 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "learning");
  assert.deepEqual(JSON.parse(calls[0][1]), candidate);
  assert.strictEqual(result.state, candidate);
  assert.ok(result.bytes > 0);
});

test("oversized candidate is rejected before storage write", () => {
  let writes = 0;
  assert.throws(() => persistence.commitCandidate({
    setItem() { writes += 1; }
  }, "learning", { value: "123456789" }, {
    maxBytes: 5,
    tooLargeMessage: "브라우저 저장 한도에 가까워 완료 요청을 저장하지 않았습니다"
  }), /저장 한도/);
  assert.equal(writes, 0);
});

test("partial split state is corruption, not an uninitialized state", () => {
  assert.deepEqual(persistence.inspectLearningRecords({}), {
    kind: "uninitialized", stored: null
  });

  const partial = persistence.inspectLearningRecords({
    core: { value: { student: { studentCode: "S1" } } },
    plan: { value: [] }
  });
  assert.equal(partial.kind, "corrupt");
  assert.equal(partial.code, "LP_PARTIAL_STATE");
  assert.ok(partial.missingParts.includes("assessment"));

  const complete = persistence.inspectLearningRecords({
    core: { value: { student: { studentCode: "S1" }, settings: {}, programStates: [] } },
    plan: { value: [] },
    assessment: { value: { schedules: [], occurrences: [] } },
    campaign: { value: [] },
    wrong: { value: [] }
  });
  assert.equal(complete.kind, "split");
  assert.deepEqual(complete.stored.plannerItems, []);
});

test("consult claim commits before global state replacement and sync", () => {
  const start = html.indexOf("function saveLearningClaim(");
  const end = html.indexOf("function clearLearningClaim", start);
  const body = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(body, /setCheck\(/);
  assert.match(body, /const candidateState = Object\.assign/);
  const commitAt = body.indexOf("WBLearningPersistence.commitCandidate");
  const stateAt = body.indexOf("state = candidateState");
  const syncAt = body.indexOf("queueSync()");
  assert.ok(commitAt >= 0 && commitAt < stateAt && stateAt < syncAt);
  assert.equal((body.match(/queueSync\(\)/g) || []).length, 1);
  assert.match(body, /완료 요청을 저장하지 않았습니다/);
});

test("corrupt learning state renders recovery guidance and blocks lpinit overwrite", () => {
  assert.match(html, /inspectLearningRecords/);
  assert.match(html, /LP_PARTIAL_STATE|lpLearningStateErrors/);
  assert.match(html, /학습 기록 복구 필요/);
  assert.match(html, /먼저 설정의 안전 백업/);
  const initStart = html.indexOf("case 'lpinit':");
  const initEnd = html.indexOf("case 'lpprofile'", initStart);
  const initBlock = html.slice(initStart, initEnd);
  assert.ok(initStart >= 0 && initEnd > initStart);
  assert.ok(initBlock.indexOf("lpLearningStateErrors.has(student.id)") >= 0);
  assert.ok(initBlock.indexOf("lpLearningStateErrors.has(student.id)") < initBlock.indexOf("createInitialState"));
  assert.match(initBlock, /손상된 학습 기록이 있어 초기화하지 않았습니다/);
});

test("claim failure schedules authoritative rerender before any success toast", () => {
  const start = html.indexOf("onChange: (nextState, action)");
  const end = html.indexOf("function runLearningCommand", start);
  const block = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /catch \(error\) \{[\s\S]*setTimeout\(\(\) => render\(\), 0\);[\s\S]*toast\(error\.message\)/);
  assert.ok(block.indexOf("saveLearningClaim") < block.indexOf("완료 요청을 확인대기로 저장했습니다"));
});


function learningChecks(learning, plannerItems) {
  const studentId = learning.student.studentCode;
  const record = (prefix, value) => ({ taskId: '__' + prefix + '__' + studentId, date: 'all', done: true, value, updatedAt: 1 });
  return {
    ['__lpcore__' + studentId + '|all']: record('lpcore', {
      schemaVersion: learning.schemaVersion,
      student: learning.student,
      settings: learning.settings,
      programStates: learning.programStates,
      migrationIssues: learning.migrationIssues || []
    }),
    ['__lpplan__' + studentId + '|all']: record('lpplan', plannerItems),
    ['__lpassess__' + studentId + '|all']: record('lpassess', {
      schedules: learning.assessmentSchedules,
      occurrences: learning.assessmentOccurrences
    }),
    ['__lpcampaign__' + studentId + '|all']: record('lpcampaign', learning.prepCampaigns),
    ['__lpwrong__' + studentId + '|all']: record('lpwrong', learning.remediationCases)
  };
}

function learningPlanWriteRuntime() {
  const start = html.indexOf('function learningPlanWriteFor(studentId, currentRecord, nextItems, stamp)');
  const end = html.indexOf('\nfunction saveLearningState', start);
  const source = html.slice(start, end);
  const context = {
    WBLearningPersistence: persistence,
    WBLearningPlatform: platform,
    uid() { return 'legacy-regression'; }
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__learningPlanWriteFor = learningPlanWriteFor;', context);
  return context;
}

function learningStateRuntime(checks) {
  const start = html.indexOf('function validateLearningStudentScope');
  const end = html.indexOf('\nfunction learningStateRecoveryCard', start);
  const source = html.slice(start, end);
  const context = {
    window: { WBLearningShell: shell, WBLearningPersistence: persistence, WBLearningPlatform: platform },
    WBLearningShell: shell,
    WBLearningPersistence: persistence,
    WBLearningPlatform: platform,
    state: { checks },
    lpLearningStateErrors: new Map(),
    lpClaimsFor() { return []; },
    console: { warn() {} }
  };
  context.lpPart = function (prefix, studentId) {
    return context.state.checks['__' + prefix + '__' + studentId + '|all'] || null;
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__learningStateFor = learningStateFor;', context);
  return context;
}

test('legacy lpplan audit fallback is deterministic and unrelated campaign save keeps planner revision intact', () => {
  const studentId = 'LEGACY-PLAN-STUDENT';
  const learning = shell.createInitialState({
    studentCode: studentId, displayName: '기존 학생', academicStage: 'elementary', grade: 4
  });
  const legacyItem = {
    itemId: 'legacy-plan-item',
    studentCode: studentId,
    date: '2026-07-14',
    title: '기존 플래너',
    sourceType: 'academy',
    status: 'planned',
    revision: 1
  };
  const checks = learningChecks(learning, [legacyItem]);
  const planKey = '__lpplan__' + studentId + '|all';
  const originalRecord = JSON.stringify(checks[planKey]);
  const runtime = learningStateRuntime(checks);
  const current = runtime.__learningStateFor({ id: studentId, name: '기존 학생' });
  const normalized = current.plannerItems[0];

  assert.equal(normalized.createdAt, '2026-07-14T00:00:00.000Z');
  assert.equal(normalized.createdBy, 'legacy');
  assert.equal(normalized.updatedAt, '2026-07-14T00:00:00.000Z');
  assert.equal(normalized.updatedBy, 'legacy');
  assert.deepEqual(normalized.history, [{
    action: 'created', fromStatus: '', toStatus: 'planned',
    at: '2026-07-14T00:00:00.000Z', actor: 'legacy'
  }]);

  const updatedAtOnly = platform.createPlannerItem(Object.assign({}, legacyItem, {
    itemId: 'legacy-with-update',
    updatedAt: '2026-07-15T09:10:11+09:00',
    updatedBy: 'old-sync'
  }));
  assert.equal(updatedAtOnly.createdAt, '2026-07-15T09:10:11+09:00');
  assert.equal(updatedAtOnly.updatedAt, '2026-07-15T09:10:11+09:00');
  assert.equal(updatedAtOnly.createdBy, 'legacy');
  assert.equal(updatedAtOnly.updatedBy, 'old-sync');

  const preservedHistory = [{
    action: 'imported', fromStatus: '', toStatus: 'planned',
    at: '2026-07-10T12:00:00+09:00', actor: 'old-teacher', evidenceRef: 'old:1'
  }];
  const preserved = platform.createPlannerItem(Object.assign({}, legacyItem, {
    itemId: 'legacy-preserved-audit',
    createdAt: '2026-07-10T12:00:00+09:00',
    createdBy: 'old-teacher',
    updatedAt: '2026-07-11T01:02:03.000Z',
    updatedBy: 'old-reviewer',
    history: preservedHistory
  }));
  assert.equal(preserved.createdAt, '2026-07-10T12:00:00+09:00');
  assert.equal(preserved.createdBy, 'old-teacher');
  assert.equal(preserved.updatedAt, '2026-07-11T01:02:03.000Z');
  assert.equal(preserved.updatedBy, 'old-reviewer');
  assert.deepEqual(preserved.history, preservedHistory);

  const firstNormalizationMillisecond = Date.now();
  while (Date.now() === firstNormalizationMillisecond) {}
  const next = shell.applyCommand(current, {
    type: 'campaign_add', campaignType: 'contest', title: '가을 경시대회',
    provider: 'manual', examDate: '2026-09-20'
  }, { actorId: 'academy-admin', at: '2026-08-03T04:45:00.000Z', today: '2026-08-03' });

  const writeRuntime = learningPlanWriteRuntime();
  const planWrite = writeRuntime.__learningPlanWriteFor(
    studentId, checks[planKey], next.plannerItems, 123456
  );
  assert.equal(planWrite.write, false);
  assert.equal(planWrite.planMutation, null);
  assert.throws(() => writeRuntime.__learningPlanWriteFor(
    studentId,
    checks[planKey],
    next.plannerItems.map(item => Object.assign({}, item, { title: item.title + ' 변경' })),
    123457
  ), /revision이 증가하지 않아/);
  assert.equal(next.plannerItems[0].revision, 1);
  assert.equal(next.prepCampaigns.length, 1);
  assert.equal(JSON.stringify(checks[planKey]), originalRecord, 'legacy source record must stay untouched');
});

test('learningStateFor accepts compact state but fail-closes cross-student and normalization data loss', () => {
  let learning = shell.createInitialState({
    studentCode: 'SAFE-STUDENT', displayName: '안전 학생', academicStage: 'elementary', grade: 3
  });
  learning = platform.addPlannerItem(learning, {
    studentCode: 'SAFE-STUDENT', date: '2026-08-03', title: '정상 과제', sourceType: 'academy'
  });
  const compact = persistence.compactPlannerItemsForStorage(learning.plannerItems, platform.createPlannerItem);

  let runtime = learningStateRuntime(learningChecks(learning, compact));
  const valid = runtime.__learningStateFor({ id: 'SAFE-STUDENT', name: '안전 학생' });
  assert.equal(valid.plannerItems.length, 1);
  assert.equal(runtime.lpLearningStateErrors.has('SAFE-STUDENT'), false);

  const wrongCore = learningChecks(learning, compact);
  wrongCore['__lpcore__SAFE-STUDENT|all'].value.student = Object.assign({}, learning.student, { studentCode: 'OTHER' });
  runtime = learningStateRuntime(wrongCore);
  assert.equal(runtime.__learningStateFor({ id: 'SAFE-STUDENT', name: '안전 학생' }), null);
  assert.equal(runtime.lpLearningStateErrors.get('SAFE-STUDENT').code, 'LP_STUDENT_MISMATCH');

  const foreignPlan = compact.concat([persistence.compactPlannerItemForStorage(platform.createPlannerItem({
    studentCode: 'OTHER', date: '2026-08-04', title: '타학생 과제', sourceType: 'academy'
  }), platform.createPlannerItem)]);
  runtime = learningStateRuntime(learningChecks(learning, foreignPlan));
  assert.equal(runtime.__learningStateFor({ id: 'SAFE-STUDENT', name: '안전 학생' }), null);
  assert.equal(runtime.lpLearningStateErrors.get('SAFE-STUDENT').code, 'LP_PLANNER_STUDENT_MISMATCH');

  const malformed = compact.concat([{
    itemId: 'bad-item', studentCode: 'SAFE-STUDENT', date: 'not-a-date', title: '손상 과제',
    sourceType: 'academy', status: 'planned', revision: 1,
    createdAt: '2026-08-03T00:00:00.000Z', createdBy: 'system'
  }]);
  runtime = learningStateRuntime(learningChecks(learning, malformed));
  assert.equal(runtime.__learningStateFor({ id: 'SAFE-STUDENT', name: '안전 학생' }), null);
  assert.equal(runtime.lpLearningStateErrors.get('SAFE-STUDENT').code, 'LP_NORMALIZATION_DATA_LOSS');
});
