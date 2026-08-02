"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lp = require("./learning-platform.js");
const imports = require("./program-imports.js");

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

test("주간평가 증분 창은 기준일의 격주 위상과 회차 ID를 보존한다", () => {
  const schedule = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2026-01-05",
    kind: "weekly",
    weekday: 5,
    intervalWeeks: 2
  });
  const full = lp.expandAssessmentSchedule(schedule, "2026-01-01", "2026-02-06");
  const incremental = lp.expandAssessmentSchedule(schedule, "2026-01-12", "2026-02-06");
  assert.deepEqual(full.map((x) => x.scheduledDate), ["2026-01-09", "2026-01-23", "2026-02-06"]);
  assert.deepEqual(incremental.map((x) => x.scheduledDate), ["2026-01-23", "2026-02-06"]);
  assert.deepEqual(incremental.map((x) => x.occurrenceId), full.slice(1).map((x) => x.occurrenceId));
});

test("월말평가 증분 창은 기준 월의 분기 위상과 회차 ID를 보존한다", () => {
  const schedule = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2026-01-01",
    kind: "month_end",
    intervalMonths: 3,
    activeWeekdays: [1, 2, 3, 4, 5]
  });
  const full = lp.expandAssessmentSchedule(schedule, "2026-01-01", "2026-10-31");
  const incremental = lp.expandAssessmentSchedule(schedule, "2026-02-01", "2026-10-31");
  assert.deepEqual(full.map((x) => x.scheduledDate),
    ["2026-01-30", "2026-04-30", "2026-07-31", "2026-10-30"]);
  assert.deepEqual(incremental.map((x) => x.scheduledDate),
    ["2026-04-30", "2026-07-31", "2026-10-30"]);
  assert.deepEqual(incremental.map((x) => x.occurrenceId), full.slice(1).map((x) => x.occurrenceId));
});

test("월말평가는 윤년과 먼 증분 범위에서도 anchor 월 위상을 유지한다", () => {
  const leapSchedule = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2027-11-01",
    kind: "month_end",
    intervalMonths: 3,
    activeWeekdays: [1, 2, 3, 4, 5]
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(leapSchedule, "2028-01-15", "2028-05-31").map((x) => x.scheduledDate),
    ["2028-02-29", "2028-05-31"]
  );

  const longRangeSchedule = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2000-01-01",
    kind: "month_end",
    intervalMonths: 3,
    activeWeekdays: [1, 2, 3, 4, 5]
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(longRangeSchedule, "2050-02-01", "2050-10-31").map((x) => x.scheduledDate),
    ["2050-04-29", "2050-07-29", "2050-10-31"]
  );
});

test("월말평가 학습 요일은 검증·정수화·중복 제거된다", () => {
  const normalized = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2026-01-01",
    kind: "month_end",
    activeWeekdays: [1, 1, "5", 5]
  });
  assert.deepEqual(normalized.cadence.activeWeekdays, [1, 5]);
  const sundayOnly = lp.createMetaMathSchedule({
    studentCode: "E-3",
    anchorDate: "2026-08-01",
    kind: "month_end",
    activeWeekdays: [0]
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(sundayOnly, "2026-08-01", "2026-08-31").map((x) => x.scheduledDate),
    ["2026-08-30"]
  );

  for (const activeWeekdays of [[], [7], [Number.NaN]]) {
    assert.throws(() => lp.createMetaMathSchedule({
      studentCode: "E-3",
      anchorDate: "2026-01-01",
      kind: "month_end",
      activeWeekdays
    }), /activeWeekdays/);
  }
});

test("평가 요일은 decimal 한 자리 숫자만 허용하고 강제변환 입력을 차단한다", () => {
  const allowedWeekly = lp.createMetaMathSchedule({
    studentCode: "E-3", anchorDate: "2026-08-01", kind: "weekly", weekday: "0"
  });
  assert.equal(allowedWeekly.cadence.weekday, 0);
  const allowedMonthEnd = lp.createMetaMathSchedule({
    studentCode: "E-3", anchorDate: "2026-08-01", kind: "month_end", activeWeekdays: [0, "6"]
  });
  assert.deepEqual(allowedMonthEnd.cadence.activeWeekdays, [0, 6]);

  for (const weekday of [null, "", " ", true, "0x1", "01", 1.5]) {
    assert.throws(() => lp.createMetaMathSchedule({
      studentCode: "E-3", anchorDate: "2026-08-01", kind: "weekly", weekday
    }), /weekday/);
  }
  for (const activeWeekdays of [[null], [""], [" "], [true], ["0x1"], ["01"], [1.5], Array(2)]) {
    assert.throws(() => lp.createMetaMathSchedule({
      studentCode: "E-3", anchorDate: "2026-08-01", kind: "month_end", activeWeekdays
    }), /activeWeekdays/);
  }
});

test("서로 다른 custom 평가 scheduleId는 일정·회차를 독립 보존한다", () => {
  let state = elementaryState();
  const first = lp.createAssessmentSchedule({
    scheduleId: "custom-exam-a",
    studentCode: state.student.studentCode,
    scheduleType: "custom",
    title: "사용자 시험 A",
    anchorDate: "2026-09-01",
    cadence: { kind: "once" }
  });
  const second = lp.createAssessmentSchedule({
    scheduleId: "custom-exam-b",
    studentCode: state.student.studentCode,
    scheduleType: "custom",
    title: "사용자 시험 B",
    anchorDate: "2026-10-01",
    cadence: { kind: "once" }
  });
  assert.notEqual(first.semanticKey, second.semanticKey);
  assert.equal(lp.createAssessmentSchedule(Object.assign({}, first, {
    title: "사용자 시험 A 수정", anchorDate: "2026-11-01"
  })).semanticKey, first.semanticKey);

  state = lp.addAssessmentSchedule(state, first, {
    fromDate: "2026-09-01", toDate: "2026-09-01"
  });
  state = lp.addAssessmentSchedule(state, second, {
    fromDate: "2026-10-01", toDate: "2026-10-01"
  });
  assert.deepEqual(state.assessmentSchedules.map((item) => item.scheduleId).sort(),
    ["custom-exam-a", "custom-exam-b"]);
  assert.deepEqual(state.assessmentOccurrences.map((item) => [item.scheduleId, item.title, item.scheduledDate]).sort(), [
    ["custom-exam-a", "사용자 시험 A", "2026-09-01"],
    ["custom-exam-b", "사용자 시험 B", "2026-10-01"]
  ]);
});

test("장거리 평가 범위는 조용히 잘리지 않고 months 증분은 anchor에서 직접 이동한다", () => {
  const weekly = lp.createMetaMathSchedule({
    studentCode: "E-3", anchorDate: "2000-01-03", kind: "weekly", weekday: 1
  });
  assert.throws(() => lp.expandAssessmentSchedule(weekly, "2000-01-01", "2050-12-31"),
    /exceeds 1000 occurrences/);
  assert.equal(lp.expandAssessmentSchedule(weekly, "2049-01-01", "2050-12-31").length, 104);

  const nelt = lp.createNeltSchedule({
    studentCode: "E-3", anchorDate: "2000-01-31"
  });
  assert.deepEqual(
    lp.expandAssessmentSchedule(nelt, "2400-01-01", "2400-12-31").map((item) => item.scheduledDate),
    ["2400-01-31", "2400-04-30", "2400-07-31", "2400-10-31"]
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

test("semantic 평가 일정은 기존 anchor ID와 완료 이력을 보존하며 미래 예정만 교체한다", () => {
  let state = elementaryState();
  const legacySchedule = lp.createMetaMathSchedule({
    scheduleId: "legacy-anchor-weekly-id",
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-03",
    kind: "weekly",
    weekday: 5
  });
  state = lp.addAssessmentSchedule(state, legacySchedule, {
    fromDate: "2026-08-03", toDate: "2026-08-31"
  });
  const completedOccurrence = state.assessmentOccurrences.find((item) => item.scheduledDate === "2026-08-07");
  const completedPlanner = state.plannerItems.find((item) => item.occurrenceId === completedOccurrence.occurrenceId);
  const resultOccurrence = state.assessmentOccurrences.find((item) => item.scheduledDate === "2026-08-14");
  const resultPlanner = state.plannerItems.find((item) => item.occurrenceId === resultOccurrence.occurrenceId);
  resultOccurrence.status = "result_review";
  resultOccurrence.externalRef = "metamath-result:2026-08-14";
  resultPlanner.status = "verification_waiting";
  state = lp.claimPlannerItemCompletion(state, completedPlanner.itemId, "student:done", "2026-08-06T00:00:00.000Z");
  state = approveAssessmentResultAtTestNow(state, completedOccurrence.occurrenceId, {
    score: 8,
    maxScore: 10,
    evidenceRef: "teacher:verified",
    externalRef: "metamath:result-2026-08-07",
    verifiedBy: "teacher-1",
    verifiedAt: "2026-08-07T01:00:00.000Z"
  });

  state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-04",
    kind: "weekly",
    weekday: 3
  }), { fromDate: "2026-08-04", toDate: "2026-08-31" });

  assert.equal(state.assessmentSchedules.length, 1);
  assert.equal(state.assessmentSchedules[0].scheduleId, "legacy-anchor-weekly-id");
  assert.equal(state.assessmentSchedules[0].anchorDate, "2026-08-03");
  assert.equal(state.assessmentSchedules[0].cadence.weekday, 3);
  assert.equal(state.plannerItems.find((item) => item.itemId === completedPlanner.itemId).status, "completed");
  assert.equal(state.assessmentOccurrences.some((item) => item.occurrenceId === completedOccurrence.occurrenceId), true);
  const preservedResult = state.assessmentOccurrences.find((item) => item.occurrenceId === resultOccurrence.occurrenceId);
  assert.equal(preservedResult.status, "result_review");
  assert.equal(preservedResult.externalRef, "metamath-result:2026-08-14");
  assert.equal(state.plannerItems.find((item) => item.itemId === resultPlanner.itemId).status, "verification_waiting");
  assert.equal(state.assessmentOccurrences.some((item) => item.scheduledDate === "2026-08-21"), false);
  assert.equal(state.assessmentOccurrences.some((item) => item.scheduledDate === "2026-08-12"), true);
  const semanticDates = state.assessmentOccurrences
    .filter((item) => item.scheduleType === "metamath_weekly")
    .map((item) => item.scheduledDate);
  assert.equal(new Set(semanticDates).size, semanticDates.length);
});

