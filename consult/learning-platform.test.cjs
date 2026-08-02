"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lp = require("./learning-platform.js");

function elementaryState(grade = 3) {
  return lp.createDefaultState({
    student: {
      studentCode: "E-" + grade,
      displayName: "테스트 학생",
      academicStage: "elementary",
      grade
    }
  });
}

test("초등 기본 상태에는 학교 정기시험이 없다", () => {
  const state = elementaryState();
  assert.equal(state.settings.schoolRegularExamEnabled, false);
  assert.deepEqual(state.prepCampaigns, []);
  assert.equal(lp.getElementaryCampaignOptions().some((x) => x.value === "school_regular"), false);
});

test("공급자 상태는 불변 갱신하고 비밀번호 저장을 거부한다", () => {
  const state = elementaryState();
  const next = lp.upsertStudentProgramState(state, {
    providerId: "classcard",
    accountIdRef: "student-ref-1",
    status: "사용중",
    assignedCount: 10,
    completedCount: 4
  });
  assert.equal(state.programStates.length, 0);
  assert.equal(next.programStates[0].status, "active");
  assert.throws(() => lp.upsertStudentProgramState(state, {
    providerId: "classcard",
    password: "do-not-store"
  }), /must not be stored/);
});

test("학원 과제 완료 요청은 확인대기 후 검증된다", () => {
  let state = elementaryState();
  state = lp.addPlannerItem(state, {
    itemId: "online-1",
    studentCode: state.student.studentCode,
    date: "2026-08-03",
    title: "클래스카드 1세트",
    sourceType: "online_program",
    minutes: 15
  });
  const claimed = lp.claimPlannerItemCompletion(state, "online-1", "report:123", "2026-08-03T09:00:00.000Z");
  assert.equal(state.plannerItems[0].status, "planned");
  assert.equal(claimed.plannerItems[0].status, "verification_waiting");
  const verified = lp.verifyPlannerItemCompletion(claimed, "online-1", {
    approved: true,
    evidenceRef: "teacher-check:456",
    verifiedBy: "teacher-1",
    verifiedAt: "2026-08-03T10:00:00.000Z"
  });
  assert.equal(verified.plannerItems[0].status, "completed");
  assert.equal(verified.plannerItems[0].verificationDecision, "approved");
  assert.deepEqual(verified.plannerItems[0].verificationEvidenceRefs, ["teacher-check:456"]);
});

test("이월은 원본과 파생 항목을 모두 보존한다", () => {
  let state = elementaryState();
  state = lp.addPlannerItem(state, {
    itemId: "carry-1",
    studentCode: state.student.studentCode,
    date: "2026-08-03",
    title: "독해 훈련",
    sourceType: "academy",
    minutes: 20
  });
  state = lp.requestPlannerCarryover(state, "carry-1", "2026-08-04");
  state = lp.approvePlannerCarryover(state, "carry-1", {
    approvedBy: "teacher-1",
    date: "2026-08-04",
    approvedAt: "2026-08-03T12:00:00.000Z"
  });
  assert.equal(state.plannerItems.length, 2);
  assert.equal(state.plannerItems.find((x) => x.itemId === "carry-1").status, "carried_over");
  assert.equal(state.plannerItems.find((x) => x.itemId !== "carry-1").originItemId, "carry-1");
});

test("NELT는 기준일에서 3개월 간격으로 생성된다", () => {
  const schedule = lp.createNeltSchedule({
    studentCode: "E-3",
    anchorDate: "2026-01-31"
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(schedule, "2026-01-01", "2026-11-30").map((x) => x.scheduledDate),
    ["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"]
  );
});

test("메타수학 주간·월말평가 회차를 생성한다", () => {
  const weekly = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2026-08-01",
    kind: "weekly",
    weekday: 5
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(weekly, "2026-08-01", "2026-08-31").map((x) => x.scheduledDate),
    ["2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28"]
  );
  const monthEnd = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2026-08-01",
    kind: "month_end"
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(monthEnd, "2026-08-01", "2026-09-30").map((x) => x.scheduledDate),
    ["2026-08-31", "2026-09-30"]
  );
});