test("평가 anchor는 명시 reset에서만 변경된다", () => {
  let state = elementaryState();
  state = lp.addAssessmentSchedule(state, lp.createNeltSchedule({
    studentCode: state.student.studentCode, anchorDate: "2026-08-03"
  }), { fromDate: "2026-08-03", toDate: "2027-08-03" });
  state = lp.addAssessmentSchedule(state, lp.createNeltSchedule({
    studentCode: state.student.studentCode, anchorDate: "2026-08-04"
  }), { fromDate: "2026-08-04", toDate: "2027-08-04" });
  assert.equal(state.assessmentSchedules[0].anchorDate, "2026-08-03");
  state = lp.addAssessmentSchedule(state, lp.createNeltSchedule({
    studentCode: state.student.studentCode, anchorDate: "2026-08-04"
  }), { fromDate: "2026-08-04", toDate: "2027-08-04", resetAnchor: true });
  assert.equal(state.assessmentSchedules[0].anchorDate, "2026-08-04");
});

test("평가 결과는 사람 승인 전 플래너를 완료하지 않고 승인 이력을 누적한다", () => {
  let state = elementaryState();
  state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-03",
    kind: "weekly",
    weekday: 5
  }), { fromDate: "2026-08-03", toDate: "2026-08-14" });
  const occurrence = state.assessmentOccurrences[0];
  const planner = state.plannerItems.find((item) => item.occurrenceId === occurrence.occurrenceId);
  assert.equal(occurrence.status, "scheduled");
  assert.equal(planner.status, "planned");
  state = lp.claimPlannerItemCompletion(state, planner.itemId, "student:completed", "2026-08-07T08:00:00.000Z");
  assert.throws(() => lp.verifyPlannerItemCompletion(state, planner.itemId, {
    approved: true, evidenceRef: "teacher:generic-check", verifiedBy: "teacher-1",
    verifiedAt: "2026-08-07T08:30:00.000Z"
  }), /approved assessment result/);
  assert.equal(state.plannerItems.find((item) => item.itemId === planner.itemId).status, "verification_waiting");
  assert.equal(state.assessmentOccurrences.find((item) => item.occurrenceId === occurrence.occurrenceId).status, "scheduled");
  assert.throws(() => approveAssessmentResultAtTestNow(state, occurrence.occurrenceId, {
    score: 11, maxScore: 10, evidenceRef: "teacher:report", verifiedBy: "teacher-1",
    verifiedAt: "2026-08-07T09:00:00.000Z"
  }), /must not exceed/);
  assert.throws(() => approveAssessmentResultAtTestNow(state, occurrence.occurrenceId, {
    score: 8, maxScore: 10, verifiedBy: "teacher-1", verifiedAt: "2026-08-07T09:00:00.000Z"
  }), /evidenceRef/);
  assert.equal(state.plannerItems.find((item) => item.itemId === planner.itemId).status, "verification_waiting");

  state = approveAssessmentResultAtTestNow(state, occurrence.occurrenceId, {
    score: 8, maxScore: 10, evidenceRef: "teacher:report-1", externalRef: "metamath:result-1",
    verifiedBy: "teacher-1", verifiedAt: "2026-08-07T09:00:00.000Z"
  });
  let approved = state.assessmentOccurrences.find((item) => item.occurrenceId === occurrence.occurrenceId);
  let completedPlanner = state.plannerItems.find((item) => item.itemId === planner.itemId);
  assert.equal(approved.status, "verified");
  assert.equal(approved.verificationStatus, "verified");
  assert.equal(approved.latestResult.percentage, 80);
  assert.equal(approved.resultHistory.length, 1);
  assert.equal(approved.history.at(-1).event, "result_approved");
  assert.equal(completedPlanner.status, "completed");
  assert.equal(completedPlanner.verifiedBy, "teacher-1");
  assert.deepEqual(completedPlanner.verificationEvidenceRefs, ["teacher:report-1"]);

  state = approveAssessmentResultAtTestNow(state, occurrence.occurrenceId, {
    score: 9, maxScore: 10, evidenceRef: "teacher:corrected-report", externalRef: "metamath:result-2",
    verifiedBy: "teacher-2", verifiedAt: "2026-08-07T10:00:00.000Z"
  });
  approved = state.assessmentOccurrences.find((item) => item.occurrenceId === occurrence.occurrenceId);
  completedPlanner = state.plannerItems.find((item) => item.itemId === planner.itemId);
  assert.equal(approved.resultHistory.length, 2);
  assert.equal(approved.resultHistory[0].externalRef, "metamath:result-1");
  assert.equal(approved.latestResult.score, 9);
  assert.equal(approved.history.length, 2);
  assert.deepEqual(completedPlanner.verificationEvidenceRefs, ["teacher:report-1", "teacher:corrected-report"]);

  const studentHtml = lp.renderAssessments(state, "2026-08-03");
  assert.match(studentHtml, /다가오는 평가/);
  assert.match(studentHtml, /최근 결과/);
  assert.match(studentHtml, new RegExp("9/10"));
  assert.match(studentHtml, /2026-08-14/);
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

test("초등 경시·KMT·NELT 캠페인은 근거가 있는 순차 승인만 완료된다", () => {
  ["contest", "kmt", "nelt"].forEach((campaignType, index) => {
    let state = elementaryState();
    state = lp.addPrepCampaign(state, {
      campaignType,
      title: campaignType.toUpperCase() + " 가을 일정",
      examDate: "2020-10-" + String(10 + index).padStart(2, "0")
    });
    const campaignId = state.prepCampaigns[0].campaignId;
    state = lp.activatePrepCampaign(state, campaignId, {
      approvedBy: "teacher-1",
      consentEvidenceRef: "consent:" + campaignType,
      consentApprovedBy: "teacher-1",
      consentApprovedAt: "2020-08-03T09:00:00.000Z"
    });
    assert.equal(state.prepCampaigns[0].status, "active");
    assert.throws(() => lp.transitionPrepCampaign(state, campaignId, "taken", {
      actor: "teacher-1", at: "2020-10-01T09:00:00.000Z", evidenceRef: "skip:not-allowed"
    }), /transition is invalid/);
    assert.throws(() => lp.transitionPrepCampaign(state, campaignId, "exam_ready", {
      actor: "teacher-1", at: "2020-10-01T09:00:00.000Z"
    }), /evidenceRef/);

    const examDay = 10 + index;
    const transitions = [
      ["exam_ready", "checklist:" + campaignType, examDay - 1],
      ["taken", "attendance:" + campaignType, examDay],
      ["result_waiting", "provider-pending:" + campaignType, examDay + 1]
    ];
    transitions.forEach(([toStatus, evidenceRef, day]) => {
      state = lp.transitionPrepCampaign(state, campaignId, toStatus, {
        actor: "teacher-1",
        at: "2020-10-" + String(day).padStart(2, "0") + "T09:00:00.000Z",
        evidenceRef
      });
    });
    assert.throws(() => lp.transitionPrepCampaign(state, campaignId, "result_review", {
      actor: "teacher-1", at: "2020-10-" + String(examDay + 2).padStart(2, "0") + "T09:00:00.000Z",
      evidenceRef: "result:" + campaignType
    }), /resultSummary/);
    state = lp.transitionPrepCampaign(state, campaignId, "result_review", {
      actor: "teacher-1", at: "2020-10-" + String(examDay + 2).padStart(2, "0") + "T09:00:00.000Z",
      evidenceRef: "result:" + campaignType,
      externalRef: "official:" + campaignType,
      resultSummary: "목표 영역 확인",
      score: 85,
      maxScore: 100
    });
    state = lp.transitionPrepCampaign(state, campaignId, "completed", {
      actor: "teacher-2", at: "2020-10-" + String(examDay + 3).padStart(2, "0") + "T09:00:00.000Z",
      evidenceRef: "review-complete:" + campaignType
    });
    const completed = state.prepCampaigns[0];
    assert.equal(completed.status, "completed");
    assert.equal(completed.latestResult.summary, "목표 영역 확인");
    assert.equal(completed.resultHistory.length, 1);
    assert.equal(completed.history.length, 6);
    assert.deepEqual(completed.history.map((entry) => entry.toStatus), [
      "active", "exam_ready", "taken", "result_waiting", "result_review", "completed"
    ]);
    assert.match(lp.renderCampaigns(state, "2026-08-03"), /목표 영역 확인/);
  });
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

test("숙달·종료 오답을 다시 등록하면 증거와 이력을 보존한 채 새 주기로 연다", () => {
  ["mastered", "closed"].forEach((status, index) => {
    const state = elementaryState();
    const previousAttempt = {
      attemptNo: 1,
      externalResultRef: "result-evidence-" + status,
      correctCount: 5,
      totalCount: 5,
      receivedAt: "2026-08-02T06:00:00.000Z"
    };
    const existing = lp.createWrongAnswerCase({
      studentCode: state.student.studentCode,
      textbookId: "math-3-2",
      page: "72",
      problemNo: "13",
      skillCode: "분수 비교",
      status,
      attemptNo: 1,
      attempts: [previousAttempt],
      revision: 8,
      verifiedBy: "teacher-old",
      history: [
        { from: "", to: "captured", at: "2026-08-01T00:00:00.000Z", actor: "teacher-old" },
        { from: "verification_waiting", to: status, at: "2026-08-02T07:00:00.000Z", actor: "teacher-old" }
      ]
    });
    existing.resultEvidenceRefs = ["teacher-review:" + (index + 1)];
    state.remediationCases = [existing];

    const next = lp.addRemediationCase(state, {
      studentCode: state.student.studentCode,
      textbookId: "math-3-2",
      page: "72",
      problemNo: "13",
      skillCode: "분수 비교 재확인",
      createdBy: "teacher-new",
      createdAt: "2026-08-03T08:00:00.000Z"
    });
    const reopened = next.remediationCases[0];

    assert.equal(state.remediationCases[0].status, status);
    assert.equal(reopened.status, "captured");
    assert.equal(reopened.revision, 9);
    assert.equal(reopened.attemptNo, 1);
    assert.deepEqual(reopened.attempts, [previousAttempt]);
    assert.deepEqual(reopened.resultEvidenceRefs, ["teacher-review:" + (index + 1)]);
    assert.equal(reopened.verifiedBy, "teacher-old");
    assert.equal(reopened.history.length, existing.history.length + 1);
    assert.deepEqual(reopened.history.at(-1), {
      from: status,
      to: "captured",
      at: "2026-08-03T08:00:00.000Z",
      actor: "teacher-new",
      note: "동일 교재 문항 오답 재등록 · 새 재학습 주기 시작"
    });
  });
});

test("쌍둥이 결과는 맞은 수와 전체 수를 검증하고 숫자로 보존한다", () => {
  const submitted = lp.createWrongAnswerCase({
    studentCode: "E-3",
    textbookId: "math-3-2",
    page: "72",
    problemNo: "13",
    status: "submitted",
    revision: 4,
    history: [{ from: "assigned", to: "submitted", at: "2026-08-03T05:00:00.000Z", actor: "teacher-1" }]
  });

  assert.throws(() => lp.recordTwinResult(submitted, {
    externalResultRef: "result-missing-correct", totalCount: 5
  }), /correctCount is required/);
  assert.throws(() => lp.recordTwinResult(submitted, {
    externalResultRef: "result-missing-total", correctCount: 0
  }), /totalCount is required/);
  assert.throws(() => lp.recordTwinResult(submitted, {
    externalResultRef: "result-zero-total", correctCount: 0, totalCount: 0
  }), /positive integer/);
  assert.throws(() => lp.recordTwinResult(submitted, {
    externalResultRef: "result-negative", correctCount: -1, totalCount: 5
  }), /non-negative integer/);
  assert.throws(() => lp.recordTwinResult(submitted, {
    externalResultRef: "result-over", correctCount: 6, totalCount: 5
  }), /cannot exceed/);

  const recorded = lp.recordTwinResult(submitted, {
    externalResultRef: "result-valid",
    correctCount: "4",
    totalCount: "5",
    receivedAt: "2026-08-03T06:00:00.000Z",
    actor: "teacher-1"
  });
  assert.equal(recorded.status, "verification_waiting");
  assert.equal(recorded.revision, 5);
  assert.equal(recorded.attemptNo, 1);
  assert.deepEqual(recorded.attempts[0], {
    attemptNo: 1,
    externalResultRef: "result-valid",
    correctCount: 4,
    totalCount: 5,
    receivedAt: "2026-08-03T06:00:00.000Z"
  });
});

test("미완료 플래너 편집·취소는 ID와 출처 근거를 보존하고 감사 이력을 남긴다", () => {
  let state = elementaryState();
  state = lp.addPlannerItem(state, {
    itemId: "todo-edit-1",
    studentCode: state.student.studentCode,
    date: "2026-08-03",
    title: "기존 학습",
    sourceType: "academy",
    minutes: 20,
    status: "planned",
    evidenceRefs: ["assignment:source"]
  });
  const original = state.plannerItems[0];
  state = lp.editPlannerItem(state, original.itemId, {
    date: "2026-08-04", title: "수정 학습", minutes: 25
  }, { actor: "teacher-1", at: "2026-08-03T10:00:00.000Z", reason: "일정 조정" });
  const edited = state.plannerItems[0];
  assert.equal(edited.itemId, original.itemId);
  assert.notEqual(edited.planId, original.planId);
  assert.equal(edited.status, "planned");
  assert.deepEqual(edited.evidenceRefs, ["assignment:source"]);
  assert.equal(edited.history.at(-1).action, "edited");
  assert.deepEqual(edited.history.at(-1).changes.date, { from: "2026-08-03", to: "2026-08-04" });
  assert.throws(() => lp.cancelPlannerItem(state, edited.itemId, { canceledBy: "teacher-1" }), /cancel reason/);
  state = lp.cancelPlannerItem(state, edited.itemId, {
    reason: "학생 일정 변경", canceledBy: "teacher-1", canceledAt: "2026-08-03T11:00:00.000Z"
  });
  const canceled = state.plannerItems[0];
  assert.equal(canceled.status, "canceled");
  assert.deepEqual(canceled.evidenceRefs, ["assignment:source"]);
  assert.equal(canceled.history.at(-1).action, "canceled");
  assert.match(lp.renderTodayPlanner(state, "2026-08-04", true), /취소 사유: 학생 일정 변경/);
});

test("이월 요청은 관리자 승인·반려를 거치고 원본 근거와 파생 관계를 보존한다", () => {
  let state = elementaryState();
  state = lp.addPlannerItem(state, {
    itemId: "carry-review-1", studentCode: state.student.studentCode,
    date: "2026-08-03", title: "독해 복습", sourceType: "academy",
    evidenceRefs: ["source:book-1"], verificationRequired: false
  });
  state = lp.claimPlannerItemCompletion(state, "carry-review-1", "student:claim", "2026-08-03T08:00:00.000Z");
  assert.equal(state.plannerItems[0].status, "verification_waiting");
  state = lp.addPlannerItem(elementaryState(), {
    itemId: "carry-review-1", studentCode: "E-3", date: "2026-08-03",
    title: "독해 복습", sourceType: "academy", evidenceRefs: ["source:book-1"]
  });
  assert.throws(() => lp.requestPlannerCarryover(state, "carry-review-1", "2026-08-03", {
    requestedBy: "teacher-1"
  }), /later than planner item date/);
  assert.throws(() => lp.requestPlannerCarryover(state, "carry-review-1", "2026-08-02", {
    requestedBy: "teacher-1"
  }), /later than planner item date/);
  state = lp.requestPlannerCarryover(state, "carry-review-1", "2026-08-04", {
    reason: "미완료", requestedBy: "teacher-1", requestedAt: "2026-08-03T09:00:00.000Z"
  });
  assert.equal(state.plannerItems[0].status, "carryover_candidate");
  assert.equal(state.plannerItems[0].history.at(-1).requestedBy, "teacher-1");
  assert.throws(() => lp.reviewPlannerCarryover(state, "carry-review-1", {
    approved: true, reviewedBy: "manager-1", date: "2026-08-03"
  }), /later than planner item date/);
  assert.throws(() => lp.reviewPlannerCarryover(state, "carry-review-1", {
    approved: false, reviewedBy: "manager-1"
  }), /rejection reason/);
  state = lp.reviewPlannerCarryover(state, "carry-review-1", {
    approved: false, reason: "오늘 재시도", reviewedBy: "manager-1", reviewedAt: "2026-08-03T10:00:00.000Z"
  });
  assert.equal(state.plannerItems[0].status, "planned");
  assert.equal(state.plannerItems[0].history.at(-1).action, "carryover_rejected");
  assert.equal(state.plannerItems[0].history.at(-1).requestedBy, "teacher-1");
  assert.equal(state.plannerItems[0].history.at(-1).reviewedBy, "manager-1");
  state = lp.requestPlannerCarryover(state, "carry-review-1", "2026-08-05", {
    reason: "수업 후 수행", requestedBy: "teacher-1", requestedAt: "2026-08-03T11:00:00.000Z"
  });
  state = lp.reviewPlannerCarryover(state, "carry-review-1", {
    approved: true, reviewedBy: "manager-1", reviewedAt: "2026-08-03T12:00:00.000Z"
  });
  assert.equal(state.plannerItems.length, 2);
  const original = state.plannerItems.find(item => item.itemId === "carry-review-1");
  const derived = state.plannerItems.find(item => item.itemId !== "carry-review-1");
  assert.equal(original.status, "carried_over");
  assert.deepEqual(original.evidenceRefs, ["source:book-1"]);
  assert.equal(original.history.at(-1).action, "carryover_approved");
  assert.equal(original.history.at(-1).requestedBy, "teacher-1");
  assert.equal(original.history.at(-1).reviewedBy, "manager-1");
  assert.equal(derived.status, "planned");
  assert.equal(derived.originItemId, original.itemId);
  assert.equal(derived.date, "2026-08-05");
  assert.deepEqual(derived.verificationEvidenceRefs, []);
});

test("custom provider는 자격정보 없이 등록·중지되고 generic import로 연결된다", async () => {
  let state = elementaryState();
  assert.throws(() => lp.registerCustomProvider(state, {
    id: "future-reader", label: "미래 리더", password: "never-store"
  }), /credentials/);
  assert.throws(() => lp.registerCustomProvider(state, {
    id: "classcard", label: "충돌"
  }), /built-in/);
  state = lp.registerCustomProvider(state, {
    id: "future-reader", label: "미래 리더", capabilities: ["progress", "result", "assignment"]
  }, { actor: "manager-1", at: "2026-08-03T09:00:00.000Z" });
  let registry = lp.createProviderRegistry(state.settings.customProviders);
  assert.equal(registry["future-reader"].label, "미래 리더");
  state = lp.upsertStudentProgramState(state, {
    providerId: "future-reader", status: "active", assignedCount: 10, completedCount: 4
  }, registry);
  state = lp.upsertStudentProgramState(state, {
    providerId: "future-reader", status: "partial", assignedCount: "", completedCount: ""
  }, registry);
  assert.equal(state.programStates[0].assignedCount, 10);
  assert.equal(state.programStates[0].completedCount, 4);
  const definitions = lp.createProgramImportProviderDefinitions(state.settings.customProviders);
  const importRegistry = imports.createDefaultRegistry(definitions);
  const preview = await imports.previewImport({
    registry: importRegistry,
    providerId: "future-reader",
    input: JSON.stringify([{ student_code: "E-3", check_date: "2026-08-03", status: "부분완료", progress_pct: 45, current_unit: "12회", score: 80 }]),
    studentDirectory: [{ student_code: "E-3", external_ids: {} }]
  });
  assert.equal(preview.provider.id, "future-reader");
  assert.equal(preview.candidates[0].data.progress_pct, 45);
  state = lp.setCustomProviderActive(state, "future-reader", false, {
    actor: "manager-1", at: "2026-08-03T10:00:00.000Z"
  });
  registry = lp.createProviderRegistry(state.settings.customProviders);
  assert.equal(registry["future-reader"].active, false);
  assert.equal(lp.createProgramImportProviderDefinitions(state.settings.customProviders).length, 0);
  const migrated = lp.migrateLearningPlatformState(state).state;
  assert.equal(migrated.settings.customProviders[0].id, "future-reader");
  assert.equal(migrated.programStates[0].providerId, "future-reader");
});

test("프로그램 카드에는 snapshot 진행률·진도·점수를 보이고 알 수 없는 0/0은 숨긴다", () => {
  let state = elementaryState();
  state = lp.upsertStudentProgramState(state, {
    providerId: "studyforce",
    status: "partial",
    latestSnapshot: {
      providerId: "studyforce", studentCode: state.student.studentCode,
      checkDate: "2026-08-03", status: "partial",
      data: { progress_pct: 45, current_unit: "12회", score: 80, target_score: 100 }
    }
  });
  const html = lp.renderPrograms(state);
  assert.match(html, /보고 진행률 45%/);
  assert.match(html, /진도 12회/);
  assert.match(html, /점수 80\/100/);
  assert.doesNotMatch(html, /0\/0 수행/);
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


test("custom provider 이름·별칭 충돌은 등록·활성화 전에 한국어로 차단한다", () => {
  const builtInAliases = [
    "studyforce", "스터디포스", "StudyForce", "study force", "스터디 포스",
    "classcard", "클래스카드", "ClassCard", "class card", "클래스 카드",
    "metamath", "메타수학", "MetaMath", "meta math", "메타 수학",
    "nelt", "넬트", "NELT", "nelt assessment", "manual", "직접 관리"
  ];
  builtInAliases.forEach((alias, index) => {
    assert.throws(() => lp.registerCustomProvider(elementaryState(), {
      id: "label-conflict-" + index,
      label: alias
    }), /기본 온라인 프로그램.*충돌/);
    assert.throws(() => lp.registerCustomProvider(elementaryState(), {
      id: "alias-conflict-" + index,
      label: "고유 프로그램 " + index,
      aliases: [alias]
    }), /기본 온라인 프로그램.*충돌/);
  });
  assert.throws(() => lp.registerCustomProvider(elementaryState(), {
    id: "nfkc-conflict",
    label: "Ｃｌａｓｓ　Ｃａｒｄ"
  }), /기본 온라인 프로그램.*충돌/);

  let state = lp.registerCustomProvider(elementaryState(), {
    id: "reading-lab",
    label: "리딩 랩",
    aliases: ["Read.Lab", "독해(랩)"],
    capabilities: ["progress"]
  }, { actor: "manager-1", at: "2026-08-03T09:00:00.000Z" });
  assert.throws(() => lp.registerCustomProvider(state, {
    id: "other-reading",
    label: "READ_LAB"
  }), /다른 사용자 지정 프로그램.*충돌/);
  assert.throws(() => lp.registerCustomProvider(state, {
    id: "other-korean",
    label: "고유 독해",
    aliases: ["독해 [랩]"]
  }), /다른 사용자 지정 프로그램.*충돌/);
  const definitions = lp.createProgramImportProviderDefinitions(state.settings.customProviders);
  assert.deepEqual(definitions[0].aliases, ["Read.Lab", "독해(랩)"]);
  assert.doesNotThrow(() => imports.createDefaultRegistry(definitions));

  const builtInLegacy = elementaryState();
  builtInLegacy.settings.customProviders = [{
    id: "legacy-class",
    label: "레거시 클래스",
    aliases: ["클래스[카드]"],
    capabilities: [],
    active: false
  }];
  assert.throws(() => lp.setCustomProviderActive(builtInLegacy, "legacy-class", true, {
    actor: "manager-1", at: "2026-08-03T10:00:00.000Z"
  }), /기본 온라인 프로그램.*충돌/);

  const customLegacy = elementaryState();
  customLegacy.settings.customProviders = [
    { id: "legacy-one", label: "알파 랩", aliases: [], capabilities: [], active: false },
    { id: "legacy-two", label: "베타 랩", aliases: ["알파-랩"], capabilities: [], active: false }
  ];
  assert.throws(() => lp.setCustomProviderActive(customLegacy, "legacy-two", true, {
    actor: "manager-1", at: "2026-08-03T10:00:00.000Z"
  }), /다른 사용자 지정 프로그램.*충돌/);
});

function assessmentApprovalState(timeZone) {
  let state = elementaryState();
  state.student.timeZone = timeZone;
  return lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-07",
    kind: "weekly",
    weekday: 5
  }), { fromDate: "2026-08-07", toDate: "2026-08-07" });
}

function assessmentApprovalInput(overrides) {
  return Object.assign({
    score: 8,
    maxScore: 10,
    evidenceRef: "teacher:assessment-check",
    verifiedBy: "teacher-1",
    verifiedAt: "2026-08-06T15:00:00.000Z"
  }, overrides || {});
}

function approveAssessmentResultAtTestNow(state, occurrenceId, approval) {
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-08-08T00:00:00.000Z");
    return lp.approveAssessmentResult(state, occurrenceId, approval);
  } finally {
    Date.now = originalNow;
  }
}