test("같은 평가 회차를 다시 확장해도 중복되지 않는다", () => {
  let state = elementaryState();
  const schedule = lp.createMetaMathSchedule({
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-01",
    kind: "weekly",
    weekday: 5
  });
  const range = { fromDate: "2026-08-01", toDate: "2026-08-31" };
  state = lp.addAssessmentSchedule(state, schedule, range);
  state = lp.addAssessmentSchedule(state, schedule, range);
  assert.equal(state.assessmentSchedules.length, 1);
  assert.equal(state.assessmentOccurrences.length, 4);
  assert.equal(state.plannerItems.length, 4);
});

test("초등 학교시험은 차단되고 선택형 NELT는 동의 후 활성화된다", () => {
  let state = elementaryState();
  state = lp.addPrepCampaign(state, {
    campaignType: "school_regular",
    title: "학교 시험",
    examDate: "2026-09-01"
  });
  const schoolExam = state.prepCampaigns[0];
  assert.equal(schoolExam.activationBlockedReason, "ELEMENTARY_REGULAR_EXAM_DISABLED");
  assert.throws(() => lp.activatePrepCampaign(state, schoolExam.campaignId, {
    approvedBy: "teacher-1"
  }), /blocked/);
  state = lp.addPrepCampaign(state, {
    campaignType: "nelt",
    examDate: "2026-09-15"
  });
  const nelt = state.prepCampaigns.find((x) => x.campaignType === "nelt");
  assert.equal(nelt.status, "consent_pending");
  assert.throws(() => lp.activatePrepCampaign(state, nelt.campaignId, { approvedBy: "teacher-1" }), /evidenceRef/);
  state = lp.activatePrepCampaign(state, nelt.campaignId, {
    approvedBy: "teacher-1",
    consentEvidenceRef: "consent-form:2026-08-03:E-3",
    consentApprovedBy: "teacher-1",
    consentApprovedAt: "2026-08-03T10:00:00.000Z"
  });
  const activated = state.prepCampaigns.find((x) => x.campaignId === nelt.campaignId);
  assert.equal(activated.status, "active");
  assert.equal(activated.consentEvidenceRef, "consent-form:2026-08-03:E-3");
  assert.equal(activated.consentApprovedBy, "teacher-1");
  assert.equal(activated.consentApprovedAt, "2026-08-03T10:00:00.000Z");
});

test("NELT 마일스톤은 orientation_only 템플릿을 쓴다", () => {
  const state = elementaryState();
  const campaign = lp.createPrepCampaign({
    campaignType: "nelt",
    examDate: "2026-09-01",
    consentStatus: "approved"
  }, state.student, state.settings);
  const milestones = lp.buildCampaignMilestones(campaign, { today: "2026-08-01" });
  assert.equal(milestones.some((x) => x.key === "baseline"), false);
  assert.equal(milestones.some((x) => x.key === "format"), true);
  assert.equal(milestones.find((x) => x.offsetDays === -1).minutes, 0);
});

test("저학년 소프트캡은 세션·주간·캠페인 경고를 반환한다", () => {
  const state = elementaryState(1);
  const result = lp.analyzeWorkload({
    student: state.student,
    anchorDate: "2026-08-03",
    campaigns: [{ status: "active" }, { status: "planned" }],
    items: [{
      itemId: "long-1",
      title: "긴 과제",
      date: "2026-08-03",
      minutes: 50,
      status: "planned"
    }]
  });
  assert.equal(result.cap.sessionMinutes, 15);
  assert.equal(result.exceeded, true);
  assert.equal(result.warnings.some((x) => x.code === "SESSION_SOFT_CAP"), true);
  assert.equal(result.warnings.some((x) => x.code === "WEEKLY_SOFT_CAP"), true);
  assert.equal(result.warnings.some((x) => x.code === "CAMPAIGN_SOFT_CAP"), true);
});

test("정기평가는 일반 과제의 1회 소프트캡에서 제외하되 주간 총량에는 포함한다", () => {
  const state = elementaryState(3);
  const result = lp.analyzeWorkload({
    student: state.student,
    anchorDate: "2026-08-03",
    campaigns: [],
    items: [{
      itemId: "assessment-1",
      title: "NELT 정기 진단",
      date: "2026-08-03",
      minutes: 90,
      sourceType: "assessment",
      status: "planned"
    }]
  });
  assert.equal(result.warnings.some((x) => x.code === "SESSION_SOFT_CAP"), false);
  assert.equal(result.warnings.some((x) => x.code === "WEEKLY_SOFT_CAP"), true);
});