test("평가 verifiedAt은 현재 +5분 경계를 허용하고 미래 독성과 단조성 위반을 차단한다", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-08-07T00:00:00.000Z");
    let state = assessmentApprovalState("Asia/Seoul");
    const occurrenceId = state.assessmentOccurrences[0].occurrenceId;
    state = lp.approveAssessmentResult(state, occurrenceId, assessmentApprovalInput({
      verifiedAt: "2026-08-07T00:05:00.000Z",
      evidenceRef: "teacher:five-minute-boundary"
    }));
    assert.equal(state.assessmentOccurrences[0].verifiedAt, "2026-08-07T00:05:00.000Z");

    const beforeFutureAttempt = JSON.parse(JSON.stringify(state));
    assert.throws(() => lp.approveAssessmentResult(state, occurrenceId, assessmentApprovalInput({
      verifiedAt: "2026-08-07T00:05:00.001Z",
      evidenceRef: "teacher:future-attempt",
      now: "2099-01-01T00:00:00.000Z"
    })), /assessment verifiedAt cannot be more than 5 minutes in the future/);
    assert.deepEqual(state, beforeFutureAttempt);

    assert.throws(() => lp.approveAssessmentResult(state, occurrenceId, assessmentApprovalInput({
      verifiedAt: "2026-08-07T00:05:00.000Z",
      evidenceRef: "teacher:same-time-attempt"
    })), /later than latest result/);

    Date.now = () => Date.parse("2026-08-07T00:10:00.000Z");
    state = lp.approveAssessmentResult(state, occurrenceId, assessmentApprovalInput({
      score: 9,
      verifiedAt: "2026-08-07T00:10:00.000Z",
      evidenceRef: "teacher:later-correction"
    }));
    assert.equal(state.assessmentOccurrences[0].resultHistory.length, 2);
    assert.equal(state.assessmentOccurrences[0].latestResult.score, 9);
  } finally {
    Date.now = originalNow;
  }
});

test("평가 승인은 학생 timezone의 예정일 경계를 넘은 뒤에만 가능하다", () => {
  let seoul = assessmentApprovalState("Asia/Seoul");
  const seoulOccurrence = seoul.assessmentOccurrences[0];
  assert.throws(() => approveAssessmentResultAtTestNow(seoul, seoulOccurrence.occurrenceId,
    assessmentApprovalInput({ verifiedAt: "2026-08-06T14:59:59.999Z" })),
  /학생 시간대 기준 평가 예정일 당일 이후/);
  seoul = approveAssessmentResultAtTestNow(seoul, seoulOccurrence.occurrenceId,
    assessmentApprovalInput({ verifiedAt: "2026-08-06T15:00:00.000Z" }));
  assert.equal(seoul.assessmentOccurrences[0].status, "verified");
  assert.equal(seoul.plannerItems[0].status, "completed");

  const losAngeles = assessmentApprovalState("America/Los_Angeles");
  const laOccurrence = losAngeles.assessmentOccurrences[0];
  assert.throws(() => approveAssessmentResultAtTestNow(losAngeles, laOccurrence.occurrenceId,
    assessmentApprovalInput({ verifiedAt: "2026-08-07T06:59:59.999Z" })),
  /학생 시간대 기준 평가 예정일 당일 이후/);
  assert.doesNotThrow(() => approveAssessmentResultAtTestNow(losAngeles, laOccurrence.occurrenceId,
    assessmentApprovalInput({ verifiedAt: "2026-08-07T07:00:00.000Z" })));

  const invalidZone = assessmentApprovalState("Invalid/Student_Timezone");
  assert.throws(() => approveAssessmentResultAtTestNow(
    invalidZone,
    invalidZone.assessmentOccurrences[0].occurrenceId,
    assessmentApprovalInput()
  ), /학생 시간대 설정이 올바르지 않아/);
});

test("평가 승인은 부적절 상태를 차단하고 verified 재승인 이력을 보존한다", () => {
  const base = assessmentApprovalState("Asia/Seoul");
  ["canceled", "missed", "paused", "reschedule_needed", "archived", "in_progress"].forEach((status) => {
    const blocked = JSON.parse(JSON.stringify(base));
    blocked.assessmentOccurrences[0].status = status;
    assert.throws(() => approveAssessmentResultAtTestNow(
      blocked,
      blocked.assessmentOccurrences[0].occurrenceId,
      assessmentApprovalInput()
    ), /현재 평가 상태.*승인할 수 없습니다/);
  });

  const reviewState = JSON.parse(JSON.stringify(base));
  reviewState.assessmentOccurrences[0].status = "result_review";
  const occurrenceId = reviewState.assessmentOccurrences[0].occurrenceId;
  let approved = approveAssessmentResultAtTestNow(reviewState, occurrenceId, assessmentApprovalInput());
  assert.throws(() => approveAssessmentResultAtTestNow(approved, occurrenceId, assessmentApprovalInput({
    verifiedAt: "2026-08-06T15:00:00.000Z"
  })), /later than latest result/);
  assert.throws(() => approveAssessmentResultAtTestNow(approved, occurrenceId, assessmentApprovalInput({
    verifiedAt: "2026-08-06T14:59:59.999Z"
  })), /later than latest result/);
  approved = approveAssessmentResultAtTestNow(approved, occurrenceId, assessmentApprovalInput({
    score: 9,
    evidenceRef: "teacher:corrected-assessment",
    verifiedBy: "teacher-2",
    verifiedAt: "2026-08-07T01:00:00.000Z"
  }));
  const occurrence = approved.assessmentOccurrences[0];
  assert.equal(occurrence.status, "verified");
  assert.equal(occurrence.resultHistory.length, 2);
  assert.equal(occurrence.history.length, 2);
  assert.equal(occurrence.history[0].fromStatus, "result_review");
  assert.equal(occurrence.history[1].fromStatus, "verified");
  assert.equal(occurrence.latestResult.score, 9);
  assert.deepEqual(approved.plannerItems[0].verificationEvidenceRefs,
    ["teacher:assessment-check", "teacher:corrected-assessment"]);
  assert.equal(approved.plannerItems[0].history.at(-2).action, "assessment_result_approved");
  assert.equal(approved.plannerItems[0].history.at(-1).action, "assessment_result_approved");
  assert.equal(approved.plannerItems[0].history.at(-1).fromStatus, "completed");
  assert.equal(approved.plannerItems[0].history.at(-1).resultId, occurrence.latestResult.resultId);
  assert.equal(approved.plannerItems[0].historyRetention.maxEntries, 30);
});

test("없는 플래너 이월 검토는 명시적인 not found 오류를 반환한다", () => {
  assert.throws(() => lp.reviewPlannerCarryover(elementaryState(), "missing-plan", {
    approved: true,
    reviewedBy: "manager-1",
    reviewedAt: "2026-08-03T09:00:00.000Z",
    date: "2026-08-04"
  }), /planner item not found: missing-plan/);
});