test("오답 결과는 자동 숙달되지 않고 사람 확인을 요구한다", () => {
  let item = lp.createWrongAnswerCase({
    studentCode: "E-3",
    textbookId: "math-3-2",
    page: "72",
    problemNo: "13",
    createdAt: "2026-08-03T00:00:00.000Z"
  });
  item = lp.requestTwinGeneration(item, { actor: "teacher-1", at: "2026-08-03T01:00:00.000Z" });
  item = lp.transitionWrongAnswerCase(item, "generated", {
    metaMathProblemSetId: "set-1",
    at: "2026-08-03T02:00:00.000Z"
  });
  item = lp.transitionWrongAnswerCase(item, "review_waiting", { at: "2026-08-03T03:00:00.000Z" });
  item = lp.transitionWrongAnswerCase(item, "assigned", {
    assignmentId: "assignment-1",
    at: "2026-08-03T04:00:00.000Z"
  });
  item = lp.transitionWrongAnswerCase(item, "submitted", { at: "2026-08-03T05:00:00.000Z" });
  item = lp.recordTwinResult(item, {
    externalResultRef: "result-1",
    correctCount: 5,
    totalCount: 5,
    receivedAt: "2026-08-03T06:00:00.000Z"
  });
  assert.equal(item.status, "verification_waiting");
  assert.throws(() => lp.reviewTwinResult(item, { mastered: true }), /verifiedBy/);
  item = lp.reviewTwinResult(item, {
    mastered: true,
    verifiedBy: "teacher-1",
    at: "2026-08-03T07:00:00.000Z"
  });
  assert.equal(item.status, "mastered");
});

test("마이그레이션은 자격정보를 제거하고 초등 시험을 검토 초안으로 둔다", () => {
  const migrated = lp.migrateLearningPlatformState({
    studentCode: "LEGACY-E3",
    academicStage: "elementary",
    grade: 3,
    programs: [{
      name: "classcard",
      accountId: "safe-reference",
      password: "must-disappear",
      status: "사용중"
    }],
    tasks: [{
      id: "legacy-task",
      date: "2026-08-03",
      title: "기존 완료 표시 과제",
      status: "완료"
    }],
    exams: [{
      id: "legacy-exam",
      title: "학교 정기시험",
      date: "2026-09-01"
    }],
    wrongAnswers: [{
      textbookId: "math-book",
      page: "10",
      questionNo: "2"
    }]
  });
  assert.equal(migrated.state.programStates[0].providerId, "classcard");
  assert.equal(migrated.state.plannerItems[0].status, "verification_waiting");
  assert.equal(migrated.state.prepCampaigns[0].activationBlockedReason, "ELEMENTARY_REGULAR_EXAM_DISABLED");
  assert.equal(JSON.stringify(migrated).includes("must-disappear"), false);
});

test("현재 v2 상태를 다시 마이그레이션해도 데이터와 ID가 유지된다", () => {
  const original = lp.createDemoState("2026-08-03");
  const first = lp.migrateLearningPlatformState(original);
  const second = lp.migrateLearningPlatformState(first.state);

  assert.equal(first.report.alreadyCurrent, true);
  assert.equal(second.report.alreadyCurrent, true);
  assert.deepEqual(second.state, first.state);
});

test("렌더러는 사용자 문자열을 이스케이프하고 명시적 버튼을 만든다", () => {
  let state = elementaryState();
  state = lp.addPlannerItem(state, {
    studentCode: state.student.studentCode,
    date: "2026-08-03",
    title: "<script>alert(1)</script>",
    sourceType: "personal",
    minutes: 10
  });
  const html = lp.renderTodayPlanner(state, "2026-08-03", true);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
  assert.equal(html.includes("<section"), true);
  assert.equal(html.includes('type="button"'), true);
});

test("로컬 데모에는 플래너·프로그램·캠페인·오답이 있다", () => {
  const state = lp.createDemoState("2026-08-03");
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.programStates.length, 2);
  assert.equal(state.plannerItems.length, 2);
  assert.equal(state.prepCampaigns.length, 1);
  assert.equal(state.remediationCases.length, 1);
});