test("중복 planner add는 완료 lifecycle을 초기화하지 않고 멱등 병합한다", () => {
  const input = {
    studentCode: "E-3",
    date: "2026-08-03",
    title: "독해 완료 과제",
    sourceType: "academy",
    minutes: 20,
    evidenceRefs: ["assignment:original"]
  };
  let state = lp.addPlannerItem(elementaryState(), input);
  const itemId = state.plannerItems[0].itemId;
  state = lp.claimPlannerItemCompletion(state, itemId, "student:submission", "2026-08-03T09:00:00.000Z");
  state = lp.verifyPlannerItemCompletion(state, itemId, {
    approved: true,
    evidenceRef: "teacher:verified",
    verifiedBy: "teacher-1",
    verifiedAt: "2026-08-03T10:00:00.000Z"
  });
  const beforeDuplicate = JSON.parse(JSON.stringify(state));
  const idempotent = lp.addPlannerItem(state, input);
  assert.deepEqual(idempotent, beforeDuplicate);

  const withMergedRef = lp.addPlannerItem(idempotent, Object.assign({}, input, {
    status: "planned",
    minutes: 99,
    completedAt: "",
    verifiedAt: "",
    evidenceRefs: ["assignment:second"],
    verificationEvidenceRefs: ["teacher:second-reference"]
  }));
  const preserved = withMergedRef.plannerItems[0];
  const completed = beforeDuplicate.plannerItems[0];
  assert.equal(preserved.itemId, completed.itemId);
  assert.equal(preserved.status, "completed");
  assert.equal(preserved.minutes, 20);
  assert.equal(preserved.completedAt, completed.completedAt);
  assert.equal(preserved.verifiedAt, completed.verifiedAt);
  assert.equal(preserved.verifiedBy, completed.verifiedBy);
  assert.equal(preserved.verificationDecision, "approved");
  assert.deepEqual(preserved.history, completed.history);
  assert.deepEqual(preserved.evidenceRefs,
    ["assignment:original", "student:submission", "assignment:second"]);
  assert.deepEqual(preserved.verificationEvidenceRefs,
    ["teacher:verified", "teacher:second-reference"]);
});


test("장기 planner/provider 감사 이력은 최근 상한과 누적 retention을 보존한다", () => {
  let state = lp.registerCustomProvider(elementaryState(), {
    id: "long-running-provider",
    label: "장기 운영 프로그램",
    capabilities: ["progress"]
  }, { actor: "manager-1", at: "2026-08-03T00:00:00.000Z" });
  state = lp.addPlannerItem(state, {
    itemId: "long-running-plan",
    studentCode: state.student.studentCode,
    date: "2026-08-03",
    title: "장기 학습",
    sourceType: "academy",
    minutes: 20,
    evidenceRefs: ["assignment:long"]
  });
  for (let index = 0; index < 1000; index += 1) {
    state = lp.editPlannerItem(state, "long-running-plan", {
      title: "장기 학습 " + index
    }, {
      actor: "manager-1",
      at: new Date(Date.UTC(2026, 7, 4, 0, 0, index)).toISOString(),
      reason: "장기 편집"
    });
    state = lp.setCustomProviderActive(state, "long-running-provider", index % 2 === 1, {
      actor: "manager-1",
      at: new Date(Date.UTC(2026, 7, 5, 0, 0, index)).toISOString()
    });
  }
  const planner = state.plannerItems[0];
  const provider = state.settings.customProviders[0];
  assert.equal(planner.status, "planned");
  assert.deepEqual(planner.evidenceRefs, ["assignment:long"]);
  assert.deepEqual(planner.verificationEvidenceRefs, []);
  assert.equal(planner.history.length, 30);
  assert.equal(planner.historyRetention.maxEntries, 30);
  assert.equal(planner.historyRetention.droppedCount, 971);
  assert.equal(planner.historyRetention.oldestRetainedAt, planner.history[0].at);
  assert.equal(planner.historyRetention.newestRetainedAt, planner.history.at(-1).at);
  assert.equal(planner.history.at(-1).action, "edited");
  assert.equal(planner.revision, 1001);
  assert.equal(provider.history.length, 50);
  assert.equal(provider.historyRetention.maxEntries, 50);
  assert.equal(provider.historyRetention.droppedCount, 951);
  assert.equal(provider.historyRetention.oldestRetainedAt, provider.history[0].at);
  assert.equal(provider.historyRetention.newestRetainedAt, provider.history.at(-1).at);
  assert.equal(provider.history.at(-1).action, "enabled");
  assert.equal(provider.revision, 1001);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") < 56 * 1024);
});

test("비활성 custom provider는 stale registry 승인 후보도 차단하고 기존 기록은 렌더한다", () => {
  let state = lp.registerCustomProvider(elementaryState(), {
    id: "stale-provider",
    label: "중지 예정 프로그램",
    capabilities: ["progress", "result"]
  }, { actor: "manager-1", at: "2026-08-03T00:00:00.000Z" });
  const staleRegistry = lp.createProviderRegistry(state.settings.customProviders);
  state = lp.upsertStudentProgramState(state, {
    providerId: "stale-provider",
    status: "active",
    assignedCount: 5,
    completedCount: 2
  }, staleRegistry);
  state = lp.setCustomProviderActive(state, "stale-provider", false, {
    actor: "manager-1", at: "2026-08-03T01:00:00.000Z"
  });
  assert.equal(state.programStates[0].providerId, "stale-provider");
  assert.match(lp.renderPrograms(state), /중지 예정 프로그램/);
  assert.match(lp.renderPrograms(state), /연동 중지/);
  assert.throws(() => lp.upsertStudentProgramState(state, {
    providerId: "stale-provider",
    status: "partial"
  }, staleRegistry), /사용 중지된 온라인 프로그램/);
  assert.throws(() => lp.applyApprovedProgramImport(state, approvedProgramCandidate({
    provider_id: "stale-provider",
    duplicate_key: "program-import:stale-provider:1"
  }), staleRegistry), /사용 중지된 온라인 프로그램/);
  assert.equal(state.programStates.length, 1);
  assert.equal(state.programStates[0].completedCount, 2);
});

test("평가 연결 planner는 generic 편집·취소·이월과 중복 완료를 차단한다", () => {
  const state = assessmentApprovalState("Asia/Seoul");
  const occurrence = state.assessmentOccurrences[0];
  const planner = state.plannerItems[0];
  assert.throws(() => lp.editPlannerItem(state, planner.itemId, {
    title: "일반 편집 시도"
  }, { actor: "manager-1", at: "2026-08-07T00:00:00.000Z" }), /평가 일정\/결과 전용 경로/);
  assert.throws(() => lp.cancelPlannerItem(state, planner.itemId, {
    reason: "일반 취소 시도",
    canceledBy: "manager-1",
    canceledAt: "2026-08-07T00:00:00.000Z"
  }), /평가 일정\/결과 전용 경로/);
  assert.throws(() => lp.requestPlannerCarryover(state, planner.itemId, "2026-08-08", {
    requestedBy: "manager-1",
    requestedAt: "2026-08-07T00:00:00.000Z"
  }), /평가 일정\/결과 전용 경로/);

  const legacyCandidate = JSON.parse(JSON.stringify(state));
  legacyCandidate.plannerItems[0].status = "carryover_candidate";
  legacyCandidate.plannerItems[0].carryoverRequestedDate = "2026-08-08";
  legacyCandidate.plannerItems[0].carryoverPreviousStatus = "planned";
  assert.throws(() => lp.reviewPlannerCarryover(legacyCandidate, planner.itemId, {
    approved: true,
    reviewedBy: "manager-1",
    reviewedAt: "2026-08-07T00:00:00.000Z",
    date: "2026-08-08"
  }), /평가 일정\/결과 전용 경로/);
  assert.equal(legacyCandidate.plannerItems.length, 1);

  const duplicateState = JSON.parse(JSON.stringify(state));
  duplicateState.plannerItems.push(Object.assign({}, planner, {
    itemId: "legacy-assessment-child",
    originItemId: planner.itemId
  }));
  assert.throws(() => approveAssessmentResultAtTestNow(duplicateState, occurrence.occurrenceId,
    assessmentApprovalInput()), /평가 연결 플래너가 중복/);
  assert.equal(duplicateState.plannerItems.every((item) => item.status !== "completed"), true);

  const approved = approveAssessmentResultAtTestNow(state, occurrence.occurrenceId, assessmentApprovalInput());
  const linked = approved.plannerItems.filter((item) => item.occurrenceId === occurrence.occurrenceId);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].status, "completed");
});


function createAssessmentTombstoneFixture() {
  let state = elementaryState();
  const schedule = lp.createMetaMathSchedule({
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-07",
    kind: "weekly",
    weekday: 5
  });
  const window = { fromDate: "2026-08-07", toDate: "2026-08-07" };
  state = lp.addAssessmentSchedule(state, schedule, Object.assign({}, window, {
    at: "2026-08-01T00:00:00.000Z",
    actor: "schedule-manager"
  }));
  const occurrence = state.assessmentOccurrences[0];
  state = lp.addPlannerItem(state, Object.assign({}, state.plannerItems[0], {
    evidenceRefs: ["schedule:seed"],
    verificationEvidenceRefs: ["teacher:prior-note"]
  }));
  const beforePlanner = JSON.parse(JSON.stringify(state.plannerItems[0]));
  state = lp.addAssessmentSchedule(state, Object.assign({}, schedule, {
    enabled: false
  }), Object.assign({}, window, {
    at: "2026-08-02T00:00:00.000Z",
    actor: "schedule-manager"
  }));
  return { state, schedule, window, occurrence, beforePlanner };
}

test("평가 일정 삭제는 연결 계획을 revision+1 숨김 tombstone으로 보존한다", () => {
  const fixture = createAssessmentTombstoneFixture();
  let state = fixture.state;
  assert.equal(state.assessmentOccurrences.length, 0);
  assert.equal(state.plannerItems.length, 1);
  const tombstone = state.plannerItems[0];
  assert.equal(tombstone.itemId, fixture.beforePlanner.itemId);
  assert.equal(tombstone.status, "canceled");
  assert.equal(tombstone.systemHidden, true);
  assert.equal(tombstone.systemHiddenReason, "assessment_schedule_removed");
  assert.equal(tombstone.systemHiddenAt, "2026-08-02T00:00:00.000Z");
  assert.equal(tombstone.systemHiddenBy, "schedule-manager");
  assert.equal(tombstone.revision, fixture.beforePlanner.revision + 1);
  assert.deepEqual(tombstone.evidenceRefs, ["schedule:seed"]);
  assert.deepEqual(tombstone.verificationEvidenceRefs, ["teacher:prior-note"]);
  assert.equal(tombstone.history.at(-1).action, "assessment_schedule_tombstoned");
  assert.equal(tombstone.history.at(-1).fromStatus, "planned");
  assert.equal(tombstone.history.at(-1).toStatus, "canceled");
  assert.equal(tombstone.history.at(-1).systemHidden, true);

  const normalized = lp.createPlannerItem(tombstone);
  assert.equal(normalized.systemHidden, true);
  assert.equal(normalized.systemHiddenReason, "assessment_schedule_removed");
  assert.equal(normalized.systemHiddenAt, "2026-08-02T00:00:00.000Z");
  assert.equal(normalized.systemHiddenBy, "schedule-manager");

  state = lp.addPlannerItem(state, {
    itemId: "ordinary-canceled-plan",
    studentCode: state.student.studentCode,
    date: "2026-08-07",
    title: "사용자 취소 계획",
    sourceType: "personal"
  });
  state = lp.cancelPlannerItem(state, "ordinary-canceled-plan", {
    reason: "개인 일정",
    canceledBy: "student-1",
    canceledAt: "2026-08-03T00:00:00.000Z"
  });
  const today = lp.getTodayPlan(state, "2026-08-07");
  const week = lp.getWeekPlan(state, "2026-08-07");
  assert.deepEqual(today.all.map((item) => item.itemId), ["ordinary-canceled-plan"]);
  assert.deepEqual(today.canceled.map((item) => item.itemId), ["ordinary-canceled-plan"]);
  assert.deepEqual(week.items.map((item) => item.itemId), ["ordinary-canceled-plan"]);
  assert.doesNotMatch(lp.renderTodayPlanner(state, "2026-08-07", true), /메타수학 주간평가/);
  assert.doesNotMatch(lp.renderWeekPlanner(state, "2026-08-07", true), /메타수학 주간평가/);
  assert.match(lp.renderTodayPlanner(state, "2026-08-07", true), /사용자 취소 계획/);
  assert.match(lp.renderWeekPlanner(state, "2026-08-07", true), /사용자 취소 계획/);
});