test("플래너 검증은 항목별 명시 결정과 근거를 요구하고 반려를 기록한다", () => {
  let state = elementaryState();
  state = lp.addPlannerItem(state, {
    itemId: "review-1",
    studentCode: state.student.studentCode,
    date: "2026-08-03",
    title: "독해 확인",
    sourceType: "academy",
    verificationRequired: true
  });
  const claimed = lp.claimPlannerItemCompletion(state, "review-1", "student-report:1", "2026-08-03T09:00:00.000Z");
  assert.throws(() => lp.verifyPlannerItemCompletion(claimed, "review-1", {
    evidenceRef: "teacher-check:reject-1", verifiedBy: "teacher-1"
  }), /approved decision/);
  assert.throws(() => lp.verifyPlannerItemCompletion(claimed, "review-1", {
    approved: false, verifiedBy: "teacher-1"
  }), /evidenceRef/);
  const rejected = lp.verifyPlannerItemCompletion(claimed, "review-1", {
    approved: false,
    evidenceRef: "teacher-check:reject-1",
    verifiedBy: "teacher-1",
    verifiedAt: "2026-08-03T10:00:00.000Z"
  });
  assert.equal(rejected.plannerItems[0].status, "check_needed");
  assert.equal(rejected.plannerItems[0].verificationDecision, "rejected");
  assert.deepEqual(rejected.plannerItems[0].verificationEvidenceRefs, ["teacher-check:reject-1"]);
});

test("늦게 활성화한 캠페인은 과거 마일스톤을 플래너에 만들지 않는다", () => {
  const state = elementaryState();
  const campaign = lp.createPrepCampaign({
    campaignType: "contest",
    title: "수학 경시대회",
    examDate: "2026-09-01",
    startDate: "2026-07-21",
    consentStatus: "approved"
  }, state.student, state.settings);
  const milestones = lp.buildCampaignMilestones(campaign, { today: "2026-08-30" });
  const items = lp.campaignMilestonesToPlannerItems(campaign, { today: "2026-08-30" });
  assert.equal(milestones.every((item) => item.dueDate >= "2026-08-30"), true);
  assert.equal(items.every((item) => item.date >= "2026-08-30"), true);
  assert.equal(items.some((item) => item.date === "2026-08-29"), false);
  assert.equal(items.some((item) => item.date === "2026-08-31"), true);
  assert.equal(items.every((item) => item.status === "planned"), true);
});


function approvedProgramCandidate(overrides = {}) {
  return Object.assign({
    row_id: "row-1",
    workflow_stage: "approved",
    approval_status: "approved",
    confirmed: true,
    ledger_write_allowed: true,
    approved_by: "MANAGER-1",
    approved_at: "2026-08-04T00:00:00.000Z",
    provider_id: "classcard",
    student_code: "E-3",
    account_id_ref: "",
    check_date: "2026-08-04",
    final_status: "완료",
    duplicate_key: "program-import:test:1",
    payload_hash: "a".repeat(64),
    source_hash: "b".repeat(64),
    source_ref: "manual-test",
    source_date: "2026-08-04",
    data: { set_name: "Day 2", progress_pct: 100, score: 95 }
  }, overrides);
}

test("승인된 프로그램 행만 적용하고 같은 provider의 모든 snapshot을 보존한다", () => {
  let state = elementaryState();
  state = lp.upsertStudentProgramState(state, {
    providerId: "classcard", accountIdRef: "student-ref-1",
    status: "active", assignedCount: 10, completedCount: 4
  });
  const newer = approvedProgramCandidate();
  const older = approvedProgramCandidate({
    row_id: "row-0", approved_at: "2026-08-03T00:00:00.000Z",
    check_date: "2026-08-03", final_status: "부분완료",
    duplicate_key: "program-import:test:0", payload_hash: "c".repeat(64),
    source_date: "2026-08-03",
    data: { set_name: "Day 1", progress_pct: 50, score: 80 }
  });
  state = lp.applyApprovedProgramImport(state, newer);
  state = lp.applyApprovedProgramImport(state, older);
  const program = state.programStates[0];
  assert.equal(program.history.length, 2);
  assert.deepEqual(program.history.map(item => item.checkDate), ["2026-08-03", "2026-08-04"]);
  assert.equal(program.latestSnapshot.checkDate, "2026-08-04");
  assert.equal(program.latestSnapshot.data.score, 95);
  assert.equal(program.status, "unverified");
  assert.equal(program.assignedCount, 10);
  assert.equal(program.completedCount, 4);
  assert.equal(program.accountIdRef, "student-ref-1");
});