test("stale 계획은 tombstone을 되살리지 않고 동일 회차 재생성만 명시적으로 복구한다", () => {
  const fixture = createAssessmentTombstoneFixture();
  const tombstoneRevision = fixture.state.plannerItems[0].revision;
  const staleSnapshot = Object.assign({}, fixture.beforePlanner, {
    status: "planned",
    systemHidden: false,
    evidenceRefs: fixture.beforePlanner.evidenceRefs.concat("snapshot:stale")
  });
  const beforeStaleMerge = JSON.parse(JSON.stringify(fixture.state));
  let state = lp.addPlannerItem(fixture.state, staleSnapshot);
  let planner = state.plannerItems[0];
  assert.deepEqual(state, beforeStaleMerge);
  assert.equal(planner.status, "canceled");
  assert.equal(planner.systemHidden, true);
  assert.equal(planner.systemHiddenReason, "assessment_schedule_removed");
  assert.equal(planner.revision, tombstoneRevision);
  assert.deepEqual(planner.evidenceRefs, ["schedule:seed"]);
  assert.equal(planner.history.at(-1).action, "assessment_schedule_tombstoned");

  const beforeReactivation = JSON.parse(JSON.stringify(planner));
  state = lp.addAssessmentSchedule(state, fixture.schedule, Object.assign({}, fixture.window, {
    at: "2026-08-04T00:00:00.000Z",
    actor: "schedule-manager"
  }));
  planner = state.plannerItems.find((item) => item.itemId === fixture.beforePlanner.itemId);
  assert.equal(state.assessmentOccurrences.length, 1);
  assert.equal(state.plannerItems.filter((item) => item.itemId === planner.itemId).length, 1);
  assert.equal(planner.status, "planned");
  assert.equal(planner.systemHidden, false);
  assert.equal(planner.systemHiddenReason, "assessment_schedule_removed");
  assert.equal(planner.systemReactivatedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(planner.systemReactivatedBy, "schedule-manager");
  assert.equal(planner.revision, beforeReactivation.revision + 1);
  assert.deepEqual(planner.evidenceRefs, ["schedule:seed"]);
  assert.deepEqual(planner.verificationEvidenceRefs, ["teacher:prior-note"]);
  assert.equal(planner.history.some((entry) => entry.action === "assessment_schedule_tombstoned"), true);
  assert.equal(planner.history.at(-1).action, "assessment_schedule_reactivated");
  assert.equal(planner.history.at(-1).fromStatus, "canceled");
  assert.equal(planner.history.at(-1).toStatus, "planned");
  assert.equal(lp.getTodayPlan(state, "2026-08-07").all.some((item) => item.itemId === planner.itemId), true);
  assert.match(lp.renderTodayPlanner(state, "2026-08-07", true), /메타수학 주간평가/);
  assert.match(lp.renderWeekPlanner(state, "2026-08-07", true), /메타수학 주간평가/);
});

test("평가 재생성은 시스템 tombstone만 복구하고 사용자 취소 lifecycle은 유지한다", () => {
  let state = assessmentApprovalState("Asia/Seoul");
  const planner = state.plannerItems[0];
  state.plannerItems[0] = Object.assign({}, planner, {
    status: "canceled",
    systemHidden: false,
    cancelReason: "보호자 요청",
    canceledAt: "2026-08-03T00:00:00.000Z",
    canceledBy: "teacher-1",
    revision: planner.revision + 1,
    history: planner.history.concat({
      action: "canceled",
      fromStatus: "planned",
      toStatus: "canceled",
      at: "2026-08-03T00:00:00.000Z",
      actor: "teacher-1"
    })
  });
  const before = JSON.parse(JSON.stringify(state.plannerItems[0]));
  state = lp.addAssessmentSchedule(state, lp.createMetaMathSchedule({
    studentCode: state.student.studentCode,
    anchorDate: "2026-08-07",
    kind: "weekly",
    weekday: 5
  }), {
    fromDate: "2026-08-07",
    toDate: "2026-08-07",
    at: "2026-08-05T00:00:00.000Z",
    actor: "schedule-manager"
  });
  assert.deepEqual(state.plannerItems[0], before);
  assert.equal(lp.getTodayPlan(state, "2026-08-07").canceled[0].cancelReason, "보호자 요청");
  assert.match(lp.renderTodayPlanner(state, "2026-08-07", true), /취소 사유: 보호자 요청/);
});


test("플래너 편집·취소는 미완료 허용상태에서만 가능하다", () => {
  ["planned", "in_progress", "check_needed"].forEach((status, index) => {
    let state = lp.addPlannerItem(elementaryState(), {
      itemId: "allowed-plan-" + status,
      studentCode: "E-3",
      date: "2026-08-03",
      title: "허용 계획 " + status,
      sourceType: "academy",
      status
    });
    assert.doesNotThrow(() => lp.editPlannerItem(state, state.plannerItems[0].itemId, {
      title: "수정 허용 " + index
    }, { actor: "teacher-1", at: "2026-08-03T01:00:00.000Z" }));
    assert.doesNotThrow(() => lp.cancelPlannerItem(state, state.plannerItems[0].itemId, {
      reason: "미완료 일정 취소",
      canceledBy: "teacher-1",
      canceledAt: "2026-08-03T02:00:00.000Z"
    }));
  });

  ["verification_waiting", "completed", "carryover_candidate", "carried_over", "paused", "canceled"].forEach((status) => {
    const state = lp.addPlannerItem(elementaryState(), {
      itemId: "blocked-plan-" + status,
      studentCode: "E-3",
      date: "2026-08-03",
      title: "차단 계획 " + status,
      sourceType: "academy",
      status
    });
    const before = JSON.parse(JSON.stringify(state));
    assert.throws(() => lp.editPlannerItem(state, state.plannerItems[0].itemId, {
      title: "모순 편집"
    }, { actor: "teacher-1", at: "2026-08-03T01:00:00.000Z" }), /cannot be edited from/);
    assert.throws(() => lp.cancelPlannerItem(state, state.plannerItems[0].itemId, {
      reason: "모순 취소",
      canceledBy: "teacher-1",
      canceledAt: "2026-08-03T02:00:00.000Z"
    }), /cannot be canceled from/);
    assert.deepEqual(state, before);
  });
});

test("캠페인 전이는 미래시각·시험일·초등 동의·활성 차단 사유를 모두 검증한다", () => {
  const originalNow = Date.now;
  try {
    let state = elementaryState();
    state = lp.addPrepCampaign(state, {
      campaignType: "contest",
      title: "시간 경계 경시대회",
      examDate: "2026-08-10",
      consentStatus: "approved",
      status: "active"
    });
    const campaignId = state.prepCampaigns[0].campaignId;

    Date.now = () => Date.parse("2026-08-01T00:00:00.000Z");
    assert.throws(() => lp.transitionPrepCampaign(state, campaignId, "exam_ready", {
      actor: "teacher-1",
      at: "2026-08-01T00:05:00.001Z",
      evidenceRef: "checklist:future"
    }), /more than 5 minutes in the future/);
    state = lp.transitionPrepCampaign(state, campaignId, "exam_ready", {
      actor: "teacher-1",
      at: "2026-08-01T00:05:00.000Z",
      evidenceRef: "checklist:boundary"
    });

    Date.now = () => Date.parse("2026-08-09T14:59:59.999Z");
    assert.throws(() => lp.transitionPrepCampaign(state, campaignId, "taken", {
      actor: "teacher-1",
      at: "2026-08-09T14:59:59.999Z",
      evidenceRef: "attendance:too-early"
    }), /before examDate in student timezone/);
    Date.now = () => Date.parse("2026-08-09T15:00:00.000Z");
    state = lp.transitionPrepCampaign(state, campaignId, "taken", {
      actor: "teacher-1",
      at: "2026-08-09T15:00:00.000Z",
      evidenceRef: "attendance:on-date"
    });
    assert.equal(state.prepCampaigns[0].status, "taken");

    const consentBlocked = JSON.parse(JSON.stringify(state));
    consentBlocked.prepCampaigns[0].status = "active";
    consentBlocked.prepCampaigns[0].consentStatus = "pending";
    assert.throws(() => lp.transitionPrepCampaign(consentBlocked, campaignId, "exam_ready", {
      actor: "teacher-1",
      at: "2026-08-09T15:00:00.000Z",
      evidenceRef: "checklist:no-consent"
    }), /requires approved consent/);

    const reasonBlocked = JSON.parse(JSON.stringify(state));
    reasonBlocked.prepCampaigns[0].status = "active";
    reasonBlocked.prepCampaigns[0].activationBlockedReason = "PROFILE_TRANSITION_REVIEW";
    assert.throws(() => lp.transitionPrepCampaign(reasonBlocked, campaignId, "exam_ready", {
      actor: "teacher-1",
      at: "2026-08-09T15:00:00.000Z",
      evidenceRef: "checklist:blocked"
    }), /transition is blocked/);
  } finally {
    Date.now = originalNow;
  }
});

test("평가·캠페인 장기 이력은 상한과 누적 retention을 보존한다", () => {
  const state = elementaryState();
  const history = Array.from({ length: 80 }, (_, index) => ({
    event: "status_transition",
    fromStatus: "active",
    toStatus: "exam_ready",
    actor: "teacher-1",
    at: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString()
  }));
  const resultHistory = Array.from({ length: 40 }, (_, index) => ({
    resultId: "campaign-result-" + index,
    summary: "결과 " + index,
    reviewedAt: new Date(Date.UTC(2020, 1, 1, 0, 0, index)).toISOString()
  }));
  const campaign = lp.createPrepCampaign({
    campaignType: "contest",
    examDate: "2020-03-01",
    consentStatus: "approved",
    history,
    resultHistory,
    latestResult: resultHistory.at(-1)
  }, state.student, state.settings);
  assert.equal(campaign.history.length, 50);
  assert.equal(campaign.historyRetention.maxEntries, 50);
  assert.equal(campaign.historyRetention.droppedCount, 30);
  assert.equal(campaign.historyRetention.oldestRetainedAt, campaign.history[0].at);
  assert.equal(campaign.resultHistory.length, 20);
  assert.equal(campaign.resultHistoryRetention.maxEntries, 20);
  assert.equal(campaign.resultHistoryRetention.droppedCount, 20);
  assert.equal(campaign.resultHistoryRetention.oldestRetainedAt, campaign.resultHistory[0].reviewedAt);

  let assessmentState = assessmentApprovalState("Asia/Seoul");
  const occurrence = assessmentState.assessmentOccurrences[0];
  assessmentState.assessmentOccurrences[0].history = history;
  assessmentState.assessmentOccurrences[0].resultHistory = resultHistory.map((item, index) => ({
    resultId: "assessment-result-" + index,
    verifiedAt: item.reviewedAt
  }));
  assessmentState = approveAssessmentResultAtTestNow(assessmentState, occurrence.occurrenceId,
    assessmentApprovalInput({
      verifiedAt: "2026-08-07T02:00:00.000Z",
      evidenceRef: "teacher:bounded-history"
    }));
  const boundedOccurrence = assessmentState.assessmentOccurrences[0];
  assert.equal(boundedOccurrence.history.length, 50);
  assert.equal(boundedOccurrence.historyRetention.maxEntries, 50);
  assert.equal(boundedOccurrence.historyRetention.droppedCount, 31);
  assert.equal(boundedOccurrence.resultHistory.length, 20);
  assert.equal(boundedOccurrence.resultHistoryRetention.maxEntries, 20);
  assert.equal(boundedOccurrence.resultHistoryRetention.droppedCount, 21);
});

test("current-v2 program reload preserves explicit unknown count flags and retention", () => {
  const original = elementaryState();
  const snapshot = {
    snapshotId: "snapshot-reload-1",
    providerId: "classcard",
    studentCode: original.student.studentCode,
    checkDate: "2026-08-01",
    status: "active",
    data: { unit: "12" },
    approvedBy: "teacher-1",
    approvedAt: "2026-08-01T01:00:00.000Z"
  };
  original.programStates = [{
    programStateId: "program-reload-1",
    studentCode: original.student.studentCode,
    providerId: "classcard",
    accountIdRef: "reload-ref",
    status: "active",
    assignedCount: 0,
    completedCount: 0,
    assignedCountKnown: false,
    completedCountKnown: false,
    latestSnapshot: snapshot,
    history: [snapshot],
    historyRetention: {
      maxEntries: 20,
      maxBytes: 8192,
      droppedCount: 7,
      oldestRetainedAt: "2026-08-01",
      newestRetainedAt: "2026-08-01"
    },
    revision: 4
  }];
  const first = lp.migrateLearningPlatformState(original, {}).state.programStates[0];
  assert.equal(first.assignedCount, 0);
  assert.equal(first.completedCount, 0);
  assert.equal(first.assignedCountKnown, false);
  assert.equal(first.completedCountKnown, false);
  assert.equal(first.historyRetention.droppedCount, 7);
  assert.equal(first.latestSnapshot.studentCode, original.student.studentCode);
  const second = lp.migrateLearningPlatformState(Object.assign({}, original, { programStates: [first] }), {}).state.programStates[0];
  assert.equal(second.assignedCountKnown, false);
  assert.equal(second.completedCountKnown, false);
  assert.equal(second.historyRetention.droppedCount, 7);
  assert.equal(second.history.length, 1);

  const positive = lp.upsertStudentProgramState(elementaryState(), {
    providerId: "classcard",
    status: "active",
    assignedCount: 5,
    completedCount: 2,
    assignedCountKnown: false,
    completedCountKnown: false
  });
  assert.equal(positive.programStates[0].assignedCount, 5);
  assert.equal(positive.programStates[0].completedCount, 2);
  assert.equal(positive.programStates[0].assignedCountKnown, true);
  assert.equal(positive.programStates[0].completedCountKnown, true);
});