test("pending 후보와 자격정보·비 opaque 계정 참조는 프로그램 상태에 들어가지 않는다", () => {
  const state = elementaryState();
  assert.throws(() => lp.applyApprovedProgramImport(state, approvedProgramCandidate({
    workflow_stage: "confirm_candidate", approval_status: "pending",
    confirmed: false, ledger_write_allowed: false
  })), /only approved/);
  assert.throws(() => lp.upsertStudentProgramState(state, {
    providerId: "classcard", accountIdRef: "student password"
  }), /opaque reference/);
  [
    { profile: { apiToken: "do-not-store" } },
    { profile: { pw: "do-not-store" } },
    { profile: { session_cookie: "do-not-store" } },
    { profile: { bearer: "do-not-store" } }
  ].forEach(data => {
    assert.throws(() => lp.upsertStudentProgramState(state, {
      providerId: "classcard", latestSnapshot: { snapshotId: "bad", data: data }
    }), /must not be stored/);
  });
  assert.equal(lp.isOpaqueAccountRef("student-ref:3"), true);
  assert.equal(lp.isOpaqueAccountRef("student password"), false);
});

test("프로그램 snapshot history는 개수와 바이트가 제한된다", () => {
  let state = elementaryState();
  for (let index = 0; index < 60; index += 1) {
    const at = new Date(Date.UTC(2026, 7, 1 + index));
    const date = at.toISOString().slice(0, 10);
    state = lp.applyApprovedProgramImport(state, approvedProgramCandidate({
      row_id: "row-" + index,
      check_date: date,
      approved_at: at.toISOString(),
      duplicate_key: "program-import:history:" + index,
      payload_hash: index.toString(16).padStart(64, "0"),
      source_date: date,
      data: { score: index, memo: "기록".repeat(180) }
    }));
  }
  const program = state.programStates[0];
  assert.ok(program.history.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(program.history), "utf8") <= 8 * 1024);
  assert.equal(program.historyRetention.maxEntries, 20);
  assert.equal(program.historyRetention.maxBytes, 8 * 1024);
  assert.ok(program.historyRetention.droppedCount > 0);
  assert.equal(program.latestSnapshot.data.score, 59);
});

test("4개 provider 이력을 함께 저장해도 lpcore 56KB 한도 안에 남는다", () => {
  let state = elementaryState();
  ["studyforce", "classcard", "metamath", "nelt"].forEach((providerId, providerIndex) => {
    for (let index = 0; index < 28; index += 1) {
      const at = new Date(Date.UTC(2026, 7, 1 + index));
      const date = at.toISOString().slice(0, 10);
      state = lp.applyApprovedProgramImport(state, approvedProgramCandidate({
        row_id: providerId + "-row-" + index,
        provider_id: providerId,
        check_date: date,
        approved_at: at.toISOString(),
        duplicate_key: "program-import:" + providerId + ":" + index,
        payload_hash: (providerIndex * 100 + index).toString(16).padStart(64, "0"),
        source_date: date,
        data: { score: index, memo: providerId + ":" + "기록".repeat(220) }
      }));
    }
  });
  const core = {
    schemaVersion: state.schemaVersion,
    student: state.student,
    settings: state.settings,
    programStates: state.programStates,
    migrationIssues: state.migrationIssues || []
  };
  state.programStates.forEach(program => {
    assert.ok(program.history.length <= 20);
    assert.ok(Buffer.byteLength(JSON.stringify(program.history), "utf8") <= 8 * 1024);
    assert.ok(program.historyRetention.droppedCount > 0);
  });
  assert.ok(Buffer.byteLength(JSON.stringify(core), "utf8") <= 56 * 1024);
});
